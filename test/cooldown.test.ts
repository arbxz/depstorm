import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addedVersions,
  ageInDays,
  describeAge,
  findTooFresh,
  parseLockedVersions,
} from "../src/cooldown.js";
import { silenceLogs } from "./helpers/repo.js";

silenceLogs();

const PNPM_LOCK = `lockfileVersion: '9'

settings:
  autoInstallPeers: true

importers:
  .:
    dependencies:
      vite:
        specifier: ^7.0.0
        version: 7.3.6

packages:

  vite@7.3.6:
    resolution: {integrity: sha512-aaa==}
    engines: {node: ^20.19.0 || >=22.12.0}

  '@babel/core@7.29.7':
    resolution: {integrity: sha512-bbb==}

  nanoid@3.3.18:
    resolution: {integrity: sha512-ccc==}

snapshots:

  vite@7.3.6(@types/node@22.0.0):
    dependencies:
      esbuild: 0.27.2
`;

describe("parseLockedVersions for pnpm", () => {
  it("reads name and version from the packages block", () => {
    const found = parseLockedVersions(PNPM_LOCK, "pnpm");
    assert.deepEqual(
      found.map((p) => `${p.name}@${p.version}`).sort(),
      ["@babel/core@7.29.7", "nanoid@3.3.18", "vite@7.3.6"],
    );
  });

  it("ignores the snapshots block, whose keys carry peer suffixes", () => {
    const found = parseLockedVersions(PNPM_LOCK, "pnpm");
    assert.ok(
      !found.some((p) => p.version.includes("(")),
      "a peer suffix is not a version any registry knows",
    );
    assert.equal(found.filter((p) => p.name === "vite").length, 1);
  });

  it("does not mistake importers entries for packages", () => {
    const found = parseLockedVersions(PNPM_LOCK, "pnpm");
    assert.ok(!found.some((p) => p.name === "specifier"));
  });
});

describe("parseLockedVersions for npm", () => {
  it("reads every node_modules entry", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root", version: "1.0.0" },
        "node_modules/vite": { version: "7.3.6" },
        "node_modules/@babel/core": { version: "7.29.7" },
        "node_modules/a/node_modules/nanoid": { version: "3.3.18" },
      },
    });

    const found = parseLockedVersions(lock, "npm");
    assert.deepEqual(
      found.map((p) => `${p.name}@${p.version}`).sort(),
      ["@babel/core@7.29.7", "nanoid@3.3.18", "vite@7.3.6"],
    );
  });

  it("skips the root entry, which has no registry record", () => {
    const lock = JSON.stringify({ packages: { "": { version: "1.0.0" } } });
    assert.deepEqual(parseLockedVersions(lock, "npm"), []);
  });

  it("returns nothing for unparseable input rather than throwing", () => {
    assert.deepEqual(parseLockedVersions("not json", "npm"), []);
  });
});

describe("addedVersions", () => {
  it("reports only what the fix newly pinned", () => {
    const before = [
      { name: "vite", version: "7.3.1" },
      { name: "nanoid", version: "3.3.18" },
    ];
    const after = [
      { name: "vite", version: "7.3.6" },
      { name: "nanoid", version: "3.3.18" },
    ];

    assert.deepEqual(addedVersions(before, after), [
      { name: "vite", version: "7.3.6" },
    ]);
  });

  it("treats every version as new when there was no lockfile", () => {
    const after = [{ name: "vite", version: "7.3.6" }];
    assert.deepEqual(addedVersions([], after), after);
  });

  it("does not report the same version twice", () => {
    const after = [
      { name: "vite", version: "7.3.6" },
      { name: "vite", version: "7.3.6" },
    ];
    assert.equal(addedVersions([], after).length, 1);
  });
});

describe("ageInDays", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");

  it("measures a publish date against now", () => {
    assert.equal(ageInDays("2026-09-03T12:00:00Z", now), 3);
  });

  it("returns null for an unreadable timestamp", () => {
    assert.equal(ageInDays("whenever", now), null);
  });
});

describe("describeAge", () => {
  it("reads a sub-day age in hours, where the risk actually lives", () => {
    assert.equal(describeAge(0.25), "6h old");
  });

  it("reads a longer age in days", () => {
    assert.equal(describeAge(4.25), "4.3d old");
  });
});

describe("findTooFresh", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");

  it("does not block when the registry cannot be reached", async () => {
    // A package name that cannot resolve stands in for an unreachable
    // registry: the lookup fails, and the fix must not be refused for it.
    const result = await findTooFresh(
      [{ name: "@depstorm/definitely-not-a-real-package", version: "1.0.0" }],
      { cwd: process.cwd(), minAgeDays: 3, timeout: 30_000, now },
    );

    assert.deepEqual(result.tooFresh, [], "an unknown date must not block");
    assert.equal(result.unknown.length, 1);
  });

  it("checks nothing when the fix added nothing", async () => {
    const result = await findTooFresh([], {
      cwd: process.cwd(),
      minAgeDays: 3,
      timeout: 30_000,
      now,
    });
    assert.deepEqual(result, { tooFresh: [], unknown: [], checked: 0 });
  });
});
