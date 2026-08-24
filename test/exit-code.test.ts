import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_OK,
  EXIT_OPERATIONAL_FAILURE,
  EXIT_POLICY_FAILURE,
  resolveExitCode,
} from "../src/exit-code.js";
import {
  emptySeverityMap,
  type ProjectReport,
  type Severity,
} from "../src/types.js";
import { projectInfo, silenceLogs, testConfig } from "./helpers/repo.js";

silenceLogs();

function severityMap(counts: Partial<Record<Severity, number>>) {
  return { ...emptySeverityMap(), ...counts };
}

function report(
  name: string,
  overrides: Partial<ProjectReport> = {},
): ProjectReport {
  return {
    project: projectInfo("/tmp/x", { name }),
    audit: {
      vulnerabilities: [],
      totalCount: 0,
      fixableCount: 0,
      breakingFixCount: 0,
      bySeverity: emptySeverityMap(),
    },
    reverted: false,
    timestamp: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveExitCode", () => {
  it("passes a clean run", () => {
    assert.deepEqual(resolveExitCode([report("a")], testConfig()), {
      code: EXIT_OK,
    });
  });

  it("passes an empty run", () => {
    assert.equal(resolveExitCode([], testConfig()).code, EXIT_OK);
  });

  it("fails operationally on an audit error", () => {
    const decision = resolveExitCode(
      [
        report("broken", {
          audit: {
            vulnerabilities: [],
            totalCount: 0,
            fixableCount: 0,
            breakingFixCount: 0,
            bySeverity: emptySeverityMap(),
            error: "registry unreachable",
          },
        }),
      ],
      testConfig(),
    );

    assert.equal(decision.code, EXIT_OPERATIONAL_FAILURE);
    assert.deepEqual(decision.projects, ["broken"]);
  });

  it("fails operationally on an incomplete revert", () => {
    assert.equal(
      resolveExitCode(
        [report("a", { revertIncomplete: "install exited 1" })],
        testConfig(),
      ).code,
      EXIT_OPERATIONAL_FAILURE,
    );
  });

  it("fails operationally when stashed work could not be restored", () => {
    const decision = resolveExitCode(
      [
        report("a", {
          stashRestore: { ok: false, reason: "conflict", conflicts: ["x.js"] },
        }),
      ],
      testConfig(),
    );

    assert.equal(decision.code, EXIT_OPERATIONAL_FAILURE);
    assert.match(decision.reason ?? "", /unrestored work/);
  });

  it("does not treat a successful stash restore as a failure", () => {
    assert.equal(
      resolveExitCode([report("a", { stashRestore: { ok: true } })], testConfig())
        .code,
      EXIT_OK,
    );
  });

  it("fails on policy when --fail-on is breached", () => {
    const decision = resolveExitCode(
      [
        report("risky", {
          audit: {
            vulnerabilities: [],
            totalCount: 1,
            fixableCount: 0,
            breakingFixCount: 0,
            bySeverity: severityMap({ critical: 1 }),
          },
        }),
      ],
      testConfig({ failOn: "high" }),
    );

    assert.equal(decision.code, EXIT_POLICY_FAILURE);
    assert.deepEqual(decision.projects, ["risky"]);
  });

  it("ignores vulnerabilities below the --fail-on threshold", () => {
    assert.equal(
      resolveExitCode(
        [
          report("mild", {
            audit: {
              vulnerabilities: [],
              totalCount: 1,
              fixableCount: 0,
              breakingFixCount: 0,
              bySeverity: severityMap({ low: 1 }),
            },
          }),
        ],
        testConfig({ failOn: "high" }),
      ).code,
      EXIT_OK,
    );
  });

  it("fails on policy when --fail-on-quality is breached", () => {
    const decision = resolveExitCode(
      [
        report("smelly", {
          sonar: {
            issues: [],
            totalCount: 3,
            issuesBySeverity: severityMap({ high: 3 }),
          },
        }),
      ],
      testConfig({ failOnQuality: "high" }),
    );

    assert.equal(decision.code, EXIT_POLICY_FAILURE);
    assert.match(decision.reason ?? "", /code quality/);
  });

  it("does not fail on quality issues below the threshold", () => {
    assert.equal(
      resolveExitCode(
        [
          report("a", {
            sonar: {
              issues: [],
              totalCount: 3,
              issuesBySeverity: severityMap({ moderate: 3 }),
            },
          }),
        ],
        testConfig({ failOnQuality: "high" }),
      ).code,
      EXIT_OK,
    );
  });

  it("ranks an unrestored stash above a policy breach", () => {
    const decision = resolveExitCode(
      [
        report("a", {
          audit: {
            vulnerabilities: [],
            totalCount: 1,
            fixableCount: 0,
            breakingFixCount: 0,
            bySeverity: severityMap({ critical: 1 }),
          },
          stashRestore: { ok: false, reason: "missing" },
        }),
      ],
      testConfig({ failOn: "high" }),
    );

    assert.equal(
      decision.code,
      EXIT_OPERATIONAL_FAILURE,
      "a repository the user has to repair matters more than a severity threshold",
    );
  });

  it("reports every offending project, not just the first", () => {
    const decision = resolveExitCode(
      [
        report("a", { revertIncomplete: "x" }),
        report("b", { revertIncomplete: "y" }),
        report("c"),
      ],
      testConfig(),
    );

    assert.deepEqual(decision.projects, ["a", "b"]);
  });
});
