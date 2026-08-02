import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import {
  SEVERITY_ORDER,
  type ProjectReport,
  type Severity,
} from "./types.js";

const SEVERITY_COLORS: Record<Severity, string> = {
  info: "\x1b[36m", // cyan
  low: "\x1b[32m", // green
  moderate: "\x1b[33m", // yellow
  high: "\x1b[31m", // red
  critical: "\x1b[35m", // magenta
};
const RESET = "\x1b[0m";

/** Issues detailed per project in the HTML report */
const MAX_SONAR_ROWS = 20;

/**
 * Vulnerabilities a project actually resolved.
 *
 * A reverted fix resolved nothing — its changes were rolled back — so it must
 * not be counted or reported as fixed.
 */
export function effectiveFixedCount(report: ProjectReport): number {
  if (report.reverted) return 0;
  return report.fix?.fixedCount ?? 0;
}

/**
 * Vulnerabilities still outstanding for a project, preferring the post-fix
 * re-audit when one was performed. After a revert the post-fix numbers no
 * longer describe the repository, so the original audit stands.
 */
export function remainingBySeverity(
  report: ProjectReport,
): Record<Severity, number> {
  if (report.reverted) return report.audit.bySeverity;
  return report.fix?.remainingBySeverity ?? report.audit.bySeverity;
}

/**
 * Whether a project still has vulnerabilities at or above a severity.
 * Audit failures count as unresolved — an unknown state is not a pass.
 */
export function hasUnresolvedAtOrAbove(
  report: ProjectReport,
  threshold: Severity,
): boolean {
  if (report.audit.error) return true;
  const level = SEVERITY_ORDER[threshold];
  return Object.entries(remainingBySeverity(report)).some(
    ([severity, count]) =>
      count > 0 && SEVERITY_ORDER[severity as Severity] >= level,
  );
}

function printSeverityCounts(counts: Record<Severity, number>): void {
  for (const [sev, count] of Object.entries(counts)) {
    if (count > 0) {
      const color = SEVERITY_COLORS[sev as Severity];
      console.log(`       ${color}${sev}: ${count}${RESET}`);
    }
  }
}

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

    if (audit.error) {
      // Never render a failed audit as a clean project
      console.log(`    ⛔ AUDIT FAILED — status unknown`);
      console.log(`       ${audit.error}`);
    } else if (audit.totalCount === 0) {
      console.log("    ✅ No vulnerabilities found");
    } else {
      console.log(`    🔍 ${audit.totalCount} vulnerabilities:`);
      printSeverityCounts(audit.bySeverity);
    }

    if (fix) {
      if (fix.applied && reverted) {
        console.log(
          `    ↩️  Fix rolled back — ${fix.fixedCount} vulnerabilit${fix.fixedCount === 1 ? "y" : "ies"} NOT resolved`,
        );
      } else if (fix.applied) {
        const suffix = fix.verified ? "" : " (unverified)";
        console.log(`    🔧 Fixed ${fix.fixedCount} vulnerabilities${suffix}`);
        if (fix.remainingCount > 0) {
          console.log(
            `    ⚠️  ${fix.remainingCount} remaining (manual review needed)`,
          );
        }
      } else if (fix.error) {
        console.log(`    ❌ Fix failed: ${fix.error}`);
      } else {
        console.log(`    ℹ️  No fixes applied — ${fix.skippedReason ?? "n/a"}`);
      }
    }

    if (sonar) {
      if (sonar.error) {
        console.log(`    ⚠️  Code quality check failed: ${sonar.error}`);
      } else if (sonar.totalCount === 0) {
        console.log("    ✅ No code quality issues (SonarJS)");
      } else {
        console.log(`    🔎 ${sonar.totalCount} code quality issue(s):`);
        printSeverityCounts(sonar.issuesBySeverity);
      }
    }

    if (build) {
      if (build.skipped) {
        console.log(`    🏗️  Build: skipped (${build.output})`);
      } else if (build.success) {
        console.log("    🏗️  Build: PASSED");
      } else {
        console.log("    ❌ Build: FAILED");
        if (reverted) console.log("    ↩️  Dependency changes reverted");
      }
    }

    if (report.fixBranch) {
      console.log(`    🌿 Branch: ${report.fixBranch}`);
    }

    console.log();
  }

  const totalVulns = reports.reduce((sum, r) => sum + r.audit.totalCount, 0);
  const totalFixed = reports.reduce(
    (sum, r) => sum + effectiveFixedCount(r),
    0,
  );
  const totalReverted = reports.filter((r) => r.reverted).length;
  const totalFailed = reports.filter(
    (r) => r.build && !r.build.success && !r.build.skipped,
  ).length;
  const totalSonarIssues = reports.reduce(
    (sum, r) => sum + (r.sonar?.totalCount ?? 0),
    0,
  );
  const auditFailures = reports.filter((r) => r.audit.error).length;

  console.log("─".repeat(60));
  console.log(`  Projects scanned: ${reports.length}`);
  console.log(`  Total vulnerabilities: ${totalVulns}`);
  console.log(`  Total fixed: ${totalFixed}`);
  if (auditFailures > 0) {
    console.log(`  ⛔ Audits that failed: ${auditFailures}`);
  }
  if (totalReverted > 0) {
    console.log(`  Reverted (build broke): ${totalReverted}`);
  }
  if (totalFailed > 0) {
    console.log(`  Build failures: ${totalFailed}`);
  }
  if (totalSonarIssues > 0) {
    console.log(`  Code quality issues: ${totalSonarIssues}`);
  }
  console.log("─".repeat(60) + "\n");
}

/**
 * Save report as JSON.
 *
 * Reports contain absolute paths and build output, so they are written with
 * owner-only permissions and should stay out of version control.
 */
export async function saveJsonReport(
  reports: ProjectReport[],
  outputPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(reports, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
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
    (sum, r) => sum + effectiveFixedCount(r),
    0,
  );
  const totalSonarIssues = reports.reduce(
    (sum, r) => sum + (r.sonar?.totalCount ?? 0),
    0,
  );

  const projectRows = reports
    .map((r) => {
      const statusIcon = r.audit.error
        ? "⛔"
        : r.audit.totalCount === 0
          ? "✅"
          : r.reverted
            ? "↩️"
            : r.fix?.applied
              ? "🔧"
              : "⚠️";
      const vulnCell = r.audit.error
        ? `<span title="${escapeHtml(r.audit.error)}">audit failed</span>`
        : String(r.audit.totalCount);
      const fixedCell = r.reverted
        ? "0 (rolled back)"
        : r.fix?.applied
          ? `${r.fix.fixedCount}${r.fix.verified ? "" : " (unverified)"}`
          : "0";
      const buildCell = r.build
        ? r.build.skipped
          ? "—"
          : r.build.success
            ? "✅"
            : "❌"
        : "—";
      const sonarCell = r.sonar
        ? r.sonar.error
          ? "error"
          : r.sonar.totalCount === 0
            ? "✅"
            : `⚠️ ${r.sonar.totalCount}`
        : "—";

      return `<tr>
        <td>${statusIcon} ${escapeHtml(r.project.name)}</td>
        <td>${escapeHtml(r.project.packageManager)}</td>
        <td>${vulnCell}</td>
        <td>${escapeHtml(fixedCell)}</td>
        <td>${buildCell}</td>
        <td>${escapeHtml(sonarCell)}</td>
        <td>${r.reverted ? "Yes" : "—"}</td>
      </tr>`;
    })
    .join("\n");

  const sonarDetailRows = reports
    .flatMap((r) =>
      (r.sonar?.issues ?? []).slice(0, MAX_SONAR_ROWS).map(
        (issue) => `<tr>
          <td>${escapeHtml(r.project.name)}</td>
          <td>${escapeHtml(issue.rule)}</td>
          <td>${escapeHtml(issue.severity)}</td>
          <td>${escapeHtml(issue.file)}:${Number(issue.line) || 0}</td>
          <td>${escapeHtml(issue.message)}</td>
        </tr>`,
      ),
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>DepStorm Report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    h1 { color: #1a1a2e; }
    .summary { display: flex; gap: 2rem; margin: 1rem 0; flex-wrap: wrap; }
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
  <p class="timestamp">${escapeHtml(new Date().toLocaleString())}</p>
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

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, { encoding: "utf-8", mode: 0o600 });
  consola.success(`HTML report saved to ${outputPath}`);
}

/**
 * Escape every character that can break out of text or attribute context.
 * Report content includes package names and linter messages, which are
 * ultimately third-party strings.
 */
function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}
