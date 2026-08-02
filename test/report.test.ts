import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  effectiveFixedCount,
  hasUnresolvedAtOrAbove,
  remainingBySeverity,
  saveHtmlReport,
  saveJsonReport,
} from "../src/report.js";
import {
  emptySeverityMap,
  type ProjectReport,
  type Severity,
} from "../src/types.js";
import {
  cleanupTempDirs,
  projectInfo,
  silenceLogs,
  tempDir,
} from "./helpers/repo.js";

silenceLogs();
after(cleanupTempDirs);

function severityMap(counts: Partial<Record<Severity, number>>) {
  return { ...emptySeverityMap(), ...counts };
}

function reportWith(overrides: Partial<ProjectReport> = {}): ProjectReport {
  return {
    project: projectInfo("/tmp/x", { name: "demo" }),
    audit: {
      vulnerabilities: [],
      totalCount: 2,
      fixableCount: 2,
      bySeverity: severityMap({ critical: 1, low: 1 }),
    },
    reverted: false,
    timestamp: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("effectiveFixedCount", () => {
  it("counts a successful fix", () => {
    const report = reportWith({
      fix: { applied: true, fixedCount: 2, remainingCount: 0, verified: true },
    });

    assert.equal(effectiveFixedCount(report), 2);
  });

  it("counts nothing when the fix was rolled back", () => {
    const report = reportWith({
      reverted: true,
      fix: { applied: true, fixedCount: 2, remainingCount: 0, verified: true },
    });

    assert.equal(
      effectiveFixedCount(report),
      0,
      "a reverted fix resolved nothing and must not be reported as fixed",
    );
  });

  it("counts nothing when no fix ran", () => {
    assert.equal(effectiveFixedCount(reportWith()), 0);
  });
});

describe("remainingBySeverity", () => {
  it("prefers the post-fix re-audit", () => {
    const report = reportWith({
      fix: {
        applied: true,
        fixedCount: 1,
        remainingCount: 1,
        verified: true,
        remainingBySeverity: severityMap({ low: 1 }),
      },
    });

    assert.deepEqual(remainingBySeverity(report), severityMap({ low: 1 }));
  });

  it("falls back to the original audit after a revert", () => {
    const report = reportWith({
      reverted: true,
      fix: {
        applied: true,
        fixedCount: 1,
        remainingCount: 1,
        verified: true,
        remainingBySeverity: severityMap({ low: 1 }),
      },
    });

    assert.deepEqual(
      remainingBySeverity(report),
      severityMap({ critical: 1, low: 1 }),
      "post-fix numbers no longer describe a repository whose fix was undone",
    );
  });

  it("uses the audit when no fix ran", () => {
    assert.deepEqual(
      remainingBySeverity(reportWith()),
      severityMap({ critical: 1, low: 1 }),
    );
  });
});

describe("hasUnresolvedAtOrAbove", () => {
  it("is true when something at the threshold remains", () => {
    assert.equal(hasUnresolvedAtOrAbove(reportWith(), "critical"), true);
    assert.equal(hasUnresolvedAtOrAbove(reportWith(), "low"), true);
  });

  it("is false once everything is fixed", () => {
    const report = reportWith({
      fix: {
        applied: true,
        fixedCount: 2,
        remainingCount: 0,
        verified: true,
        remainingBySeverity: emptySeverityMap(),
      },
    });

    assert.equal(hasUnresolvedAtOrAbove(report, "low"), false);
  });

  it("ignores vulnerabilities below the threshold", () => {
    const report = reportWith({
      fix: {
        applied: true,
        fixedCount: 1,
        remainingCount: 1,
        verified: true,
        remainingBySeverity: severityMap({ low: 3 }),
      },
    });

    assert.equal(hasUnresolvedAtOrAbove(report, "high"), false);
    assert.equal(hasUnresolvedAtOrAbove(report, "low"), true);
  });

  it("treats a failed audit as unresolved", () => {
    const report = reportWith({
      audit: {
        vulnerabilities: [],
        totalCount: 0,
        fixableCount: 0,
        bySeverity: emptySeverityMap(),
        error: "registry unreachable",
      },
    });

    assert.equal(
      hasUnresolvedAtOrAbove(report, "critical"),
      true,
      "an unknown state is not a pass",
    );
  });
});

describe("saveJsonReport", () => {
  it("creates the directory and writes valid JSON", async () => {
    const dir = tempDir();
    const out = path.join(dir, "nested", "deeper", "report.json");

    await saveJsonReport([reportWith()], out);

    const parsed = JSON.parse(fs.readFileSync(out, "utf-8"));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].project.name, "demo");
  });
});

describe("saveHtmlReport", () => {
  async function render(reports: ProjectReport[]): Promise<string> {
    const out = path.join(tempDir(), "report.html");
    await saveHtmlReport(reports, out);
    return fs.readFileSync(out, "utf-8");
  }

  it("escapes markup coming from third-party strings", async () => {
    const html = await render([
      reportWith({
        project: projectInfo("/tmp/x", {
          name: "<img src=x onerror=alert(1)>",
        }),
        sonar: {
          totalCount: 1,
          issuesBySeverity: severityMap({ high: 1 }),
          issues: [
            {
              rule: "sonarjs/no-x",
              severity: "high",
              message: `"><script>alert('xss')</script>`,
              file: "src/a.ts",
              line: 3,
              column: 1,
            },
          ],
        },
      }),
    ]);

    assert.ok(!html.includes("<script>"), "script tags must not survive");
    assert.ok(!html.includes("<img src=x"), "img tags must not survive");
    assert.ok(html.includes("&lt;img"), "the name should be visible, escaped");
    assert.ok(!html.includes(`alert('xss')`), "quotes must be escaped");
  });

  it("shows a rolled-back fix as zero fixed", async () => {
    const html = await render([
      reportWith({
        reverted: true,
        fix: { applied: true, fixedCount: 3, remainingCount: 0, verified: true },
        build: { success: false, skipped: false, output: "boom" },
      }),
    ]);

    assert.match(html, /rolled back/);
    assert.ok(
      !/<strong>3<\/strong> Fixed/.test(html),
      "the summary must not credit a reverted fix",
    );
  });

  it("labels a failed audit rather than showing zero vulnerabilities", async () => {
    const html = await render([
      reportWith({
        audit: {
          vulnerabilities: [],
          totalCount: 0,
          fixableCount: 0,
          bySeverity: emptySeverityMap(),
          error: "registry unreachable",
        },
      }),
    ]);

    assert.match(html, /audit failed/i);
  });

  it("marks unverified fix counts", async () => {
    const html = await render([
      reportWith({
        fix: { applied: true, fixedCount: 1, remainingCount: 1, verified: false },
      }),
    ]);

    assert.match(html, /unverified/);
  });
});
