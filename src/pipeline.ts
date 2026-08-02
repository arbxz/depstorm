import consola from "consola";
import path from "node:path";
import { resolveReportBase } from "./config.js";
import { runAudit } from "./audit.js";
import {
  applyFix,
  backupProjectFiles,
  canAttemptFix,
  cleanupBackups,
  listTouchedFiles,
  restoreProjectFiles,
  runInstall,
  type FileBackup,
} from "./fix.js";
import {
  commitFixes,
  createFixBranch,
  ensureCleanTree,
  getCurrentBranch,
  getSourceBranch,
  mergeBranch,
  pullSourceBranch,
  pushBranch,
  restoreStash,
  revertTouchedFiles,
  switchBack,
  type StashHandle,
} from "./git.js";
import { printSummary, saveHtmlReport, saveJsonReport } from "./report.js";
import { runSonarCheck } from "./sonar.js";
import { verifyBuild } from "./verify.js";
import {
  emptySeverityMap,
  type ProjectInfo,
  type ProjectReport,
  type WizardConfig,
} from "./types.js";

/**
 * Run the full audit → fix → verify → report pipeline for a list of projects
 */
export async function runPipeline(
  projects: ProjectInfo[],
  config: WizardConfig,
): Promise<ProjectReport[]> {
  const reports: ProjectReport[] = [];

  if (config.dryRun) {
    consola.info("Dry run — no files, dependencies or branches will change");
  }

  for (const project of projects) {
    consola.box(`Processing: ${project.name}`);
    try {
      reports.push(await processProject(project, config));
    } catch (err) {
      // One broken project must not abort the whole run
      const message = err instanceof Error ? err.message : String(err);
      consola.error(`${project.name}: Unexpected failure — ${message}`);
      reports.push({
        project,
        audit: {
          vulnerabilities: [],
          totalCount: 0,
          fixableCount: 0,
          bySeverity: emptySeverityMap(),
          error: message,
        },
        reverted: false,
        timestamp: new Date().toISOString(),
      });
    }
  }

  printSummary(reports);

  if (config.reportPath && !config.dryRun) {
    const basePath = resolveReportBase(config.reportPath, process.cwd());
    await saveJsonReport(reports, `${basePath}.json`);
    await saveHtmlReport(reports, `${basePath}.html`);
  } else if (config.reportPath && config.dryRun) {
    const basePath = resolveReportBase(config.reportPath, process.cwd());
    consola.info(
      `[dry-run] would write ${path.basename(basePath)}.json and .html to ${path.dirname(basePath)}`,
    );
  }

  return reports;
}

async function processProject(
  project: ProjectInfo,
  config: WizardConfig,
): Promise<ProjectReport> {
  const report: ProjectReport = {
    project,
    audit: await runAudit(project),
    reverted: false,
    timestamp: new Date().toISOString(),
  };

  if (config.sonarCheck) {
    report.sonar = await runSonarCheck(project);
  }

  if (report.audit.error) {
    consola.error(
      `${project.name}: Audit failed — ${report.audit.error}. Not treating this project as clean.`,
    );
    return report;
  }

  if (report.audit.totalCount === 0) {
    return report;
  }

  // Decide eligibility before doing any git work, so depstorm doesn't stash,
  // pull and branch for a project it is only going to skip.
  const eligibility = canAttemptFix(project, report.audit, config);
  if (!eligibility.ok || config.dryRun) {
    report.fix = await applyFix(project, report.audit, config);
    return report;
  }

  const backups: FileBackup[] = await backupProjectFiles(project.path);

  let originalBranch: string | undefined;
  let stash: StashHandle | undefined;
  let fixBranch: string | undefined;

  try {
    const wantsGit = project.hasGit && (config.gitBranch || config.gitCommit);

    if (wantsGit) {
      originalBranch = await getCurrentBranch(project);

      const clean = await ensureCleanTree(project, config);
      if (!clean.ok) return report;
      stash = clean.stash;

      if (config.gitBranch) {
        const sourceBranch = getSourceBranch(project, config);
        if (sourceBranch && !(await pullSourceBranch(project, sourceBranch))) {
          return report;
        }

        const created = await createFixBranch(project);
        if (!created) {
          consola.warn(
            `${project.name}: Could not create a fix branch — skipping to avoid modifying ${originalBranch}`,
          );
          return report;
        }
        fixBranch = created;
        report.fixBranch = created;
      }
    }

    report.fix = await applyFix(project, report.audit, config);

    if (!report.fix.applied) {
      return report;
    }

    if (config.verifyBuild) {
      report.build = await verifyBuild(project);

      if (!report.build.success && config.revertOnFailure) {
        consola.warn(`${project.name}: Build failed, reverting changes`);
        await revertFix(project, backups, config);
        report.reverted = true;
        return report;
      }
    }

    if (config.gitCommit && project.hasGit) {
      const touched = await listTouchedFiles(project.path);
      const committed = await commitFixes(
        project,
        touched,
        report.fix.fixedCount,
        report.fix.verified,
      );

      if (committed) {
        if (config.gitPush && fixBranch && !config.gitMerge) {
          await pushBranch(project, fixBranch);
        }

        if (config.gitMerge) {
          await mergeStep(project, config, fixBranch);
        }
      }
    }

    return report;
  } finally {
    // Always hand the repository back the way it was found
    if (originalBranch) await switchBack(project, originalBranch);
    if (stash) await restoreStash(project, stash);
    await cleanupBackups(backups);
  }
}

/**
 * Undo a fix that broke the build, restoring only the files depstorm touched
 * and reinstalling so node_modules matches the restored lockfile again.
 */
async function revertFix(
  project: ProjectInfo,
  backups: FileBackup[],
  config: WizardConfig,
): Promise<void> {
  const touched = await listTouchedFiles(project.path);

  if (project.hasGit) {
    await revertTouchedFiles(project, touched);
    await cleanupBackups(backups);
    consola.info(`${project.name}: Reinstalling from restored lockfile...`);
    await runInstall(project, config);
  } else {
    await restoreProjectFiles(project, backups, config);
  }
}

/**
 * Merge the fix branch into its source branch.
 *
 * Requires a branch depstorm created: merging "whatever branch we happen to be
 * on" into the source branch was never the intent of the `--merge` flag.
 */
async function mergeStep(
  project: ProjectInfo,
  config: WizardConfig,
  fixBranch: string | undefined,
): Promise<void> {
  if (!fixBranch) {
    consola.warn(
      `${project.name}: Merge skipped — no fix branch was created (enable "gitBranch")`,
    );
    return;
  }

  const target = getSourceBranch(project, config);
  if (!target) {
    consola.warn(
      `${project.name}: Merge skipped — no source branch configured (set "sourceBranch" or --branch)`,
    );
    return;
  }

  await mergeBranch(project, fixBranch, target, {
    push: config.gitPush,
    deleteBranch: true,
  });
}
