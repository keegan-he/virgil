/**
 * Virgil — Personal AI Agent Framework
 *
 * Entry point. Loads configuration, initializes all components,
 * wires the gateway pipeline, starts the heartbeat monitor and
 * channel integrations, and provides an interactive console.
 */

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { v4 as uuid } from 'uuid';
import { loadFullConfig } from './gateway/config.js';
import { MemoryStore } from './memory/store.js';
import { OllamaClient } from './backends/ollama.js';
import { ClaudeClient } from './backends/claude.js';
import { Router } from './gateway/router.js';
import { SessionManager } from './gateway/session.js';
import { Gateway } from './gateway/gateway.js';
import { DiscordBot } from './channels/discord.js';
import { SkillRegistry } from './skills/registry.js';
import { fileRead, fileWrite, fileSearch, fileList } from './skills/file-ops.js';
import { webFetch } from './skills/web-search.js';
import { systemInfo, processList, shellExec, diskUsage } from './skills/system.js';
import { HeartbeatMonitor } from './heartbeat/monitor.js';
import { ContextCompactor } from './memory/compaction.js';
import { SpotifyClient } from './monitors/spotify.js';
import { TracklistsScraper } from './monitors/tracklists.js';
import { JobsScraper } from './monitors/jobs-monitor.js';
import { MonitorScheduler, type ScheduledTask } from './monitors/scheduler.js';
import { DiscordNotifier } from './monitors/notifier.js';
import { DailyBriefing, BRIEFING_CHECK_INTERVAL_MS } from './monitors/briefing.js';
import type { InboundMessage } from './channels/types.js';

// ── PID lockfile (prevents multiple instances) ──────────────────

const LOCK_FILE = resolve(import.meta.dirname ?? '.', '..', 'data', 'virgil.pid');

function acquireLock(): void {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });

  if (existsSync(LOCK_FILE)) {
    const oldPid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    if (oldPid && isProcessAlive(oldPid)) {
      console.error(
        `Another Virgil instance is already running (PID ${oldPid}).\n` +
          `Kill it first: kill ${oldPid}`,
      );
      process.exit(1);
    }
    // Stale lockfile — old process is dead, clean it up
    unlinkSync(LOCK_FILE);
  }

  writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch {
    // Best-effort cleanup
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = just check if alive
    return true;
  } catch {
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  acquireLock();
  console.log('Starting Virgil...\n');

  // Load configuration
  const { config, soul } = loadFullConfig();
  console.log(`Agent: ${soul.name}`);

  // Initialize core components
  const store = new MemoryStore(config.memory.database);
  const ollama = new OllamaClient(config.ollama);
  const claude = new ClaudeClient(config.claude, soul);
  const router = new Router(ollama);
  const sessions = new SessionManager(store, config.memory);
  const compactor = new ContextCompactor(ollama, store, config.memory);

  // Register skills
  const skills = new SkillRegistry();
  skills.register(fileRead);
  skills.register(fileWrite);
  skills.register(fileSearch);
  skills.register(fileList);
  skills.register(webFetch);
  skills.register(systemInfo);
  skills.register(processList);
  skills.register(shellExec);
  skills.register(diskUsage);
  console.log(`Skills: ${skills.listNames().join(', ')}`);

  // Heartbeat monitor
  const heartbeat = new HeartbeatMonitor({
    ollama,
    claude,
    router,
    store,
    config: config.heartbeat,
  });

  // Wire the gateway
  const gateway = new Gateway({
    ollama,
    claude,
    router,
    sessions,
    soul,
    skills,
    compactor,
    heartbeat,
  });

  // Log gateway events
  gateway.on((event) => {
    switch (event.type) {
      case 'route_decided':
        console.log(
          `  [route] → ${event.decision.target} (${event.decision.confidence.toFixed(2)}) ${event.decision.reason}`,
        );
        break;
      case 'error':
        console.error(`  [error] ${event.error}`);
        break;
    }
  });

  // Initial health checks
  console.log('\n── Health checks ──');

  const ollamaHealth = await ollama.healthCheck();
  if (ollamaHealth.alive) {
    console.log(
      `Ollama: OK (${ollamaHealth.latencyMs}ms) model=${config.ollama.model} loaded=${ollamaHealth.modelLoaded}`,
    );
    store.logHealth('ollama', 'ok', ollamaHealth.latencyMs);
  } else {
    console.log(`Ollama: DOWN — ${ollamaHealth.error}`);
    router.setOllamaAvailable(false);
    store.logHealth('ollama', 'error', ollamaHealth.latencyMs, ollamaHealth.error);
  }

  const claudeHealth = await claude.healthCheck();
  if (claudeHealth.available) {
    console.log('Claude: OK');
    store.logHealth('claude', 'ok');
  } else {
    console.log(`Claude: UNAVAILABLE — ${claudeHealth.error}`);
    store.logHealth('claude', 'error', undefined, claudeHealth.error);
  }

  // Start heartbeat monitoring
  heartbeat.start();
  heartbeat.onChange((service, prev, curr) => {
    if (curr === 'down') {
      console.warn(`[ALERT] ${service} went down (was: ${prev})`);
    } else if (prev === 'down' && curr === 'ok') {
      console.log(`[RECOVERED] ${service} is back up`);
    }
  });

  // ── Channel integrations ────────────────────────────────────

  const cleanups: Array<() => Promise<void>> = [];
  let channelActive = false;
  let discord: DiscordBot | null = null;
  let dailyBriefing: DailyBriefing | null = null;

  // Discord
  if (config.channels.discord.enabled && config.channels.discord.token) {
    try {
      discord = new DiscordBot(gateway, config.channels.discord);
      await discord.start();
      cleanups.push(() => discord!.stop());
      channelActive = true;
    } catch (err) {
      console.error('Discord: failed to start —', err);
    }
  } else {
    console.log('Discord: disabled or no token');
  }

  // ── Monitors ──────────────────────────────────────────────

  if (config.monitors) {
    console.log('\n── Monitors ──');

    const notifier = discord
      ? new DiscordNotifier(
          discord.getClient(),
          config.monitors.notifications,
        )
      : null;

    // Auto-detect: when the first DM arrives, tell the notifier where to send
    if (discord && notifier) {
      discord.onFirstDM((channelId) => {
        notifier.setTargetChannel(channelId);
      });
    }

    const tasks: ScheduledTask[] = [];

    // Spotify artist monitoring
    if (
      config.monitors.spotify?.enabled &&
      config.monitors.spotify.artist_id
    ) {
      const spotify = new SpotifyClient(config.monitors.spotify);
      const artistId = config.monitors.spotify.artist_id;
      const monitorConfig = config.monitors;

      tasks.push({
        name: 'spotify-artist',
        intervalMs: config.monitors.spotify.interval_ms,
        execute: async () => {
          const artist = await spotify.getArtist(artistId);
          const previous = store.getLatestArtistMetrics(artistId, 'spotify');

          store.logArtistMetrics(
            artistId,
            'spotify',
            artist.followers.total,
            artist.popularity,
            artist.monthlyListeners ?? undefined,
          );

          const mlStr = artist.monthlyListeners
            ? `, ${artist.monthlyListeners.toLocaleString()} monthly listeners`
            : '';
          console.log(
            `  [monitor] Spotify: ${artist.name} — ${artist.followers.total.toLocaleString()} followers${mlStr}`,
          );

          // Check for milestones
          if (previous && notifier) {
            const followerStep =
              monitorConfig.notifications.follower_milestone_step;
            const prevMilestone = Math.floor(
              previous.followers / followerStep,
            );
            const currMilestone = Math.floor(
              artist.followers.total / followerStep,
            );
            if (currMilestone > prevMilestone) {
              await notifier.sendMilestone(
                `**${artist.name}** hit **${artist.followers.total.toLocaleString()}** followers on Spotify!`,
              );
            }

            const popStep =
              monitorConfig.notifications.popularity_milestone_step;
            const popDelta = artist.popularity - previous.popularity;
            if (Math.abs(popDelta) >= popStep) {
              const direction = popDelta > 0 ? '📈 up' : '📉 down';
              await notifier.sendMilestone(
                `**${artist.name}** popularity ${direction} to **${artist.popularity}** (was ${previous.popularity})`,
              );
            }
          }
        },
      });

      console.log('Spotify: monitoring enabled');
    } else {
      console.log('Spotify: disabled or no artist_id');
    }

    // 1001Tracklists DJ support monitoring
    if (config.monitors.tracklists?.enabled) {
      const scraper = new TracklistsScraper(config.monitors.tracklists);

      tasks.push({
        name: '1001tracklists',
        intervalMs: config.monitors.tracklists.interval_ms,
        execute: async () => {
          const supports = await scraper.fetchDJSupport();
          let newCount = 0;

          for (const support of supports) {
            if (
              !store.isDJSupportKnown(
                support.trackName,
                support.djName,
                support.tracklistUrl,
              )
            ) {
              store.logDJSupport(
                support.trackName,
                support.djName,
                support.tracklistUrl,
                support.tracklistTitle,
              );
              newCount++;

              if (notifier) {
                await notifier.sendDJAlert(
                  `**${support.djName}** played "${support.trackName}" in *${support.tracklistTitle}*`,
                );
              }
            }
          }

          console.log(
            `  [monitor] 1001Tracklists: found ${supports.length} entries, ${newCount} new`,
          );
        },
      });

      console.log('1001Tracklists: monitoring enabled');
    } else {
      console.log('1001Tracklists: disabled');
    }

    // Jobs monitoring
    if (config.monitors.jobs?.enabled) {
      const jobsConfig = config.monitors.jobs;
      const jobsScraper = new JobsScraper(jobsConfig);
      const intervalMs = jobsConfig.check_interval_minutes * 60_000;
      const monitorName = jobsConfig.name;

      tasks.push({
        name: 'jobs-monitor',
        intervalMs,
        execute: async () => {
          const matchedJobs = await jobsScraper.fetchMatchingJobs();
          const knownUrls = new Set(
            store.getKnownJobs().map((j) => j.url),
          );

          let newCount = 0;
          for (const job of matchedJobs) {
            if (!knownUrls.has(job.url)) {
              store.addJob(job);
              newCount++;

              if (notifier) {
                const locationStr =
                  job.location !== 'Unknown' ? ` (${job.location})` : '';
                const deptStr =
                  job.department !== 'Unknown'
                    ? ` [${job.department}]`
                    : '';
                await notifier.sendJobAlert(
                  `New role at ${monitorName}: **${job.title}**${deptStr}${locationStr}\n${job.url}`,
                );
                const added = store
                  .getKnownJobs()
                  .find((j) => j.url === job.url);
                if (added) {
                  store.markJobNotified(added.id);
                }
              }
            }
          }

          console.log(
            `  [monitor] ${monitorName} Jobs: found ${matchedJobs.length} matches, ${newCount} new`,
          );
        },
      });

      console.log(`Jobs monitor (${monitorName}): enabled`);
    } else {
      console.log('Jobs monitor: disabled');
    }

    // Daily briefing
    if (config.monitors.briefing?.enabled && notifier) {
      dailyBriefing = new DailyBriefing(
        config.monitors.briefing,
        store,
        notifier,
        config.monitors.spotify,
      );

      tasks.push({
        name: 'daily-briefing',
        intervalMs: BRIEFING_CHECK_INTERVAL_MS,
        execute: () => dailyBriefing!.checkAndSend(),
      });

      console.log(
        `Daily briefing: enabled (${config.monitors.briefing.hour}:00 ${config.monitors.briefing.timezone})`,
      );

      // Register !briefing Discord command
      if (discord) {
        discord.registerCommand('briefing', async (msg) => {
          try {
            const briefingMsg = await dailyBriefing!.sendNow();
            // sendNow already sends via notifier, but if they typed it
            // in a different channel, reply directly too
            if (briefingMsg.length <= 2000) {
              await msg.reply(briefingMsg);
            } else {
              await msg.reply('📋 Briefing sent! (Check your DMs — it was too long for a reply.)');
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await msg.reply(`Failed to generate briefing: ${errMsg}`);
          }
        });
        console.log('Discord: !briefing command registered');
      }
    } else {
      console.log('Daily briefing: disabled or no notifier');
    }

    // Start scheduler
    if (tasks.length > 0) {
      const scheduler = new MonitorScheduler(tasks);
      scheduler.start();
      cleanups.push(async () => scheduler.stop());
    }
  }

  // ── Console ─────────────────────────────────────────────────

  if (!channelActive) {
    console.log('\n── Console mode ──');
    console.log('No channels active. Type a message to chat. Ctrl+C to quit.\n');
  } else {
    console.log('\n── Running ──');
    console.log('Channels active. Console input also available. Ctrl+C to quit.\n');
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const content = line.trim();
    if (!content) {
      rl.prompt();
      return;
    }

    // Console-only commands
    if (content === '/status') {
      console.log(`\n${gateway.getHealthStatus()}\n`);
      rl.prompt();
      return;
    }

    if (content === '/skills') {
      console.log(`\n${skills.toPromptSummary()}\n`);
      rl.prompt();
      return;
    }

    if (content === '/briefing') {
      if (dailyBriefing) {
        console.log('\nSending daily briefing now...');
        try {
          const msg = await dailyBriefing.sendNow();
          console.log(`\n${msg}\n`);
        } catch (err) {
          console.error('Briefing failed:', err);
        }
      } else {
        console.log('\nDaily briefing is not configured.\n');
      }
      rl.prompt();
      return;
    }

    const message: InboundMessage = {
      id: uuid(),
      channel: 'console',
      channelMessageId: uuid(),
      userId: 'console-user',
      userName: 'User',
      content,
      timestamp: new Date(),
    };

    const response = await gateway.process(message);
    console.log(`\nvirgil> ${response.content}\n`);
    rl.prompt();
  });

  // Clean shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // Prevent double-shutdown
    shuttingDown = true;
    console.log('\nShutting down...');
    rl.close();
    heartbeat.stop();
    claude.killAll(); // Kill any active Claude subprocesses
    for (const cleanup of cleanups) {
      await cleanup().catch(() => {});
    }
    store.close();
    releaseLock();
    process.exit(0);
  };

  rl.on('close', () => {
    // Only shutdown on readline close if no channels (like Discord) are active.
    // When running headless, stdin closes immediately — we don't want that to kill the bot.
    if (!channelActive) shutdown();
  });
  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  releaseLock();
  process.exit(1);
});
