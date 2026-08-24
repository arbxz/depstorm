import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearPending,
  pendingCount,
  registerCleanup,
  runPendingCleanups,
  unregisterCleanup,
} from "../src/cleanup.js";
import { silenceLogs } from "./helpers/repo.js";

silenceLogs();

beforeEach(clearPending);

function entry(
  label: string,
  run: () => Promise<void> = async () => {},
) {
  return { describe: () => label, run };
}

describe("cleanup registry", () => {
  it("runs every registered cleanup", async () => {
    const ran: string[] = [];
    registerCleanup(entry("a", async () => void ran.push("a")));
    registerCleanup(entry("b", async () => void ran.push("b")));

    const unfinished = await runPendingCleanups();

    assert.deepEqual(ran, ["a", "b"]);
    assert.deepEqual(unfinished, []);
    assert.equal(pendingCount(), 0);
  });

  it("does not run a cleanup that was unregistered", async () => {
    const ran: string[] = [];
    const keep = registerCleanup(entry("keep", async () => void ran.push("keep")));
    const drop = registerCleanup(entry("drop", async () => void ran.push("drop")));

    unregisterCleanup(drop);
    await runPendingCleanups();

    assert.deepEqual(ran, ["keep"]);
    assert.ok(keep);
  });

  it("keeps going when one cleanup throws, and reports the one that failed", async () => {
    const ran: string[] = [];
    registerCleanup(
      entry("broken", () => Promise.reject(new Error("boom"))),
    );
    registerCleanup(entry("fine", async () => void ran.push("fine")));

    const unfinished = await runPendingCleanups();

    assert.deepEqual(
      ran,
      ["fine"],
      "one project failing to unwind must not strand the rest",
    );
    assert.deepEqual(unfinished, ["broken"]);
  });

  it("gives up on a hung cleanup instead of blocking the exit", async () => {
    registerCleanup(entry("hung", () => new Promise<void>(() => {})));

    const unfinished = await runPendingCleanups(50);

    assert.deepEqual(
      unfinished,
      ["hung"],
      "an interrupt that never exits is worse than an incomplete restore",
    );
  });

  it("reports remaining work after a timeout, not the work already done", async () => {
    const ran: string[] = [];
    registerCleanup(entry("quick", async () => void ran.push("quick")));
    registerCleanup(entry("hung", () => new Promise<void>(() => {})));

    const unfinished = await runPendingCleanups(50);

    assert.deepEqual(ran, ["quick"]);
    assert.deepEqual(unfinished, ["hung"]);
  });

  it("is a no-op when nothing is pending", async () => {
    assert.deepEqual(await runPendingCleanups(), []);
  });

  it("clears the registry so a second call cannot double-unwind", async () => {
    let calls = 0;
    registerCleanup(entry("once", async () => void calls++));

    await runPendingCleanups();
    await runPendingCleanups();

    assert.equal(calls, 1);
  });
});
