import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import type { ProjectReport, Severity, SonarResult } from "./types.js";

const SEVERITY_COLORS: Record<Severity, string> = {
  info: "\x1b[36m", // cyan
  low: "\x1b[32m", // green
  moderate: "\x1b[33m", // yellow
  high: "\x1b[31m", // red
  critical: "\x1b[35m", // magenta
};
const RESET = "\x1b[0m";

/**
 * Print a summary to the console
 */
export function printSummary(reports: ProjectReport[]): void {
  console.log("\n" + "=".repeat(60));
  console.log("  DEPSTORM — AUDIT REPORT");
  console.log("  " + new Date().toLocaleString());
  console.log("=".repeat(60) + "\n");

  if (reports.length === 0) {
    console.log("  No projects processed.\n");
    return;
  }

  for (const report of reports) {
    const { project, audit, sonar, fix, build, reverted } = report;

    console.log(`─── ${project.name} (${project.packageManager}) ───`);
    console.log(`    Path: ${project.path}`);

    // Audit summary
    if (audit.totalCount === 0) {
      console.log("    ✅ No vulnerabilities found");
    } else {
      console.log(`    🔍 ${audit.totalCount} vulnerabilities:`);
      for (const [sev, count] of Object.entries(audit.bySeverity)) {
        if (count > 0) {
          const color = SEVERITY_COLORS[sev as Severity];
          console.log(`       ${color}${sev}: ${count}${RESET}`);
        }
      }
    }

    // Fix summary
    if (fix) {
      if (fix.applied) {
        console.log(`    🔧 Fixed ${fix.fixedCount} vulnerabilities`);
        if (fix.remainingCount > 0) {
          console.log(
            `    ⚠️  ${fix.remainingCount} remaining (manual review needed)`,
          );
        }
      } else if (fix.error) {
        console.log(`    ❌ Fix failed: ${fix.error}`);
      } else {
        console.log("    ℹ️  No fixes applied");
      }
    }

    // Sonar summary
    if (sonar) {
      if (sonar.totalCount === 0) {
        console.log("    ✅ No code quality issues (SonarJS)");
      } else {
        console.log(`    🔎 ${sonar.totalCount} code quality issue(s):`);
        for (const [sev, count] of Object.entries(sonar.issuesBySeverity)) {
          if (count > 0) {
            const color = SEVERITY_COLORS[sev as Severity];
            console.log(`       ${color}${sev}: ${count}${RESET}`);
          }
        }
      }
    }

    // Build summary
    if (build) {
      if (build.success) {
        console.log("    🏗️  Build: PASSED");
      } else {
        console.log("    ❌ Build: FAILED");
        if (reverted) {
          console.log("    ↩️  Changes reverted");
        }
      }
    }

    console.log();
  }

  // Totals
  const totalVulns = reports.reduce((sum, r) => sum + r.audit.totalCount, 0);
  const totalFixed = reports.reduce(
    (sum, r) => sum + (r.fix?.fixedCount ?? 0),
    0,
  );
  const totalFailed = reports.filter((r) => r.build && !r.build.success).length;
  const totalSonarIssues = reports.reduce(
    (sum, r) => sum + (r.sonar?.totalCount ?? 0),
    0,
  );

  console.log("─".repeat(60));
  console.log(`  Projects scanned: ${reports.length}`);
  console.log(`  Total vulnerabilities: ${totalVulns}`);
  console.log(`  Total fixed: ${totalFixed}`);
  if (totalFailed > 0) {
    console.log(`  Build failures: ${totalFailed}`);
  }
  if (totalSonarIssues > 0) {
    console.log(`  Code quality issues: ${totalSonarIssues}`);
  }
  console.log("─".repeat(60) + "\n");
}

/**
 * Save report as JSON
 */
export async function saveJsonReport(
  reports: ProjectReport[],
  outputPath: string,
): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(reports, null, 2), "utf-8");
  consola.success(`Report saved to ${outputPath}`);
}

/**
 * Save report as HTML
 */
export async function saveHtmlReport(
  reports: ProjectReport[],
  outputPath: string,
): Promise<void> {
  const totalVulns = reports.reduce((sum, r) => sum + r.audit.totalCount, 0);
  const totalFixed = reports.reduce(
    (sum, r) => sum + (r.fix?.fixedCount ?? 0),
    0,
  );
  const totalSonarIssues = reports.reduce(
    (sum, r) => sum + (r.sonar?.totalCount ?? 0),
    0,
  );

  const projectRows = reports
    .map((r) => {
      const statusIcon =
        r.audit.totalCount === 0 ? "✅" : r.fix?.applied ? "🔧" : "⚠️";
      const buildIcon = r.build ? (r.build.success ? "✅" : "❌") : "—";
      const sonarIcon = r.sonar
        ? r.sonar.totalCount === 0
          ? "✅"
          : `⚠️ ${r.sonar.totalCount}`
        : "—";

      return `<tr>
        <td>${statusIcon} ${escapeHtml(r.project.name)}</td>
        <td>${r.project.packageManager}</td>
        <td>${r.audit.totalCount}</td>
        <td>${r.fix?.fixedCount ?? 0}</td>
        <td>${buildIcon}</td>
        <td>${sonarIcon}</td>
        <td>${r.reverted ? "Yes" : "—"}</td>
      </tr>`;
    })
    .join("\n");

  const sonarDetailRows = reports
    .filter((r) => r.sonar && r.sonar.totalCount > 0)
    .flatMap((r) =>
      (r.sonar as SonarResult).issues.slice(0, 20).map(
        (issue) => `<tr>
          <td>${escapeHtml(r.project.name)}</td>
          <td>${escapeHtml(issue.rule)}</td>
          <td>${escapeHtml(issue.severity)}</td>
          <td>${escapeHtml(issue.file)}:${issue.line}</td>
          <td>${escapeHtml(issue.message)}</td>
        </tr>`,
      ),
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DepStorm Report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    h1 { color: #1a1a2e; }
    .summary { display: flex; gap: 2rem; margin: 1rem 0; }
    .stat { background: #f0f0f5; padding: 1rem 1.5rem; border-radius: 8px; }
    .stat strong { display: block; font-size: 1.5rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e0e0e0; }
    th { background: #1a1a2e; color: white; }
    tr:hover { background: #f5f5fa; }
    .timestamp { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>⚡ DepStorm Report</h1>
  <p class="timestamp">${new Date().toLocaleString()}</p>
  <div class="summary">
    <div class="stat"><strong>${reports.length}</strong> Projects</div>
    <div class="stat"><strong>${totalVulns}</strong> Vulnerabilities</div>
    <div class="stat"><strong>${totalFixed}</strong> Fixed</div>
    <div class="stat"><strong>${totalSonarIssues}</strong> Code Issues</div>
  </div>
  <table>
    <thead>
      <tr><th>Project</th><th>PM</th><th>Vulns</th><th>Fixed</th><th>Build</th><th>Code Quality</th><th>Reverted</th></tr>
    </thead>
    <tbody>
      ${projectRows}
    </tbody>
  </table>
  ${
    sonarDetailRows
      ? `
  <h2>🔎 Code Quality Issues (SonarJS)</h2>
  <table>
    <thead>
      <tr><th>Project</th><th>Rule</th><th>Severity</th><th>Location</th><th>Message</th></tr>
    </thead>
    <tbody>
      ${sonarDetailRows}
    </tbody>
  </table>`
      : ""
  }
</body>
</html>`;

  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(outputPath, html, "utf-8");
  consola.success(`HTML report saved to ${outputPath}`);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
