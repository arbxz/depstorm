import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  overrideIsContained,
  parseRelease,
  pickSettledVersion,
  sameLine,
  settleOnOlderReleases,
} from "../src/settle.js";
import { DEFAULT_CONFIG, type ProjectInfo } from "../src/types.js";
import { silenceLogs } from "./helpers/repo.js";

silenceLogs();

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T18:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("parseRelease", () => {
  it("reads a plain release", () => {
    assert.deepEqual(parseRelease("8.5.31"), [8, 5, 31]);
  });

  it("rejects prereleases, which are never a settled fallback", () => {
    assert.equal(parseRelease("4.0.0-beta.7"), null);
  });
});

describe("sameLine", () => {
  it("compares majors from 1.0 up", () => {
    assert.equal(sameLine("8.5.31", "8.5.32"), true);
    assert.equal(sameLine("7.9.0", "8.0.0"), false);
  });

  it("compares minors below 1.0, where breaking changes go", () => {
    assert.equal(sameLine("0.5.3", "0.5.9"), true);
    assert.equal(sameLine("0.4.9", "0.5.0"), false);
  });
});

describe("pickSettledVersion", () => {
  // postcss as it stood when gnom's vite fix was held for 8.5.32
  const postcss = {
    created: ago(4000),
    modified: ago(1.9),
    "8.5.30": ago(16),
    "8.5.31": ago(10),
    "8.5.32": ago(1.9),
  };

  it("takes the newest release that has cleared the cooldown", () => {
    const pick = pickSettledVersion(postcss, "8.5.32", 3, NOW);
    assert.equal(pick?.version, "8.5.31");
  });

  it("returns null when every older release is still too fresh", () => {
    assert.equal(pickSettledVersion(postcss, "8.5.32", 30, NOW), null);
  });

  it("never crosses onto another major", () => {
    const times = { "1.9.9": ago(100), "2.0.0": ago(1) };
    assert.equal(pickSettledVersion(times, "2.0.0", 3, NOW), null);
  });

  it("skips prereleases and the registry's bookkeeping keys", () => {
    const times = {
      created: ago(500),
      "3.4.4": ago(1),
      "3.4.4-rc.1": ago(20),
      "3.4.3": ago(20),
    };
    assert.equal(pickSettledVersion(times, "3.4.4", 3, NOW)?.version, "3.4.3");
  });
});

describe("overrideIsContained", () => {
  it("allows a pin when every copy is on the fresh version's line", () => {
    const locked = [
      { name: "postcss", version: "8.5.32" },
      { name: "vite", version: "8.3.5" },
    ];
    assert.equal(overrideIsContained(locked, "postcss", "8.5.32"), true);
  });

  it("refuses when the tree also holds another major", () => {
    const locked = [
      { name: "postcss", version: "8.5.32" },
      { name: "postcss", version: "7.0.39" },
    ];
    assert.equal(overrideIsContained(locked, "postcss", "8.5.32"), false);
  });
});

describe("settleOnOlderReleases", () => {
  async function project(manifest: Record<string, unknown>): Promise<ProjectInfo> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "depstorm-settle-"));
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return { name: "p", path: dir, packageManager: "pnpm", hasGit: false };
  }

  it("leaves an override the project already declares alone", async () => {
    const manifest = { name: "p", pnpm: { overrides: { postcss: "^8.5.0" } } };
    const p = await project(manifest);
    let installs = 0;

    const result = await settleOnOlderReleases(
      p,
      [{ name: "postcss", version: "8.5.32", publishedAt: ago(1.9), ageDays: 1.9 }],
      {
        config: { ...DEFAULT_CONFIG, minReleaseAgeDays: 3 },
        lockAfterFix: "",
        install: async () => {
          installs++;
          return true;
        },
        now: NOW,
      },
    );

    assert.equal(result, null);
    assert.equal(installs, 0);
    const raw = await fs.readFile(path.join(p.path, "package.json"), "utf-8");
    assert.deepEqual(JSON.parse(raw), manifest);
  });

  it("refuses for a package manager with no override block", async () => {
    const p = { ...(await project({ name: "p" })), packageManager: "yarn" as const };
    const result = await settleOnOlderReleases(
      p,
      [{ name: "postcss", version: "8.5.32", publishedAt: ago(1.9), ageDays: 1.9 }],
      {
        config: { ...DEFAULT_CONFIG, minReleaseAgeDays: 3 },
        lockAfterFix: "",
        install: async () => true,
        now: NOW,
      },
    );
    assert.equal(result, null);
  });
});
