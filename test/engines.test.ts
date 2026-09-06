import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatFloor,
  lowestNodeFloor,
  parseEngineRequirements,
  strictestRequirement,
} from "../src/engines.js";
import { silenceLogs } from "./helpers/repo.js";

silenceLogs();

describe("lowestNodeFloor", () => {
  it("takes the smallest alternative, which is what the range admits", () => {
    // postcss-merge-longhand's real constraint. Reading the largest
    // alternative would claim it needs Node 26, which it does not.
    assert.deepEqual(lowestNodeFloor("^22.11.0 || ^24.11.0 || >=26.0"), {
      major: 22,
      minor: 11,
    });
  });

  it("reads a simple lower bound", () => {
    assert.deepEqual(lowestNodeFloor(">=18.0.0"), { major: 18, minor: 0 });
  });

  it("defaults a missing minor to zero", () => {
    assert.deepEqual(lowestNodeFloor(">=20"), { major: 20, minor: 0 });
  });

  it("returns null when there is no version to read", () => {
    assert.equal(lowestNodeFloor("*"), null);
  });
});

describe("parseEngineRequirements for pnpm", () => {
  const lock = `lockfileVersion: '9'

packages:

  postcss-merge-longhand@8.0.4:
    resolution: {integrity: sha512-aaa==}
    engines: {node: '^22.11.0 || ^24.11.0 || >=26.0'}

  browserslist@4.28.8:
    resolution: {integrity: sha512-bbb==}
    engines: {node: ^6 || ^7 || ^8 || >=13.7}
    hasBin: true

  nanoid@3.3.18:
    resolution: {integrity: sha512-ccc==}
`;

  it("attributes each constraint to the package that declares it", () => {
    const found = parseEngineRequirements(lock, "pnpm");
    const longhand = found.find((r) =>
      r.source.startsWith("postcss-merge-longhand"),
    );

    assert.ok(longhand, "the package requiring Node 22 must be found");
    assert.equal(longhand.major, 22);
    assert.equal(longhand.minor, 11);
  });

  it("picks the steepest requirement in the tree", () => {
    const strictest = strictestRequirement(parseEngineRequirements(lock, "pnpm"));
    assert.ok(strictest);
    assert.equal(formatFloor(strictest), "22.11");
    assert.ok(strictest.source.startsWith("postcss-merge-longhand"));
  });

  it("returns nothing when no package declares engines", () => {
    const bare = "lockfileVersion: '9'\n\npackages:\n\n  nanoid@3.3.18:\n    resolution: {integrity: sha512-a==}\n";
    assert.deepEqual(parseEngineRequirements(bare, "pnpm"), []);
    assert.equal(strictestRequirement([]), null);
  });
});

describe("parseEngineRequirements for npm", () => {
  it("reads engines.node out of the lockfile entries", () => {
    const lock = JSON.stringify({
      packages: {
        "": { name: "root" },
        "node_modules/postcss-merge-longhand": {
          version: "8.0.4",
          engines: { node: "^22.11.0 || ^24.11.0 || >=26.0" },
        },
        "node_modules/nanoid": { version: "3.3.18" },
      },
    });

    const strictest = strictestRequirement(parseEngineRequirements(lock, "npm"));
    assert.ok(strictest);
    assert.equal(formatFloor(strictest), "22.11");
    assert.equal(strictest.source, "postcss-merge-longhand");
  });

  it("survives unparseable input", () => {
    assert.deepEqual(parseEngineRequirements("{", "npm"), []);
  });
});
