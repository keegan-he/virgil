/**
 * SQLite-backed conversation storage for Virgil.
 *
 * Stores sessions and conversation turns, providing the persistence
 * layer for the session manager and context compaction.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ChannelType,
  ConversationTurn,
  RouteTarget,
  Session,
} from '../channels/types.js';

// ── Schema ──────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    channel       TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    thread_id     TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
    turn_count    INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON sessions(channel, user_id);

  CREATE INDEX IF NOT EXISTS idx_sessions_thread
    ON sessions(channel, user_id, thread_id);

  CREATE TABLE IF NOT EXISTS turns (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT NOT NULL REFERENCES sessions(id),
    turn_index        INTEGER NOT NULL,
    user_message      TEXT NOT NULL,
    assistant_message TEXT NOT NULL,
    backend           TEXT NOT NULL,
    timestamp         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_turns_session
    ON turns(session_id, turn_index);

  CREATE TABLE IF NOT EXISTS health_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    service    TEXT NOT NULL,
    status     TEXT NOT NULL,
    latency_ms INTEGER,
    error      TEXT,
    timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_health_timestamp
    ON health_logs(timestamp);

  CREATE TABLE IF NOT EXISTS artist_metrics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id       TEXT NOT NULL,
    platform        TEXT NOT NULL,
    followers       INTEGER,
    popularity      INTEGER,
    monthly_listeners INTEGER,
    checked_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_artist_metrics_artist
    ON artist_metrics(artist_id, platform, checked_at);

  CREATE TABLE IF NOT EXISTS dj_support (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    track_name      TEXT NOT NULL,
    dj_name         TEXT NOT NULL,
    tracklist_url   TEXT NOT NULL,
    tracklist_title TEXT,
    spotted_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_dj_support_track
    ON dj_support(track_name, dj_name);

  CREATE TABLE IF NOT EXISTS daily_briefings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    date_key  TEXT NOT NULL UNIQUE,
    content   TEXT NOT NULL,
    sent_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_briefings_date
    ON daily_briefings(date_key);

  CREATE TABLE IF NOT EXISTS monitored_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL UNIQUE,
    department  TEXT NOT NULL,
    location    TEXT NOT NULL,
    first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    notified    INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_monitored_jobs_url
    ON monitored_jobs(url);
`;

// ── Store class ─────────────────────────────────────────────────

export class MemoryStore {
  private db: Database.Database;

  /**
   * Opens (or creates) the SQLite database and initializes the schema.
   *
   * @param dbPath - Path to the SQLite database file
   */
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  // ── Sessions ────────────────────────────────────────────────

  /**
   * Creates a new session and returns it.
   */
  createSession(
    id: string,
    channel: ChannelType,
    userId: string,
    threadId?: string,
  ): Session {
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO sessions (id, channel, user_id, thread_id, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, channel, userId, threadId ?? null, now.toISOString(), now.toISOString());

    return {
      id,
      channel,
      userId,
      threadId,
      createdAt: now,
      lastActiveAt: now,
      turnCount: 0,
    };
  }

  /**
   * Finds an existing session by channel + user + optional thread.
   * Returns the most recently active match, or undefined.
   */
  findSession(
    channel: ChannelType,
    userId: string,
    threadId?: string,
  ): Session | undefined {
    const row = threadId
      ? this.db
          .prepare(
            `SELECT * FROM sessions
             WHERE channel = ? AND user_id = ? AND thread_id = ?
             ORDER BY last_active_at DESC LIMIT 1`,
          )
          .get(channel, userId, threadId)
      : this.db
          .prepare(
            `SELECT * FROM sessions
             WHERE channel = ? AND user_id = ? AND thread_id IS NULL
             ORDER BY last_active_at DESC LIMIT 1`,
          )
          .get(channel, userId);

    return row ? this.rowToSession(row as SessionRow) : undefined;
  }

  /**
   * Gets a session by its ID.
   */
  getSession(id: string): Session | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row ? this.rowToSession(row) : undefined;
  }

  /**
   * Touches the session's last_active_at timestamp.
   */
  touchSession(id: string): void {
    this.db
      .prepare('UPDATE sessions SET last_active_at = datetime(\'now\') WHERE id = ?')
      .run(id);
  }

  // ── Turns ───────────────────────────────────────────────────

  /**
   * Appends a conversation turn to a session.
   */
  addTurn(
    sessionId: string,
    userMessage: string,
    assistantMessage: string,
    backend: RouteTarget,
  ): void {
    const tx = this.db.transaction(() => {
      const session = this.db
        .prepare('SELECT turn_count FROM sessions WHERE id = ?')
        .get(sessionId) as { turn_count: number } | undefined;

      if (!session) throw new Error(`Session not found: ${sessionId}`);

      const turnIndex = session.turn_count;

      this.db
        .prepare(
          `INSERT INTO turns (session_id, turn_index, user_message, assistant_message, backend)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sessionId, turnIndex, userMessage, assistantMessage, backend);

      this.db
        .prepare(
          `UPDATE sessions
           SET turn_count = turn_count + 1,
               last_active_at = datetime('now')
           WHERE id = ?`,
        )
        .run(sessionId);
    });

    tx();
  }

  /**
   * Retrieves the most recent N turns for a session.
   */
  getRecentTurns(sessionId: string, limit: number): ConversationTurn[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turns
         WHERE session_id = ?
         ORDER BY turn_index DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as TurnRow[];

    return rows.reverse().map(this.rowToTurn);
  }

  /**
   * Returns all turns for a session.
   */
  getAllTurns(sessionId: string): ConversationTurn[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turns
         WHERE session_id = ?
         ORDER BY turn_index ASC`,
      )
      .all(sessionId) as TurnRow[];

    return rows.map(this.rowToTurn);
  }

  /**
   * Deletes old turns beyond a threshold, keeping only the most recent ones.
   * Used after compaction replaces old turns with a summary.
   */
  pruneTurns(sessionId: string, keepRecent: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM turns
         WHERE session_id = ? AND turn_index < (
           SELECT MAX(turn_index) - ? FROM turns WHERE session_id = ?
         )`,
      )
      .run(sessionId, keepRecent - 1, sessionId);

    return result.changes;
  }

  // ── Health logs ─────────────────────────────────────────────

  /**
   * Records a health check result.
   */
  logHealth(
    service: string,
    status: 'ok' | 'error',
    latencyMs?: number,
    error?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO health_logs (service, status, latency_ms, error)
         VALUES (?, ?, ?, ?)`,
      )
      .run(service, status, latencyMs ?? null, error ?? null);
  }

  /**
   * Gets the most recent health status for a service.
   */
  getLatestHealth(service: string): {
    status: string;
    latencyMs: number | null;
    error: string | null;
    timestamp: Date;
  } | undefined {
    const row = this.db
      .prepare(
        `SELECT status, latency_ms, error, timestamp
         FROM health_logs
         WHERE service = ?
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(service) as {
      status: string;
      latency_ms: number | null;
      error: string | null;
      timestamp: string;
    } | undefined;

    if (!row) return undefined;
    return {
      status: row.status,
      latencyMs: row.latency_ms,
      error: row.error,
      timestamp: new Date(row.timestamp),
    };
  }

  // ── Artist Metrics ─────────────────────────────────────────

  /**
   * Records an artist metrics snapshot.
   */
  logArtistMetrics(
    artistId: string,
    platform: string,
    followers: number,
    popularity: number,
    monthlyListeners?: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO artist_metrics (artist_id, platform, followers, popularity, monthly_listeners)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(artistId, platform, followers, popularity, monthlyListeners ?? null);
  }

  /**
   * Gets the most recent metrics snapshot for an artist.
   */
  getLatestArtistMetrics(
    artistId: string,
    platform: string,
  ): ArtistMetricsRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM artist_metrics
         WHERE artist_id = ? AND platform = ?
         ORDER BY checked_at DESC
         LIMIT 1`,
      )
      .get(artistId, platform) as ArtistMetricsRow | undefined;
  }

  /**
   * Gets metrics history for trending/charting.
   */
  getArtistMetricsHistory(
    artistId: string,
    platform: string,
    limit: number,
  ): ArtistMetricsRow[] {
    return this.db
      .prepare(
        `SELECT * FROM artist_metrics
         WHERE artist_id = ? AND platform = ?
         ORDER BY checked_at DESC
         LIMIT ?`,
      )
      .all(artistId, platform, limit) as ArtistMetricsRow[];
  }

  // ── DJ Support ────────────────────────────────────────────

  /**
   * Records a DJ support entry.
   */
  logDJSupport(
    trackName: string,
    djName: string,
    tracklistUrl: string,
    tracklistTitle?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO dj_support (track_name, dj_name, tracklist_url, tracklist_title)
         VALUES (?, ?, ?, ?)`,
      )
      .run(trackName, djName, tracklistUrl, tracklistTitle ?? null);
  }

  /**
   * Checks if a specific DJ support entry already exists (dedup).
   */
  isDJSupportKnown(
    trackName: string,
    djName: string,
    tracklistUrl: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM dj_support
         WHERE track_name = ? AND dj_name = ? AND tracklist_url = ?
         LIMIT 1`,
      )
      .get(trackName, djName, tracklistUrl);
    return !!row;
  }

  // ── Daily Briefings ──────────────────────────────────────────

  /**
   * Checks if a briefing has already been sent for a given date.
   */
  isBriefingSent(dateKey: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM daily_briefings WHERE date_key = ? LIMIT 1')
      .get(dateKey);
    return !!row;
  }

  /**
   * Records a sent briefing.
   */
  logBriefing(dateKey: string, content: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO daily_briefings (date_key, content)
         VALUES (?, ?)`,
      )
      .run(dateKey, content);
  }

  /**
   * Gets the most recent briefing.
   */
  getLastBriefing(): { dateKey: string; content: string; sentAt: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT date_key, content, sent_at FROM daily_briefings
         ORDER BY sent_at DESC LIMIT 1`,
      )
      .get() as { date_key: string; content: string; sent_at: string } | undefined;

    if (!row) return undefined;
    return {
      dateKey: row.date_key,
      content: row.content,
      sentAt: row.sent_at,
    };
  }

  // ── Monitored Jobs ─────────────────────────────────────────

  /**
   * Returns all known monitored job URLs (for deduplication).
   */
  getKnownJobs(): JobRow[] {
    return this.db
      .prepare('SELECT * FROM monitored_jobs ORDER BY first_seen DESC')
      .all() as JobRow[];
  }

  /**
   * Adds a new job listing. Ignores duplicates by URL.
   */
  addJob(job: {
    title: string;
    url: string;
    department: string;
    location: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO monitored_jobs (title, url, department, location)
         VALUES (?, ?, ?, ?)`,
      )
      .run(job.title, job.url, job.department, job.location);
  }

  /**
   * Marks a job as having been notified about.
   */
  markJobNotified(id: number): void {
    this.db
      .prepare('UPDATE monitored_jobs SET notified = 1 WHERE id = ?')
      .run(id);
  }

  /**
   * Gets recent DJ support entries.
   */
  getRecentDJSupport(limit: number): DJSupportRow[] {
    return this.db
      .prepare(
        `SELECT * FROM dj_support
         ORDER BY spotted_at DESC
         LIMIT ?`,
      )
      .all(limit) as DJSupportRow[];
  }

  /**
   * Closes the database connection.
   */
  close(): void {
    this.db.close();
  }

  // ── Row mappers ─────────────────────────────────────────────

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      channel: row.channel as ChannelType,
      userId: row.user_id,
      threadId: row.thread_id ?? undefined,
      createdAt: new Date(row.created_at),
      lastActiveAt: new Date(row.last_active_at),
      turnCount: row.turn_count,
    };
  }

  private rowToTurn(row: TurnRow): ConversationTurn {
    return {
      turnIndex: row.turn_index,
      userMessage: row.user_message,
      assistantMessage: row.assistant_message,
      backend: row.backend as RouteTarget,
      timestamp: new Date(row.timestamp),
    };
  }
}

// ── Internal row types ──────────────────────────────────────────

interface SessionRow {
  id: string;
  channel: string;
  user_id: string;
  thread_id: string | null;
  created_at: string;
  last_active_at: string;
  turn_count: number;
}

interface TurnRow {
  id: number;
  session_id: string;
  turn_index: number;
  user_message: string;
  assistant_message: string;
  backend: string;
  timestamp: string;
}

export interface ArtistMetricsRow {
  id: number;
  artist_id: string;
  platform: string;
  followers: number;
  popularity: number;
  monthly_listeners: number | null;
  checked_at: string;
}

export interface DJSupportRow {
  id: number;
  track_name: string;
  dj_name: string;
  tracklist_url: string;
  tracklist_title: string | null;
  spotted_at: string;
}

export interface JobRow {
  id: number;
  title: string;
  url: string;
  department: string;
  location: string;
  first_seen: string;
  notified: number;
}
