import cron from "node-cron";
import consola from "consola";

/**
 * Schedule a task to run on a cron expression
 */
export function scheduleTask(
  expression: string,
  task: () => Promise<void>,
): cron.ScheduledTask {
  if (!cron.validate(expression)) {
    consola.error(`Invalid cron expression: ${expression}`);
    throw new Error(`Invalid cron expression: ${expression}`);
  }

  consola.info(`Scheduling audit runs with: ${expression}`);
  consola.info(`Next run: ${describeSchedule(expression)}`);

  const scheduled = cron.schedule(expression, async () => {
    consola.start("Scheduled audit run starting...");
    try {
      await task();
    } catch (err) {
      consola.error(`Scheduled run failed: ${err}`);
    }
  });

  return scheduled;
}

function describeSchedule(expr: string): string {
  const parts = expr.split(" ");
  if (parts.length < 5) return expr;

  const [min, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (dayOfWeek !== "*" && dayOfMonth === "*" && month === "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayName = days[Number(dayOfWeek)] ?? dayOfWeek;
    return `Every ${dayName} at ${hour}:${min.padStart(2, "0")}`;
  }

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Daily at ${hour}:${min.padStart(2, "0")}`;
  }

  return expr;
}
