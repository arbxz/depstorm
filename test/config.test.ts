import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  mergeConfig,
  normaliseGitFlags,
  resolveReportBase,
  resolveRoots,
} from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { cleanupTempDirs, silenceLogs, testConfig } from "./helpers/repo.js";

silenceLogs();
after(cleanupTempDirs);

describe("resolveReportBase", () => {
  const cwd = path.resolve("/work");

  it("keeps an extensionless path with a leading ./ intact", () => {
    // The old `/\.[^.]+$/` strip collapsed this to "", writing ./.json
    const base = resolveReportBase("./audit-reports/report", cwd);

    assert.equal(path.basename(base), "report");
    assert.equal(path.basename(path.dirname(base)), "audit-reports");
  });

  it("strips a known report extension", () => {
    assert.equal(
      resolveReportBase("out/report.json", cwd),
      resolveReportBase("out/report", cwd),
    );
    assert.equal(
      resolveReportBase("out/report.html", cwd),
      resolveReportBase("out/report", cwd),
    );
  });

  it("keeps an unknown suffix as part of the name", () => {
    assert.equal(path.basename(resolveReportBase("out/report.2026", cwd)), "report.2026");
  });

  it("never produces an empty base name", () => {
    for (const input of ["./report", "report", "./a/b/c", "x.json"]) {
      assert.notEqual(path.basename(resolveReportBase(input, cwd)), "");
    }
  });

  it("respects absolute paths", () => {
    const abs = path.resolve("/elsewhere/out/report");
    assert.equal(resolveReportBase(abs, cwd), abs);
  });
});

describe("mergeConfig validation", () => {
  it("accepts an empty object as the defaults", () => {
    assert.deepEqual(mergeConfig({}), normaliseGitFlags({ ...DEFAULT_CONFIG }));
  });

  it("rejects an unrecognised severity instead of silently disabling fixes", () => {
    assert.throws(
      () => mergeConfig({ severityThreshold: "HIGH" }),
      /severityThreshold/,
    );
  });

  it("rejects a non-boolean flag", () => {
    assert.throws(() => mergeConfig({ autoFix: "yes" }), /autoFix/);
  });

  it("rejects a negative or fractional scanDepth", () => {
    assert.throws(() => mergeConfig({ scanDepth: -1 }), /scanDepth/);
    assert.throws(() => mergeConfig({ scanDepth: 1.5 }), /scanDepth/);
  });

  it("rejects roots that are not an array of strings", () => {
    assert.throws(() => mergeConfig({ roots: "." }), /roots/);
    assert.throws(() => mergeConfig({ roots: [1, 2] }), /roots/);
  });

  it("rejects projectBranches with non-string values", () => {
    assert.throws(
      () => mergeConfig({ projectBranches: { web: 5 } }),
      /projectBranches/,
    );
  });

  it("rejects a non-object config", () => {
    assert.throws(() => mergeConfig([]), /expected a JSON object/);
    assert.throws(() => mergeConfig("nope"), /expected a JSON object/);
  });

  it("reports every problem at once", () => {
    assert.throws(
      () => mergeConfig({ severityThreshold: "nope", scanDepth: -3 }),
      (err: Error) =>
        /severityThreshold/.test(err.message) && /scanDepth/.test(err.message),
    );
  });

  it("keeps valid overrides", () => {
    const config = mergeConfig({
      severityThreshold: "critical",
      scanDepth: 7,
      roots: ["a", "b"],
      failOn: "moderate",
      sonarCheck: false,
    });

    assert.equal(config.severityThreshold, "critical");
    assert.equal(config.scanDepth, 7);
    assert.deepEqual(config.roots, ["a", "b"]);
    assert.equal(config.failOn, "moderate");
    assert.equal(config.sonarCheck, false);
  });
});

describe("normaliseGitFlags", () => {
  it("enables branching when merging is requested", () => {
    const config = normaliseGitFlags(
      testConfig({ gitMerge: true, gitBranch: false, gitCommit: false }),
    );

    assert.equal(config.gitBranch, true, "merging requires a fix branch");
    assert.equal(config.gitCommit, true);
  });

  it("enables commits when pushing is requested", () => {
    const config = normaliseGitFlags(
      testConfig({ gitPush: true, gitCommit: false }),
    );

    assert.equal(config.gitCommit, true);
  });

  it("leaves a fully disabled git config alone", () => {
    const config = normaliseGitFlags(
      testConfig({
        gitBranch: false,
        gitCommit: false,
        gitPush: false,
        gitMerge: false,
      }),
    );

    assert.deepEqual(
      [config.gitBranch, config.gitCommit, config.gitPush, config.gitMerge],
      [false, false, false, false],
      "nothing may re-enable git operations the user turned off",
    );
  });
});

describe("resolveRoots", () => {
  it("resolves relative roots against the cwd and keeps absolute ones", () => {
    const cwd = path.resolve("/work");
    const abs = path.resolve("/other");

    const resolved = resolveRoots(testConfig({ roots: ["sub", abs] }), cwd);

    assert.equal(resolved[0], path.join(cwd, "sub"));
    assert.equal(resolved[1], abs);
  });
});
