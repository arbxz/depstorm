import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advisoryId,
  applyIgnores,
  expiredRules,
  isExpired,
  matchesRule,
  parseIgnoreRules,
} from "../src/ignore.js";
import {
  emptySeverityMap,
  type AuditResult,
  type Severity,
  type Vulnerability,
} from "../src/types.js";
import { silenceLogs } from "./helpers/repo.js";

silenceLogs();

function vuln(
  name: string,
  severity: Severity = "high",
  overrides: Partial<Vulnerability> = {},
): Vulnerability {
  return {
    name,
    severity,
    title: name + " advisory",
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    range: "*",
    fixAvailable: true,
    fixIsBreaking: false,
    ...overrides,
  };
}

function auditOf(
  vulns: Vulnerability[],
  overrides: Partial<AuditResult> = {},
): AuditResult {
  const bySeverity = emptySeverityMap();
  for (const v of vulns) bySeverity[v.severity]++;
  return {
    vulnerabilities: vulns,
    totalCount: vulns.length,
    fixableCount: vulns.filter((v) => v.fixAvailable && !v.fixIsBreaking).length,
    breakingFixCount: vulns.filter((v) => v.fixIsBreaking).length,
    bySeverity,
    ...overrides,
  };
}

describe("advisoryId", () => {
  it("extracts a GHSA id from a GitHub advisory URL", () => {
    assert.equal(
      advisoryId("https://github.com/advisories/GHSA-1234-abcd-5678"),
      "GHSA-1234-ABCD-5678",
    );
  });

  it("extracts a CVE id", () => {
    assert.equal(
      advisoryId("https://nvd.nist.gov/vuln/detail/CVE-2026-12345"),
      "CVE-2026-12345",
    );
  });

  it("falls back to the trailing path segment", () => {
    assert.equal(advisoryId("https://npmjs.com/advisories/1755"), "1755");
  });

  it("returns nothing for a URL with no identifiable part", () => {
    assert.equal(advisoryId(""), undefined);
  });
});

describe("matchesRule", () => {
  it("matches on package name", () => {
    assert.equal(
      matchesRule(vuln("lodash"), { package: "lodash", reason: "r" }),
      true,
    );
    assert.equal(
      matchesRule(vuln("minimist"), { package: "lodash", reason: "r" }),
      false,
    );
  });

  it("matches on advisory id, case-insensitively", () => {
    const v = vuln("lodash", "high", {
      url: "https://github.com/advisories/GHSA-1111-2222-3333",
    });
    assert.equal(
      matchesRule(v, { advisory: "ghsa-1111-2222-3333", reason: "r" }),
      true,
    );
    assert.equal(
      matchesRule(v, { advisory: "GHSA-9999-9999-9999", reason: "r" }),
      false,
    );
  });

  it("requires both to match when both are given", () => {
    const v = vuln("lodash", "high", {
      url: "https://github.com/advisories/GHSA-1111-2222-3333",
    });

    assert.equal(
      matchesRule(v, {
        package: "other",
        advisory: "GHSA-1111-2222-3333",
        reason: "r",
      }),
      false,
      "a narrower rule must not suppress more than a broader one",
    );
  });
});

describe("isExpired", () => {
  const rule = { package: "lodash", reason: "r", expires: "2026-06-30" };

  it("is not expired before the date", () => {
    assert.equal(isExpired(rule, new Date("2026-06-01T00:00:00Z")), false);
  });

  it("covers the whole of the expiry day", () => {
    assert.equal(isExpired(rule, new Date("2026-06-30T23:00:00Z")), false);
  });

  it("is expired the day after", () => {
    assert.equal(isExpired(rule, new Date("2026-07-01T00:00:01Z")), true);
  });

  it("never expires without an expires field", () => {
    assert.equal(
      isExpired({ package: "lodash", reason: "r" }, new Date()),
      false,
    );
  });
});

describe("applyIgnores", () => {
  it("removes matched advisories and recounts everything", () => {
    const result = applyIgnores(
      auditOf([vuln("lodash", "critical"), vuln("minimist", "low")]),
      [{ package: "lodash", reason: "dev-only" }],
    );

    assert.equal(result.totalCount, 1);
    assert.equal(
      result.bySeverity.critical,
      0,
      "the severity breakdown must follow the filter, not the raw parse",
    );
    assert.equal(result.bySeverity.low, 1);
    assert.equal(result.fixableCount, 1);
    assert.deepEqual(
      result.ignored?.map((v) => v.name),
      ["lodash"],
    );
  });

  it("keeps suppressed advisories visible rather than dropping them", () => {
    const result = applyIgnores(auditOf([vuln("lodash")]), [
      { package: "lodash", reason: "accepted" },
    ]);

    assert.equal(result.ignored?.length, 1);
    assert.equal(
      result.vulnerabilities.length,
      0,
      "suppressed means not counted, not never seen",
    );
  });

  it("stops suppressing once a rule has expired", () => {
    const rules = [
      { package: "lodash", reason: "temporary", expires: "2026-01-01" },
    ];

    const before = applyIgnores(
      auditOf([vuln("lodash")]),
      rules,
      new Date("2025-12-01T00:00:00Z"),
    );
    const after = applyIgnores(
      auditOf([vuln("lodash")]),
      rules,
      new Date("2026-02-01T00:00:00Z"),
    );

    assert.equal(before.totalCount, 0);
    assert.equal(
      after.totalCount,
      1,
      "a lapsed suppression must let the advisory back through",
    );
  });

  it("leaves a failed audit untouched", () => {
    const failedAudit = auditOf([], { error: "registry unreachable" });
    const result = applyIgnores(failedAudit, [
      { package: "lodash", reason: "r" },
    ]);

    assert.equal(
      result,
      failedAudit,
      "filtering an unknown state would dress it up as a curated one",
    );
  });

  it("is a no-op with no rules", () => {
    const audit = auditOf([vuln("lodash")]);
    assert.equal(applyIgnores(audit, undefined), audit);
    assert.equal(applyIgnores(audit, []), audit);
  });

  it("does not set ignored when nothing matched", () => {
    const result = applyIgnores(auditOf([vuln("lodash")]), [
      { package: "nothing-here", reason: "r" },
    ]);

    assert.equal(result.ignored, undefined);
  });
});

describe("expiredRules", () => {
  it("lists only the lapsed ones", () => {
    const lapsed = expiredRules(
      [
        { package: "a", reason: "r", expires: "2020-01-01" },
        { package: "b", reason: "r", expires: "2099-01-01" },
        { package: "c", reason: "r" },
      ],
      new Date("2026-01-01T00:00:00Z"),
    );

    assert.deepEqual(
      lapsed.map((r) => r.package),
      ["a"],
    );
  });
});

describe("parseIgnoreRules", () => {
  it("accepts a well-formed rule", () => {
    const { rules, problems } = parseIgnoreRules([
      {
        package: "lodash",
        reason: "dev-only transitive",
        expires: "2026-12-31",
      },
    ]);

    assert.deepEqual(problems, []);
    assert.deepEqual(rules, [
      {
        package: "lodash",
        reason: "dev-only transitive",
        expires: "2026-12-31",
      },
    ]);
  });

  it("requires a reason, so the list stays a record of decisions", () => {
    const { rules, problems } = parseIgnoreRules([{ package: "lodash" }]);

    assert.equal(rules.length, 0);
    assert.match(problems.join("\n"), /needs a "reason"/);
  });

  it("requires something to match on", () => {
    const { problems } = parseIgnoreRules([{ reason: "because" }]);
    assert.match(problems.join("\n"), /"package" or an "advisory"/);
  });

  it("rejects a malformed expiry date", () => {
    assert.match(
      parseIgnoreRules([
        { package: "lodash", reason: "r", expires: "next tuesday" },
      ]).problems.join("\n"),
      /YYYY-MM-DD/,
    );
  });

  it("rejects a calendar-shaped but unreal date", () => {
    assert.match(
      parseIgnoreRules([
        { package: "lodash", reason: "r", expires: "2026-13-45" },
      ]).problems.join("\n"),
      /not a real date/,
    );
  });

  it("reports every fault at once rather than the first", () => {
    const { problems } = parseIgnoreRules([{ package: "a" }, { reason: "b" }]);
    assert.equal(problems.length, 2);
  });

  it("rejects a non-array", () => {
    assert.match(parseIgnoreRules({}).problems.join("\n"), /must be an array/);
  });
});
