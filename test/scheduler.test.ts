import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeSchedule, scheduleTask } from "../src/scheduler.js";
import { silenceLogs } from "./helpers/repo.js";

silenceLogs();

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("describeSchedule", () => {
  it("names a weekly schedule", () => {
    assert.equal(describeSchedule("0 9 * * 1"), "Every Mon at 9:00");
  });

  it("names a daily schedule", () => {
    assert.equal(describeSchedule("30 9 * * *"), "Daily at 9:30");
  });

  it("names an every-N-hours schedule instead of calling it daily", () => {
    assert.equal(
      describeSchedule("0 */6 * * *"),
      "Every 6 hours at minute 0",
      "the old version reported this as 'Daily at */6:00'",
    );
  });

  it("names an every-N-minutes schedule", () => {
    assert.equal(describeSchedule("*/15 * * * *"), "Every 15 minutes");
  });

  it("falls back to the raw expression it cannot describe", () => {
    assert.equal(describeSchedule("0 0 1 1 *"), "0 0 1 1 *");
    assert.equal(describeSchedule("nonsense"), "nonsense");
  });
});

describe("scheduleTask", () => {
  it("rejects an invalid expression instead of scheduling nothing", () => {
    assert.throws(
      () => scheduleTask("not a cron", async () => {}),
      /Invalid cron expression/,
    );
  });

  it("can run once immediately rather than waiting for the first tick", async () => {
    let runs = 0;
    const task = scheduleTask("0 9 * * 1", async () => void runs++, {
      runImmediately: true,
    });

    await tick();
    task.stop();

    assert.equal(runs, 1);
  });

  it("does not start a second run while the first is still going", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const task = scheduleTask(
      "0 9 * * 1",
      async () => {
        started++;
        await blocked;
      },
      { runImmediately: true },
    );

    await tick();
    assert.equal(started, 1);

    // A second tick arriving while the first run holds a stash and a branch
    await task.execute();
    await tick();

    assert.equal(
      started,
      1,
      "two runs against the same repositories at once is the one thing this must not do",
    );

    release?.();
    await tick();
    task.stop();
  });

  it("accepts the next run once the previous one has finished", async () => {
    let runs = 0;
    const task = scheduleTask("0 9 * * 1", async () => void runs++, {
      runImmediately: true,
    });

    await tick();
    await task.execute();
    await tick();
    task.stop();

    assert.equal(runs, 2);
  });

  it("survives a task that throws", async () => {
    let runs = 0;
    const task = scheduleTask(
      "0 9 * * 1",
      async () => {
        runs++;
        throw new Error("boom");
      },
      { runImmediately: true },
    );

    await tick();
    await task.execute();
    await tick();
    task.stop();

    assert.equal(runs, 2, "one failed run must not stop the schedule");
  });
});
