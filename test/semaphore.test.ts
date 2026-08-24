import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapWithLimit, Semaphore } from "../src/semaphore.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("mapWithLimit", () => {
  it("preserves result order regardless of completion order", async () => {
    const results = await mapWithLimit([30, 10, 20], 3, async (ms) => {
      await delay(ms);
      return ms;
    });

    assert.deepEqual(results, [30, 10, 20]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight--;
    });

    assert.equal(peak, 2);
  });

  it("runs strictly in order at a limit of one", async () => {
    const order: number[] = [];

    await mapWithLimit([1, 2, 3], 1, async (n) => {
      order.push(n);
      await delay(5);
    });

    assert.deepEqual(order, [1, 2, 3]);
  });

  it("handles an empty list", async () => {
    assert.deepEqual(await mapWithLimit([], 4, async () => 1), []);
  });
});

describe("Semaphore", () => {
  it("releases a slot even when the task throws", async () => {
    const semaphore = new Semaphore(1);

    await assert.rejects(
      semaphore.run(() => Promise.reject(new Error("boom"))),
      /boom/,
    );

    assert.equal(
      await semaphore.run(async () => "still works"),
      "still works",
      "a slot leaked on failure would deadlock every later caller",
    );
  });
});
