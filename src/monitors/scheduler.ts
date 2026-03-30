/**
 * Task scheduler for periodic monitoring.
 *
 * Runs registered tasks at configurable intervals using setInterval.
 * Each task runs independently — one failure doesn't affect others.
 * Uses .unref() so timers don't prevent graceful process exit.
 */

// ── Types ───────────────────────────────────────────────────────

export interface ScheduledTask {
  /** Human-readable name for logging */
  name: string;
  /** Interval between executions in milliseconds */
  intervalMs: number;
  /** The async function to execute */
  execute: () => Promise<void>;
}

// ── Scheduler ───────────────────────────────────────────────────

export class MonitorScheduler {
  private tasks: ScheduledTask[];
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(tasks: ScheduledTask[]) {
    this.tasks = tasks;
  }

  /**
   * Starts all scheduled tasks.
   * Each task runs immediately, then repeats at its configured interval.
   */
  start(): void {
    if (this.timers.size > 0) return; // Already running

    for (const task of this.tasks) {
      const intervalLabel =
        task.intervalMs >= 3_600_000
          ? `${(task.intervalMs / 3_600_000).toFixed(1)}h`
          : `${(task.intervalMs / 60_000).toFixed(0)}m`;

      console.log(`  [monitor] Scheduling "${task.name}" every ${intervalLabel}`);

      // Run immediately, then on interval
      this.runTask(task);
      const timer = setInterval(() => this.runTask(task), task.intervalMs);
      timer.unref();
      this.timers.set(task.name, timer);
    }
  }

  /**
   * Stops all scheduled tasks.
   */
  stop(): void {
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    console.log('  [monitor] All monitors stopped');
  }

  // ── Internal ────────────────────────────────────────────────

  private async runTask(task: ScheduledTask): Promise<void> {
    try {
      await task.execute();
    } catch (err) {
      // Don't crash on individual task failure
      console.error(`  [monitor] Task "${task.name}" failed:`, err);
    }
  }
}
