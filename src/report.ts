import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import {
  SEVERITY_ORDER,
  emptySeverityMap,
  type ProjectReport,
  type RestoreStashResult,
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

/**
 * Describe a stash that could not be put back.
 *
 * This is the user's own work in progress, so it gets plain language and a
 * recovery command rather than a status word.
 */
export function describeStashFailure(
  result: Exclude<RestoreStashResult, { ok: true }>,
): string {
  switch (result.reason) {
    case "conflict":
      return `YOUR STASHED WORK CONFLICTED — conflict markers are in ${result.conflicts.join(", ")}. The stash was kept; resolve them, then run: git stash drop`;
    case "missing":
      return `YOUR STASHED WORK WAS NOT FOUND — depstorm's stash is no longer in the list. Check: git stash list`;
    case "error":
      return `YOUR STASHED WORK COULD NOT BE RESTORED — ${result.message}. It is still in: git stash list`;
  }
}

/**
 * Whether a run left something a human has to deal with, and what.
 *
 * Kept next to the other reporting predicates so the console summary, the
 * HTML report and the exit code all agree on what counts as a failure —
 * "reported it in the log" is not the same as "the run succeeded".
 */
export function operationalFailure(
  report: ProjectReport,
): string | undefined {
  if (report.stashRestore && !report.stashRestore.ok) {
    return describeStashFailure(report.stashRestore);
  }
  if (report.audit.error) return `audit failed — ${report.audit.error}`;
  if (report.fix?.error) return `fix failed — ${report.fix.error}`;
  if (report.revertIncomplete) {
    return `revert incomplete — ${report.revertIncomplete}`;
  }
  return undefined;
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
    } else if (audit.coveredBy) {
      console.log(`    📦 Covered by workspace — not audited separately`);
      console.log(`       ${audit.coveredBy}`);
    } else if (audit.totalCount === 0) {
      console.log("    ✅ No vulnerabilities found");
    } else {
      console.log(`    🔍 ${audit.totalCount} vulnerabilities:`);
      printSeverityCounts(audit.bySeverity);
    }

    if (audit.breakingFixCount > 0) {
      console.log(
        `    ⬆️  ${audit.breakingFixCount} need a semver-major upgrade (audit fix will not apply these)`,
      );
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

    if (report.stashRestore && !report.stashRestore.ok) {
      console.log(`    🚨 ${describeStashFailure(report.stashRestore)}`);
    }

    if (report.revertIncomplete) {
      // The manifest is back but node_modules is not — the checkout is in a
      // state no other message here describes, so it gets its own line.
      console.log(
        `    🚨 REVERT INCOMPLETE — run "${project.packageManager} install" in this project`,
      );
      console.log(`       ${report.revertIncomplete}`);
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
  const workspaceCovered = reports.filter((r) => r.audit.coveredBy).length;

  console.log("─".repeat(60));
  console.log(`  Projects scanned: ${reports.length}`);
  console.log(`  Total vulnerabilities: ${totalVulns}`);
  console.log(`  Total fixed: ${totalFixed}`);
  if (auditFailures > 0) {
    console.log(`  ⛔ Audits that failed: ${auditFailures}`);
  }
  if (workspaceCovered > 0) {
    console.log(`  📦 Covered by a workspace root: ${workspaceCovered}`);
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
/**
 * Severity is a *status* scale, so it uses the reserved status steps rather
 * than categorical series colors. These are fixed in both themes. Every use
 * pairs the color with the severity's name and count — a status color must
 * never carry meaning on its own, which also covers the red/orange pairs that
 * collapse under protanopia.
 */
const SEVERITY_HEX: Record<Severity, string> = {
  critical: "#d03b3b",
  high: "#ec835a",
  moderate: "#fab219",
  low: "#0ca30c",
  info: "#8a8880",
};

const SEVERITY_DESC: Severity[] = ["critical", "high", "moderate", "low", "info"];

/** Vulnerability rows detailed per project in the HTML report */
const MAX_VULN_ROWS = 50;

type ProjectStatus =
  | "failed"
  | "covered"
  | "clean"
  | "reverted"
  | "fixed"
  | "outstanding";

function projectStatus(r: ProjectReport): ProjectStatus {
  if (r.audit.error) return "failed";
  if (r.audit.coveredBy) return "covered";
  if (r.audit.totalCount === 0) return "clean";
  if (r.reverted) return "reverted";
  if (r.fix?.applied) return "fixed";
  return "outstanding";
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
  failed: "Audit failed",
  covered: "Covered by workspace",
  clean: "Clean",
  reverted: "Reverted",
  fixed: "Fixed",
  outstanding: "Outstanding",
};

const STATUS_ICON: Record<ProjectStatus, string> = {
  failed: "⛔",
  covered: "📦",
  clean: "✅",
  reverted: "↩️",
  fixed: "🔧",
  outstanding: "⚠️",
};

/** A stacked bar of severity counts. Segments carry a 2px surface gap. */
function severityBar(counts: Record<Severity, number>): string {
  const total = SEVERITY_DESC.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  if (total === 0) return "";

  const segments = SEVERITY_DESC.filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => {
      const pct = ((counts[s] ?? 0) / total) * 100;
      return `<span class="seg" style="width:${pct.toFixed(3)}%;background:${SEVERITY_HEX[s]}" title="${escapeHtml(s)}: ${counts[s]}"></span>`;
    })
    .join("");

  return `<div class="bar" role="img" aria-label="${escapeHtml(
    SEVERITY_DESC.filter((s) => (counts[s] ?? 0) > 0)
      .map((s) => `${s} ${counts[s]}`)
      .join(", "),
  )}">${segments}</div>`;
}

/** Legend + counts. The label is what carries meaning; color is the echo. */
function severityLegend(counts: Record<Severity, number>): string {
  const present = SEVERITY_DESC.filter((s) => (counts[s] ?? 0) > 0);
  if (present.length === 0) return "";
  return `<ul class="legend">${present
    .map(
      (s) =>
        `<li><span class="dot" style="background:${SEVERITY_HEX[s]}"></span>${escapeHtml(s)} <strong>${counts[s]}</strong></li>`,
    )
    .join("")}</ul>`;
}

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

  const overall = emptySeverityMap();
  let totalRemaining = 0;
  for (const r of reports) {
    const remaining = remainingBySeverity(r);
    for (const s of SEVERITY_DESC) {
      overall[s] += remaining[s] ?? 0;
      totalRemaining += remaining[s] ?? 0;
    }
  }

  const auditFailures = reports.filter((r) => r.audit.error).length;
  const covered = reports.filter((r) => r.audit.coveredBy).length;

  const rows = reports
    .map((r, i) => {
      const status = projectStatus(r);
      const remaining = remainingBySeverity(r);
      const fixed = effectiveFixedCount(r);
      const vulns = r.audit.vulnerabilities ?? [];

      const vulnCell = r.audit.error
        ? `<span class="muted" title="${escapeHtml(r.audit.error)}">unknown</span>`
        : r.audit.coveredBy
          ? `<span class="muted" title="${escapeHtml(r.audit.coveredBy)}">covered</span>`
          : String(r.audit.totalCount);

      const fixedCell = r.reverted
        ? `0 <span class="muted">(rolled back)</span>`
        : r.fix?.applied
          ? `${r.fix.fixedCount}${r.fix.verified ? "" : ` <span class="muted">(unverified)</span>`}`
          : "0";

      const buildCell = r.build
        ? r.build.skipped
          ? `<span class="muted">—</span>`
          : r.build.success
            ? `<span class="ok">passed</span>`
            : `<span class="bad">failed</span>`
        : `<span class="muted">—</span>`;

      const detail = vulns.length
        ? `<table class="sub">
             <thead><tr><th>Package</th><th>Severity</th><th>Vulnerable range</th><th>Advisory</th><th>Fix</th></tr></thead>
             <tbody>
               ${vulns
                 .slice(0, MAX_VULN_ROWS)
                 .map(
                   (v) => `<tr>
                     <td><code>${escapeHtml(v.name)}</code></td>
                     <td><span class="pill" style="--pill:${SEVERITY_HEX[v.severity] ?? SEVERITY_HEX.info}">${escapeHtml(v.severity)}</span></td>
                     <td><code>${escapeHtml(v.range)}</code></td>
                     <td>${escapeHtml(v.title)}</td>
                     <td>${
                       v.fixIsBreaking
                         ? `<span class="bad" title="Only a semver-major upgrade resolves this — audit fix will not apply it">breaking</span>`
                         : v.fixAvailable
                           ? `<span class="ok">available</span>`
                           : `<span class="muted">none</span>`
                     }</td>
                   </tr>`,
                 )
                 .join("")}
             </tbody>
           </table>
           ${
             vulns.length > MAX_VULN_ROWS
               ? `<p class="muted note">Showing ${MAX_VULN_ROWS} of ${vulns.length}. The full list is in the JSON report.</p>`
               : ""
           }`
        : r.audit.error
          ? `<p class="note bad">${escapeHtml(r.audit.error)}</p>`
          : r.audit.coveredBy
            ? `<p class="note muted">Dependencies resolve through the workspace at <code>${escapeHtml(r.audit.coveredBy)}</code>, which is audited in its own right.</p>`
            : `<p class="note muted">No vulnerabilities recorded.</p>`;

      const buildError =
        r.build && !r.build.success && !r.build.skipped && r.build.error
          ? `<pre class="build">${escapeHtml(r.build.error)}</pre>`
          : "";

      // Anything that left the checkout needing manual attention leads the
      // detail panel — it matters more than the vulnerability table below it.
      const alerts = [
        r.stashRestore && !r.stashRestore.ok
          ? describeStashFailure(r.stashRestore)
          : "",
        r.revertIncomplete
          ? `REVERT INCOMPLETE — the manifest and lockfile are restored but node_modules is not. Run "${r.project.packageManager} install" here. ${r.revertIncomplete}`
          : "",
      ]
        .filter(Boolean)
        .map((text) => `<p class="note bad alert">${escapeHtml(text)}</p>`)
        .join("");

      return `<tbody class="row" data-status="${status}" data-name="${escapeHtml(r.project.name)}" data-path="${escapeHtml(r.project.path)}" data-vulns="${r.audit.totalCount}" data-fixed="${fixed}" data-remaining="${SEVERITY_DESC.reduce((s, k) => s + (remaining[k] ?? 0), 0)}">
        <tr class="head" tabindex="0" role="button" aria-expanded="false" aria-controls="d${i}">
          <td class="name">
            <span class="chev" aria-hidden="true">▸</span>
            <span class="icon" aria-hidden="true">${STATUS_ICON[status]}</span>
            <span>
              ${escapeHtml(r.project.name)}
              <span class="path">${escapeHtml(r.project.path)}</span>
            </span>
          </td>
          <td>${escapeHtml(r.project.packageManager)}</td>
          <td class="num">${vulnCell}</td>
          <td class="num">${fixedCell}</td>
          <td>${buildCell}</td>
          <td class="sev">${severityBar(remaining)}</td>
          <td><span class="status s-${status}">${STATUS_LABEL[status]}</span></td>
        </tr>
        <tr class="detail" id="d${i}" hidden><td colspan="7">${alerts}${buildError}${detail}</td></tr>
      </tbody>`;
    })
    .join("\n");

  const sonarDetailRows = reports
    .flatMap((r) =>
      (r.sonar?.issues ?? []).slice(0, MAX_SONAR_ROWS).map(
        (issue) => `<tr>
          <td>${escapeHtml(r.project.name)}</td>
          <td><code>${escapeHtml(issue.rule)}</code></td>
          <td>${escapeHtml(issue.severity)}</td>
          <td><code>${escapeHtml(issue.file)}:${Number(issue.line) || 0}</code></td>
          <td>${escapeHtml(issue.message)}</td>
        </tr>`,
      ),
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>depstorm report</title>
  <style>
    :root {
      color-scheme: light;
      --surface: #fcfcfb;
      --panel: #ffffff;
      --raised: #f4f4f1;
      --border: #e2e1dc;
      --text: #14140f;
      --text-2: #52514e;
      --muted: #86857e;
      --ok: #0ca30c;
      --bad: #d03b3b;
      --accent: #2a78d6;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
        --surface: #1a1a19;
        --panel: #222221;
        --raised: #2b2b29;
        --border: #383835;
        --text: #ffffff;
        --text-2: #c3c2b7;
        --muted: #8f8e86;
        --ok: #3cbf3c;
        --bad: #e66767;
        --accent: #3987e5;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1.25rem 4rem;
      background: var(--surface);
      color: var(--text);
      font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 1180px; margin: 0 auto; }
    header { margin-bottom: 1.75rem; }
    h1 { margin: 0 0 .2rem; font-size: 1.5rem; letter-spacing: -.02em; }
    h2 { margin: 2.5rem 0 .85rem; font-size: 1.05rem; letter-spacing: -.01em; }
    .stamp { margin: 0; color: var(--muted); font-size: .85rem; }

    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .75rem; margin: 1.5rem 0; }
    .tile { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: .85rem 1rem; }
    .tile b { display: block; font-size: 1.75rem; font-weight: 650; letter-spacing: -.03em; line-height: 1.15; font-variant-numeric: tabular-nums; }
    .tile span { color: var(--text-2); font-size: .8rem; }
    .tile.warn b { color: var(--bad); }

    .dist { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; }
    .dist h3 { margin: 0 0 .7rem; font-size: .85rem; font-weight: 600; color: var(--text-2); }
    .bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--raised); gap: 2px; }
    .bar .seg { display: block; min-width: 3px; }
    .legend { display: flex; flex-wrap: wrap; gap: .3rem 1.1rem; list-style: none; margin: .7rem 0 0; padding: 0; font-size: .82rem; color: var(--text-2); }
    .legend li { display: flex; align-items: center; gap: .4rem; }
    .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }

    .controls { display: flex; flex-wrap: wrap; gap: .6rem; margin: 2rem 0 .85rem; align-items: center; }
    input[type=search], select {
      font: inherit; font-size: .88rem; color: var(--text); background: var(--panel);
      border: 1px solid var(--border); border-radius: 8px; padding: .45rem .6rem;
    }
    input[type=search] { flex: 1 1 240px; min-width: 0; }
    input[type=search]:focus-visible, select:focus-visible, .head:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .count { color: var(--muted); font-size: .82rem; margin-left: auto; }

    .scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
    table.main { width: 100%; border-collapse: collapse; min-width: 900px; }
    table.main th {
      text-align: left; font-size: .74rem; text-transform: uppercase; letter-spacing: .06em;
      color: var(--muted); font-weight: 600; padding: .7rem .8rem; border-bottom: 1px solid var(--border);
      background: var(--raised); white-space: nowrap; cursor: pointer; user-select: none;
    }
    table.main th[aria-sort=ascending]::after { content: " ▲"; }
    table.main th[aria-sort=descending]::after { content: " ▼"; }
    table.main td { padding: .7rem .8rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tbody.row:last-child tr:last-child td { border-bottom: 0; }
    .head { cursor: pointer; }
    .head:hover td { background: var(--raised); }
    .name { display: flex; align-items: flex-start; gap: .5rem; }
    .name .path { display: block; color: var(--muted); font-size: .76rem; word-break: break-all; }
    .chev { color: var(--muted); transition: transform .12s ease; line-height: 1.5; }
    .row.open .chev { transform: rotate(90deg); }
    .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .sev { width: 190px; min-width: 150px; }
    .muted { color: var(--muted); }
    .ok { color: var(--ok); }
    .bad { color: var(--bad); }

    .status { font-size: .78rem; white-space: nowrap; padding: .16rem .45rem; border-radius: 999px; border: 1px solid var(--border); color: var(--text-2); }
    .s-fixed { color: var(--ok); }
    .s-failed, .s-reverted { color: var(--bad); }

    .detail td { background: var(--raised); padding: 1rem; }
    table.sub { width: 100%; border-collapse: collapse; font-size: .85rem; }
    table.sub th { text-align: left; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); padding: .35rem .5rem; border-bottom: 1px solid var(--border); }
    table.sub td { padding: .38rem .5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    table.sub tr:last-child td { border-bottom: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
    .pill { font-size: .74rem; padding: .1rem .45rem; border-radius: 999px; white-space: nowrap; color: var(--text); border: 1px solid var(--pill); box-shadow: inset 0 0 0 999px color-mix(in srgb, var(--pill) 18%, transparent); }
    .note { margin: 0; font-size: .85rem; }
    .alert { margin: 0 0 .85rem; padding: .6rem .75rem; border: 1px solid var(--bad); border-radius: 8px; font-weight: 600; }
    pre.build { margin: 0 0 .85rem; padding: .7rem .8rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; font-size: .8rem; color: var(--text-2); white-space: pre-wrap; }
    .empty { padding: 2rem; text-align: center; color: var(--muted); }
    footer { margin-top: 2.5rem; color: var(--muted); font-size: .78rem; }
  </style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>⚡ depstorm report</h1>
    <p class="stamp">${escapeHtml(new Date().toLocaleString())}</p>
  </header>

  <div class="tiles">
    <div class="tile"><b>${reports.length}</b><span>Projects</span></div>
    <div class="tile"><b>${totalVulns}</b><span>Vulnerabilities found</span></div>
    <div class="tile"><b>${totalFixed}</b><span>Fixed</span></div>
    <div class="tile${totalRemaining > 0 ? " warn" : ""}"><b>${totalRemaining}</b><span>Still outstanding</span></div>
    <div class="tile"><b>${totalSonarIssues}</b><span>Code quality issues</span></div>
    ${auditFailures > 0 ? `<div class="tile warn"><b>${auditFailures}</b><span>Audits failed</span></div>` : ""}
    ${covered > 0 ? `<div class="tile"><b>${covered}</b><span>Covered by workspace</span></div>` : ""}
  </div>

  ${
    totalRemaining > 0
      ? `<div class="dist">
    <h3>Outstanding by severity</h3>
    ${severityBar(overall)}
    ${severityLegend(overall)}
  </div>`
      : ""
  }

  <h2>Projects</h2>
  <div class="controls">
    <input type="search" id="q" placeholder="Search project or path…" aria-label="Search projects">
    <select id="status" aria-label="Filter by status">
      <option value="">All statuses</option>
      <option value="outstanding">Outstanding</option>
      <option value="fixed">Fixed</option>
      <option value="reverted">Reverted</option>
      <option value="failed">Audit failed</option>
      <option value="covered">Covered by workspace</option>
      <option value="clean">Clean</option>
    </select>
    <span class="count" id="count"></span>
  </div>

  <div class="scroll">
    <table class="main" id="tbl">
      <thead><tr>
        <th data-sort="name">Project</th>
        <th data-sort="pm">PM</th>
        <th data-sort="vulns" class="num">Vulns</th>
        <th data-sort="fixed" class="num">Fixed</th>
        <th data-sort="build">Build</th>
        <th>Outstanding</th>
        <th data-sort="status">Status</th>
      </tr></thead>
      ${rows}
    </table>
    <p class="empty" id="empty" hidden>No projects match those filters.</p>
  </div>

  ${
    sonarDetailRows
      ? `<h2>Code quality (SonarJS)</h2>
  <div class="scroll">
    <table class="main" style="min-width:760px">
      <thead><tr><th>Project</th><th>Rule</th><th>Severity</th><th>Location</th><th>Message</th></tr></thead>
      <tbody>${sonarDetailRows}</tbody>
    </table>
  </div>`
      : ""
  }

  <footer>
    Generated by depstorm. Absolute paths and build output appear above — this file is
    written owner-readable only, and <code>audit-reports/</code> should stay out of version control.
  </footer>
</div>
<script>
(function () {
  var tbl = document.getElementById("tbl");
  var q = document.getElementById("q");
  var statusSel = document.getElementById("status");
  var count = document.getElementById("count");
  var empty = document.getElementById("empty");
  var groups = Array.prototype.slice.call(tbl.querySelectorAll("tbody.row"));

  function toggle(group, force) {
    var head = group.querySelector("tr.head");
    var detail = group.querySelector("tr.detail");
    var open = force === undefined ? detail.hidden : force;
    detail.hidden = !open;
    group.classList.toggle("open", open);
    head.setAttribute("aria-expanded", String(open));
  }

  groups.forEach(function (group) {
    var head = group.querySelector("tr.head");
    head.addEventListener("click", function () { toggle(group); });
    head.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(group); }
    });
  });

  function apply() {
    var term = q.value.trim().toLowerCase();
    var want = statusSel.value;
    var shown = 0;
    groups.forEach(function (group) {
      var hay = (group.dataset.name + " " + group.dataset.path).toLowerCase();
      var match = (!term || hay.indexOf(term) !== -1) &&
                  (!want || group.dataset.status === want);
      group.hidden = !match;
      if (match) shown++; else toggle(group, false);
    });
    count.textContent = shown + " of " + groups.length + " shown";
    empty.hidden = shown !== 0;
  }

  q.addEventListener("input", apply);
  statusSel.addEventListener("change", apply);

  var dir = {};
  tbl.querySelectorAll("th[data-sort]").forEach(function (th) {
    th.addEventListener("click", function () {
      var key = th.dataset.sort;
      var asc = dir[key] = !dir[key];
      tbl.querySelectorAll("th[data-sort]").forEach(function (o) { o.removeAttribute("aria-sort"); });
      th.setAttribute("aria-sort", asc ? "ascending" : "descending");
      var numeric = key === "vulns" || key === "fixed";
      groups.sort(function (a, b) {
        var x, y;
        if (numeric) { x = +a.dataset[key]; y = +b.dataset[key]; }
        else if (key === "name") { x = a.dataset.name.toLowerCase(); y = b.dataset.name.toLowerCase(); }
        else {
          x = (a.querySelector("tr.head").children[key === "pm" ? 1 : 6].textContent || "").trim().toLowerCase();
          y = (b.querySelector("tr.head").children[key === "pm" ? 1 : 6].textContent || "").trim().toLowerCase();
        }
        if (x < y) return asc ? -1 : 1;
        if (x > y) return asc ? 1 : -1;
        return 0;
      });
      groups.forEach(function (g) { tbl.appendChild(g); });
    });
  });

  apply();
})();
</script>
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
