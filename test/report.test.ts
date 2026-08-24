import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  describeStashFailure,
  effectiveFixedCount,
  hasUnresolvedAtOrAbove,
  operationalFailure,
  remainingBySeverity,
  remediation,
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
      breakingFixCount: 0,
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
        breakingFixCount: 0,
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

    assert.ok(!html.includes("<img src=x"), "img tags must not survive");
    assert.ok(html.includes("&lt;img"), "the name should be visible, escaped");
    assert.ok(!html.includes(`alert('xss')`), "quotes must be escaped");
    assert.ok(
      html.includes("&lt;script&gt;"),
      "an injected script tag must appear escaped, not live",
    );

    // The report ships exactly one script block of its own — the one driving
    // search, sort and row expansion. Any second one came from report data.
    assert.equal(
      html.split("<script>").length - 1,
      1,
      "only depstorm's own inline script may appear",
    );
    assert.ok(
      !/<script[^>]*>(?![\s\S]*?depstorm)[\s\S]{0,40}alert/i.test(html),
      "no script block may contain injected payload",
    );
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
          breakingFixCount: 0,
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

describe("operationalFailure", () => {
  it("passes a clean run", () => {
    assert.equal(operationalFailure(reportWith()), undefined);
  });

  it("flags a stash that could not be put back", () => {
    const result = operationalFailure(
      reportWith({
        stashRestore: { ok: false, reason: "conflict", conflicts: ["src.js"] },
      }),
    );

    assert.ok(
      result,
      "a conflicted pop leaves conflict markers in the user's tree — the run did not succeed",
    );
    assert.match(result, /src\.js/);
  });

  it("flags a revert that could not be completed", () => {
    assert.match(
      operationalFailure(reportWith({ revertIncomplete: "install exited 1" })) ??
        "",
      /revert incomplete/,
    );
  });

  it("ranks unrestored work above an audit failure", () => {
    const result = operationalFailure(
      reportWith({
        audit: {
          vulnerabilities: [],
          totalCount: 0,
          fixableCount: 0,
          breakingFixCount: 0,
          bySeverity: emptySeverityMap(),
          error: "audit blew up",
        },
        stashRestore: { ok: false, reason: "missing" },
      }),
    );

    assert.match(
      result ?? "",
      /STASHED WORK/,
      "the user's own work is the more urgent of the two",
    );
  });

  it("does not treat a successful restore as a failure", () => {
    assert.equal(
      operationalFailure(reportWith({ stashRestore: { ok: true } })),
      undefined,
    );
  });
});

describe("describeStashFailure", () => {
  it("names the conflicting files and how to recover", () => {
    const text = describeStashFailure({
      ok: false,
      reason: "conflict",
      conflicts: ["a.js", "b.js"],
    });

    assert.match(text, /a\.js, b\.js/);
    assert.match(text, /git stash drop/);
  });

  it("points at the stash list when the stash went missing", () => {
    assert.match(
      describeStashFailure({ ok: false, reason: "missing" }),
      /git stash list/,
    );
  });
});

describe("advisory links in the HTML report", () => {
  async function render(reports: ProjectReport[]): Promise<string> {
    const out = path.join(tempDir(), "report.html");
    await saveHtmlReport(reports, out);
    return fs.readFileSync(out, "utf-8");
  }

  function vuln(overrides: Partial<ProjectReport["audit"]["vulnerabilities"][number]> = {}) {
    return {
      name: "lodash",
      severity: "critical" as Severity,
      title: "Prototype Pollution",
      url: "https://github.com/advisories/GHSA-1234",
      range: "<4.17.21",
      fixAvailable: true,
      fixIsBreaking: false,
      ...overrides,
    };
  }

  function withVulns(
    vulns: ReturnType<typeof vuln>[],
    audit: Partial<ProjectReport["audit"]> = {},
  ) {
    return reportWith({
      audit: {
        vulnerabilities: vulns,
        totalCount: vulns.length,
        fixableCount: vulns.filter((v) => v.fixAvailable && !v.fixIsBreaking)
          .length,
        breakingFixCount: vulns.filter((v) => v.fixIsBreaking).length,
        bySeverity: severityMap({ critical: vulns.length }),
        ...audit,
      },
    });
  }

  it("links the advisory instead of rendering the URL as dead text", async () => {
    const html = await render([withVulns([vuln()])]);

    assert.match(
      html,
      /<a href="https:\/\/github\.com\/advisories\/GHSA-1234"[^>]*>Prototype Pollution<\/a>/,
    );
    assert.match(html, /rel="noreferrer noopener"/);
  });

  it("refuses to link a non-http scheme", async () => {
    const html = await render([
      withVulns([vuln({ url: "javascript:alert(1)" })]),
    ]);

    assert.ok(
      !/href="javascript:/i.test(html),
      "advisory URLs are third-party strings — only http(s) may become an href",
    );
    assert.match(html, /Prototype Pollution/, "the title still shows as text");
  });

  it("renders plain text when there is no advisory URL", async () => {
    const html = await render([withVulns([vuln({ url: "" })])]);

    assert.match(html, /Prototype Pollution/);
    assert.ok(!/<a href="">/.test(html));
  });

  it("marks a breaking-only fix distinctly from an available one", async () => {
    const html = await render([
      withVulns([vuln({ fixIsBreaking: true })]),
    ]);

    assert.match(html, />breaking</);
  });

  it("notes when code quality rows were truncated", async () => {
    const issues = Array.from({ length: 25 }, (_, i) => ({
      rule: "sonarjs/no-x",
      severity: "moderate" as Severity,
      message: `issue ${i}`,
      file: "src/a.ts",
      line: i + 1,
      column: 1,
    }));

    const html = await render([
      reportWith({
        sonar: {
          issues,
          totalCount: issues.length,
          issuesBySeverity: severityMap({ moderate: issues.length }),
        },
      }),
    ]);

    assert.match(
      html,
      /20 of 25/,
      "silently showing a slice of the issues told the reader nothing was missing",
    );
  });
});

describe("remediation", () => {
  it("says nothing for a clean project", () => {
    assert.equal(
      remediation(
        reportWith({
          audit: {
            vulnerabilities: [],
            totalCount: 0,
            fixableCount: 0,
            breakingFixCount: 0,
            bySeverity: emptySeverityMap(),
          },
        }),
      ),
      undefined,
    );
  });

  it("says nothing when the audit failed — the state is unknown", () => {
    assert.equal(
      remediation(
        reportWith({
          audit: {
            vulnerabilities: [],
            totalCount: 1,
            fixableCount: 0,
            breakingFixCount: 0,
            bySeverity: severityMap({ high: 1 }),
            error: "registry unreachable",
          },
        }),
      ),
      undefined,
    );
  });

  it("names --force for npm when only breaking fixes remain", () => {
    const text = remediation(
      reportWith({
        audit: {
          vulnerabilities: [],
          totalCount: 1,
          fixableCount: 0,
          breakingFixCount: 1,
          bySeverity: severityMap({ critical: 1 }),
        },
      }),
    );

    assert.match(text ?? "", /npm audit fix --force/);
    assert.match(text ?? "", /verify the build/);
  });

  it("does not tell a yarn user to run a command yarn does not have", () => {
    const text = remediation(
      reportWith({
        project: projectInfo("/tmp/x", { packageManager: "yarn" }),
      }),
    );

    assert.match(text ?? "", /no non-interactive audit fix/);
    assert.ok(!/audit fix --force/.test(text ?? ""));
  });
});
