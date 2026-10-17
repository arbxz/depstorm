import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseNpmAudit,
  parsePnpmAudit,
  parseYarnAudit,
  parseYarnBerryAudit,
  runAudit,
} from "../src/audit.js";
import {
  cleanupTempDirs,
  projectInfo,
  silenceLogs,
  tempDir,
  writeJson,
} from "./helpers/repo.js";

silenceLogs();
after(cleanupTempDirs);

describe("parseNpmAudit", () => {
  it("reads severity, fixability and advisory detail", () => {
    const vulns = parseNpmAudit({
      vulnerabilities: {
        lodash: {
          severity: "critical",
          title: "Prototype Pollution",
          url: "https://example.test/1",
          range: "<4.17.21",
          fixAvailable: true,
        },
      },
    });

    assert.equal(vulns.length, 1);
    assert.deepEqual(vulns[0], {
      name: "lodash",
      severity: "critical",
      title: "Prototype Pollution",
      url: "https://example.test/1",
      range: "<4.17.21",
      fixAvailable: true,
      fixIsBreaking: false,
    });
  });

  it("records which packages an advisory-less entry inherits from", () => {
    const vulns = parseNpmAudit({
      vulnerabilities: {
        "sprintf-js": {
          severity: "moderate",
          via: [{ title: "DoS", url: "https://github.com/advisories/GHSA-hp3w-g68c-fv3c" }],
        },
        roarr: { severity: "moderate", via: ["sprintf-js"] },
      },
    });

    assert.equal(vulns[0]?.inheritedFrom, undefined);
    assert.deepEqual(vulns[1]?.inheritedFrom, ["sprintf-js"]);
  });

  it("treats a non-major object fixAvailable as plainly fixable", () => {
    const [vuln] = parseNpmAudit({
      vulnerabilities: {
        pkg: {
          severity: "high",
          fixAvailable: { name: "pkg", version: "2.0.0" },
        },
      },
    });

    assert.equal(vuln?.fixAvailable, true);
    assert.equal(vuln?.fixIsBreaking, false);
  });

  it("flags a semver-major remedy as breaking", () => {
    const [vuln] = parseNpmAudit({
      vulnerabilities: {
        pkg: {
          severity: "high",
          fixAvailable: { name: "pkg", version: "3.0.0", isSemVerMajor: true },
        },
      },
    });

    assert.equal(
      vuln?.fixAvailable,
      true,
      "a fix does exist — it just is not one `audit fix` will take",
    );
    assert.equal(vuln?.fixIsBreaking, true);
  });

  it("falls back to the nested `via` advisory for transitive vulnerabilities", () => {
    const [vuln] = parseNpmAudit({
      vulnerabilities: {
        transitive: {
          fixAvailable: false,
          via: [
            { title: "Nested advisory", url: "https://example.test/2", severity: "moderate" },
          ],
        },
      },
    });

    assert.equal(vuln?.title, "Nested advisory");
    assert.equal(vuln?.severity, "moderate");
    assert.equal(vuln?.url, "https://example.test/2");
  });

  it("coerces an unknown severity to info rather than corrupting the counts", () => {
    const [vuln] = parseNpmAudit({
      vulnerabilities: { weird: { severity: "SUPER-BAD", fixAvailable: true } },
    });

    assert.equal(vuln?.severity, "info");
  });

  it("returns nothing for an empty report", () => {
    assert.deepEqual(parseNpmAudit({}), []);
    assert.deepEqual(parseNpmAudit({ vulnerabilities: {} }), []);
  });
});

describe("parsePnpmAudit", () => {
  it("maps advisories and treats patched_versions as fixable", () => {
    const vulns = parsePnpmAudit({
      advisories: {
        "1234": {
          module_name: "minimist",
          severity: "moderate",
          title: "Prototype Pollution",
          url: "https://example.test/3",
          vulnerable_versions: "<1.2.6",
          patched_versions: ">=1.2.6",
        },
        "5678": {
          module_name: "unfixable",
          severity: "low",
          vulnerable_versions: "*",
        },
      },
    });

    assert.equal(vulns.length, 2);
    assert.equal(vulns[0]?.fixAvailable, true);
    assert.equal(vulns[1]?.fixAvailable, false);
    assert.equal(vulns[0]?.range, "<1.2.6");
  });
});

describe("parseYarnAudit", () => {
  const advisory = (name: string, severity: string) =>
    JSON.stringify({
      type: "auditAdvisory",
      data: {
        advisory: {
          module_name: name,
          severity,
          title: `${name} issue`,
          url: `https://example.test/${name}`,
          vulnerable_versions: "<1.0.0",
          patched_versions: ">=1.0.0",
        },
      },
    });

  it("extracts advisories from NDJSON", () => {
    const stdout = [
      JSON.stringify({ type: "info", data: "starting" }),
      advisory("left-pad", "high"),
      advisory("minimist", "moderate"),
      JSON.stringify({ type: "auditSummary", data: { vulnerabilities: {} } }),
    ].join("\n");

    const vulns = parseYarnAudit(stdout);

    assert.deepEqual(
      vulns.map((v) => v.name).sort(),
      ["left-pad", "minimist"],
      "the summary-only parse used to return an empty list with a non-zero count",
    );
    assert.equal(vulns[0]?.severity, "high");
  });

  it("deduplicates advisories repeated per dependency path", () => {
    const stdout = [advisory("left-pad", "high"), advisory("left-pad", "high")].join("\n");

    assert.equal(parseYarnAudit(stdout).length, 1);
  });

  it("marks everything unfixable because yarn has no non-interactive fix", () => {
    const vulns = parseYarnAudit(advisory("left-pad", "high"));

    assert.equal(vulns[0]?.fixAvailable, false);
  });

  it("ignores malformed and non-JSON lines", () => {
    const stdout = ["not json at all", "{ broken", "", advisory("ok", "low")].join("\n");

    assert.equal(parseYarnAudit(stdout).length, 1);
  });
});

describe("fixability counting", () => {
  it("keeps breaking remedies out of fixableCount", () => {
    const vulns = parseNpmAudit({
      vulnerabilities: {
        a: { severity: "high", fixAvailable: true },
        b: {
          severity: "critical",
          fixAvailable: { name: "b", version: "9.0.0", isSemVerMajor: true },
        },
        c: { severity: "low", fixAvailable: false },
      },
    });

    const fixable = vulns.filter((v) => v.fixAvailable && !v.fixIsBreaking);
    const breaking = vulns.filter((v) => v.fixIsBreaking);

    assert.equal(fixable.length, 1);
    assert.equal(breaking.length, 1);
    assert.equal(
      vulns.filter((v) => v.fixAvailable).length,
      2,
      "the raw fixAvailable count is what used to be reported, and it over-promised",
    );
  });
});

describe("runAudit failure handling", () => {
  it("reports an error instead of a clean result when the tool is missing", async () => {
    const dir = tempDir();
    writeJson(dir, "package.json", { name: "x" });

    const result = await runAudit(
      projectInfo(dir, {
        // A package manager that does not exist on any machine
        packageManager: "definitely-not-a-real-pm" as never,
      }),
      { quiet: true },
    );

    assert.ok(result.error, "a failed audit must carry an error");
    assert.equal(result.totalCount, 0);
    assert.equal(
      result.vulnerabilities.length,
      0,
      "counts are meaningless when error is set — the report must not claim clean",
    );
  });
});

describe("parseYarnBerryAudit", () => {
  const entry = (name: string, severity: string) =>
    JSON.stringify({
      value: name,
      children: {
        ID: 1234,
        Issue: `${name} is vulnerable`,
        URL: `https://example.test/${name}`,
        Severity: severity,
        "Vulnerable Versions": "<1.0.0",
        "Tree Versions": ["0.9.0"],
      },
    });

  it("reads Berry's package-keyed NDJSON", () => {
    const vulns = parseYarnBerryAudit(
      [entry("lodash", "high"), entry("minimist", "moderate")].join("\n"),
    );

    assert.deepEqual(vulns.map((v) => v.name), ["lodash", "minimist"]);
    assert.equal(vulns[0]?.severity, "high");
    assert.equal(vulns[0]?.title, "lodash is vulnerable");
    assert.equal(vulns[0]?.url, "https://example.test/lodash");
    assert.equal(vulns[0]?.range, "<1.0.0");
  });

  it("marks everything unfixable — Berry has no non-interactive fix either", () => {
    const [vuln] = parseYarnBerryAudit(entry("lodash", "critical"));

    assert.equal(vuln?.fixAvailable, false);
    assert.equal(vuln?.fixIsBreaking, false);
  });

  it("deduplicates repeated entries", () => {
    assert.equal(
      parseYarnBerryAudit([entry("lodash", "high"), entry("lodash", "high")].join("\n")).length,
      1,
    );
  });

  it("ignores malformed lines and entries with no children", () => {
    const stdout = [
      "not json",
      "{ broken",
      JSON.stringify({ value: "lodash" }),
      entry("ok", "low"),
    ].join("\n");

    assert.equal(parseYarnBerryAudit(stdout).length, 1);
  });

  it("coerces an unrecognised severity to info", () => {
    const [vuln] = parseYarnBerryAudit(entry("weird", "CATASTROPHIC"));
    assert.equal(vuln?.severity, "info");
  });
});
