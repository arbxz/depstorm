import cron, { type ScheduledTask } from "node-cron";
import consola from "consola";

export interface ScheduleOptions {
  /** IANA timezone the expression is interpreted in, e.g. "Europe/Paris" */
  timezone?: string;
  /** Run once immediately rather than waiting for the first tick */
  runImmediately?: boolean;
}

/**
 * Schedule a task to run on a cron expression.
 *
 * Overlapping runs are prevented. node-cron fires on schedule regardless of
 * whether the previous run finished, and a depstorm run holds a stash and a
 * branch while it works — two of them against the same repositories at once
 * is the one thing this tool must never do.
 */
export function scheduleTask(
  expression: string,
  task: () => Promise<void>,
  options: ScheduleOptions = {},
): ScheduledTask {
  if (!cron.validate(expression)) {
    consola.error(`Invalid cron expression: ${expression}`);
    throw new Error(`Invalid cron expression: ${expression}`);
  }

  consola.info(`Scheduling audit runs with: ${expression}`);
  consola.info(`Cadence: ${describeSchedule(expression)}`);
  if (options.timezone) consola.info(`Timezone: ${options.timezone}`);

  let running = false;
  let skipped = 0;

  const guarded = async () => {
    if (running) {
      skipped++;
      consola.warn(
        `Previous run is still going — skipping this tick (${skipped} skipped so far). Consider a longer interval.`,
      );
      return;
    }

    running = true;
    consola.start("Scheduled audit run starting...");
    try {
      await task();
    } catch (err) {
      consola.error(
        `Scheduled run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
  };

  const scheduled = cron.schedule(expression, guarded, {
    ...(options.timezone ? { timezone: options.timezone } : {}),
  });

  // Waiting until the first tick to do anything makes a misconfigured
  // schedule indistinguishable from a working one for up to a week.
  if (options.runImmediately) void guarded();

  return scheduled;
}

/**
 * Describe how often an expression fires.
 *
 * Deliberately not labelled "next run": this is a cadence, and printing a
 * cadence under that label told users a time it never computed.
 */
export function describeSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;

  const [min, hour, dayOfMonth, month, dayOfWeek] = parts;
  const at = `${hour}:${(min ?? "0").padStart(2, "0")}`;

  if (dayOfWeek !== "*" && dayOfMonth === "*" && month === "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayName = days[Number(dayOfWeek)] ?? dayOfWeek;
    return `Every ${dayName} at ${at}`;
  }

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    if (hour?.startsWith("*/")) {
      return `Every ${hour.slice(2)} hours at minute ${min}`;
    }
    if (min?.startsWith("*/")) return `Every ${min.slice(2)} minutes`;
    if (hour === "*") return `Hourly at minute ${min}`;
    return `Daily at ${at}`;
  }

  return expr;
}
