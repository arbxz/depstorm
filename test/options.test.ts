import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyCliOptions,
  parseDepth,
  parsePositiveInt,
  requireSeverity,
} from "../src/options.js";
import { silenceLogs, testConfig } from "./helpers/repo.js";

silenceLogs();

describe("parseDepth", () => {
  it("accepts a non-negative integer", () => {
    assert.equal(parseDepth("0"), 0);
    assert.equal(parseDepth("5"), 5);
  });

  it("rejects anything else", () => {
    assert.throws(() => parseDepth("-1"), /non-negative/);
    assert.throws(() => parseDepth("two"), /non-negative/);
  });
});

describe("parsePositiveInt", () => {
  it("accepts one or more", () => {
    assert.equal(parsePositiveInt("1"), 1);
    assert.equal(parsePositiveInt("8"), 8);
  });

  it("rejects zero, negatives and non-numbers", () => {
    assert.throws(() => parsePositiveInt("0"), /1 or more/);
    assert.throws(() => parsePositiveInt("-2"), /1 or more/);
    assert.throws(() => parsePositiveInt("many"), /1 or more/);
  });
});

describe("requireSeverity", () => {
  it("accepts a known level", () => {
    assert.equal(requireSeverity("high", "--severity"), "high");
  });

  it("names the flag and the valid values when rejecting", () => {
    assert.throws(() => requireSeverity("HIGH", "--severity"), /--severity/);
    assert.throws(() => requireSeverity("HIGH", "--severity"), /critical/);
  });
});

describe("applyCliOptions — git flag precedence", () => {
  it("--no-git disables every git operation the config enabled", () => {
    const config = applyCliOptions(
      testConfig({
        gitBranch: true,
        gitCommit: true,
        gitPush: true,
        gitMerge: true,
      }),
      { git: false },
    );

    assert.deepEqual(
      {
        branch: config.gitBranch,
        commit: config.gitCommit,
        push: config.gitPush,
        merge: config.gitMerge,
      },
      { branch: false, commit: false, push: false, merge: false },
      "leaving push or merge on made --no-git write to the source branch",
    );
  });

  it("does not let normalisation switch git back on after --no-git", () => {
    const config = applyCliOptions(
      testConfig({ gitMerge: true, gitBranch: true, gitCommit: true }),
      { git: false },
    );

    assert.equal(config.gitCommit, false);
    assert.equal(config.gitBranch, false);
  });

  it("--skip-push beats --push", () => {
    const config = applyCliOptions(testConfig({ gitPush: false }), {
      push: true,
      skipPush: true,
    });

    assert.equal(config.gitPush, false);
  });

  it("--skip-merge beats --merge", () => {
    const config = applyCliOptions(testConfig({ gitMerge: false }), {
      merge: true,
      skipMerge: true,
    });

    assert.equal(config.gitMerge, false);
  });

  it("--skip-push overrides a config file that enabled pushing", () => {
    assert.equal(
      applyCliOptions(testConfig({ gitPush: true }), { skipPush: true })
        .gitPush,
      false,
    );
  });

  it("--merge implies branching, via normalisation", () => {
    const config = applyCliOptions(
      testConfig({ gitBranch: false, gitCommit: false, gitMerge: false }),
      { merge: true },
    );

    assert.equal(config.gitMerge, true);
    assert.equal(config.gitBranch, true);
    assert.equal(config.gitCommit, true);
  });
});

describe("applyCliOptions — reports and thresholds", () => {
  it("--report sets the path", () => {
    assert.equal(
      applyCliOptions(testConfig(), { report: "./out/run" }).reportPath,
      "./out/run",
    );
  });

  it("--no-report clears a path the config set", () => {
    assert.equal(
      applyCliOptions(testConfig({ reportPath: "./audit-reports/report" }), {
        report: false,
      }).reportPath,
      undefined,
    );
  });

  it("rejects a bad --severity rather than silently disabling fixes", () => {
    assert.throws(
      () => applyCliOptions(testConfig(), { severity: "HIGH" }),
      /--severity/,
    );
  });

  it("rejects a bad --fail-on", () => {
    assert.throws(
      () => applyCliOptions(testConfig(), { failOn: "extreme" }),
      /--fail-on/,
    );
  });

  it("leaves thresholds absent when no flag is given", () => {
    const config = applyCliOptions(testConfig(), {});
    assert.equal(config.failOn, undefined);
    assert.equal(config.failOnQuality, undefined);
  });
});

describe("applyCliOptions — ignore rules", () => {
  it("labels --ignore entries as command-line suppressions", () => {
    const config = applyCliOptions(testConfig(), { ignore: ["lodash"] });

    assert.equal(config.ignore?.length, 1);
    assert.equal(config.ignore?.[0]?.package, "lodash");
    assert.match(config.ignore?.[0]?.reason ?? "", /command line/);
  });

  it("appends to config rules rather than replacing them", () => {
    const config = applyCliOptions(
      testConfig({ ignore: [{ package: "minimist", reason: "reviewed" }] }),
      { ignore: ["lodash"] },
    );

    assert.deepEqual(
      config.ignore?.map((r) => r.package),
      ["minimist", "lodash"],
    );
  });
});

describe("applyCliOptions — passthrough flags", () => {
  it("carries the simple opt-ins", () => {
    const config = applyCliOptions(testConfig(), {
      dryRun: true,
      autoStash: true,
      allowInstallScripts: true,
      concurrency: 4,
      depth: 2,
      branch: "develop",
      root: ["/a", "/b"],
    });

    assert.equal(config.dryRun, true);
    assert.equal(config.autoStash, true);
    assert.equal(config.allowInstallScripts, true);
    assert.equal(config.concurrency, 4);
    assert.equal(config.scanDepth, 2);
    assert.equal(config.sourceBranch, "develop");
    assert.deepEqual(config.roots, ["/a", "/b"]);
  });

  it("treats --no-fix and --no-build as their commander false values", () => {
    const config = applyCliOptions(testConfig(), { fix: false, build: false });

    assert.equal(config.autoFix, false);
    assert.equal(config.verifyBuild, false);
  });

  it("leaves everything alone when no options are given", () => {
    const before = testConfig();
    const after = applyCliOptions(testConfig(), {});

    assert.deepEqual(after, before);
  });

  it("does not mistake a depth of 0 for absent", () => {
    assert.equal(applyCliOptions(testConfig(), { depth: 0 }).scanDepth, 0);
  });
});
