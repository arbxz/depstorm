import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  backupProjectFiles,
  canAttemptFix,
  cleanupBackups,
  listTouchedFiles,
} from "../src/fix.js";
import {
  emptySeverityMap,
  type AuditResult,
  type Severity,
  type Vulnerability,
} from "../src/types.js";
import {
  cleanupTempDirs,
  fileExists,
  projectInfo,
  readFile,
  silenceLogs,
  tempDir,
  testConfig,
  writeFile,
} from "./helpers/repo.js";

silenceLogs();
after(cleanupTempDirs);

function auditWith(
  severities: Severity[],
  options: { fixable?: number; error?: string } = {},
): AuditResult {
  const vulnerabilities: Vulnerability[] = severities.map((severity, i) => ({
    name: `pkg-${i}`,
    severity,
    title: "t",
    url: "",
    range: "*",
    fixAvailable: i < (options.fixable ?? severities.length),
  }));

  const bySeverity = emptySeverityMap();
  for (const v of vulnerabilities) bySeverity[v.severity]++;

  return {
    vulnerabilities,
    totalCount: vulnerabilities.length,
    fixableCount: vulnerabilities.filter((v) => v.fixAvailable).length,
    bySeverity,
    error: options.error,
  };
}

describe("canAttemptFix", () => {
  const project = projectInfo("/tmp/x");

  it("proceeds when a fixable vulnerability meets the threshold", () => {
    const result = canAttemptFix(
      project,
      auditWith(["high"]),
      testConfig({ severityThreshold: "high" }),
    );

    assert.equal(result.ok, true);
  });

  it("refuses when the audit failed", () => {
    const result = canAttemptFix(
      project,
      auditWith(["critical"], { error: "npm exploded" }),
      testConfig({ severityThreshold: "low" }),
    );

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /Audit failed/);
  });

  it("refuses when autoFix is off", () => {
    const result = canAttemptFix(
      project,
      auditWith(["critical"]),
      testConfig({ autoFix: false }),
    );

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /disabled/);
  });

  it("refuses for yarn, which has no non-interactive fix", () => {
    const result = canAttemptFix(
      projectInfo("/tmp/x", { packageManager: "yarn" }),
      auditWith(["critical"]),
      testConfig({ severityThreshold: "low" }),
    );

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /yarn/);
  });

  it("refuses when nothing reaches the severity threshold", () => {
    const result = canAttemptFix(
      project,
      auditWith(["low", "moderate"]),
      testConfig({ severityThreshold: "high" }),
    );

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /severity/);
  });

  it("proceeds when at least one vulnerability clears the threshold", () => {
    const result = canAttemptFix(
      project,
      auditWith(["low", "critical"]),
      testConfig({ severityThreshold: "high" }),
    );

    assert.equal(result.ok, true);
  });

  it("refuses when nothing is auto-fixable", () => {
    const result = canAttemptFix(
      project,
      auditWith(["critical"], { fixable: 0 }),
      testConfig({ severityThreshold: "high" }),
    );

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /auto-fixable/);
  });
});

describe("listTouchedFiles", () => {
  it("returns only the fix-relevant files that exist", async () => {
    const dir = tempDir();
    writeFile(dir, "package.json", "{}\n");
    writeFile(dir, "pnpm-lock.yaml", "\n");
    writeFile(dir, "README.md", "# nope\n");
    writeFile(dir, "src/index.ts", "export {};\n");

    const touched = await listTouchedFiles(dir);

    assert.deepEqual(touched.sort(), ["package.json", "pnpm-lock.yaml"]);
  });

  it("returns an empty list for a directory with none of them", async () => {
    assert.deepEqual(await listTouchedFiles(tempDir()), []);
  });
});

describe("backupProjectFiles / cleanupBackups", () => {
  it("backs up the manifest and lockfile", async () => {
    const dir = tempDir();
    writeFile(dir, "package.json", '{"name":"a"}\n');
    writeFile(dir, "package-lock.json", '{"v":1}\n');

    const backups = await backupProjectFiles(dir);

    assert.equal(backups.length, 2);
    assert.equal(fileExists(dir, "package.json.depstorm-backup"), true);
    assert.equal(
      readFile(dir, "package-lock.json.depstorm-backup"),
      '{"v":1}\n',
    );
  });

  it("removes every backup it created", async () => {
    const dir = tempDir();
    writeFile(dir, "package.json", "{}\n");
    writeFile(dir, "package-lock.json", "{}\n");

    const backups = await backupProjectFiles(dir);
    await cleanupBackups(backups);

    assert.equal(fileExists(dir, "package.json.depstorm-backup"), false);
    assert.equal(fileExists(dir, "package-lock.json.depstorm-backup"), false);
    assert.equal(fileExists(dir, "package.json"), true);
  });

  it("tolerates a backup that is already gone", async () => {
    const dir = tempDir();
    writeFile(dir, "package.json", "{}\n");

    const backups = await backupProjectFiles(dir);
    await cleanupBackups(backups);
    await cleanupBackups(backups); // must not throw
  });
});
