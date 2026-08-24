import consola from "consola";
import path from "node:path";
import {
  registerCleanup,
  unregisterCleanup,
  type PendingCleanup,
} from "./cleanup.js";
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
  BACKUP_SUFFIX,
  emptySeverityMap,
  type AuditResult,
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
          breakingFixCount: 0,
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

/** An audit that was deliberately not run because a workspace root owns it. */
function coveredByWorkspace(root: string): AuditResult {
  return {
    vulnerabilities: [],
    totalCount: 0,
    fixableCount: 0,
    breakingFixCount: 0,
    bySeverity: emptySeverityMap(),
    coveredBy: root,
  };
}

async function processProject(
  project: ProjectInfo,
  config: WizardConfig,
): Promise<ProjectReport> {
  const report: ProjectReport = {
    project,
    // A workspace member resolves its dependencies through the root lockfile,
    // so a standalone audit here can only fail. The root is audited separately.
    audit: project.workspaceRoot
      ? coveredByWorkspace(project.workspaceRoot)
      : await runAudit(project, { ignore: config.ignore }),
    reverted: false,
    timestamp: new Date().toISOString(),
  };

  if (report.audit.coveredBy) {
    consola.info(
      `${project.name}: Covered by the workspace at ${report.audit.coveredBy} — not audited separately`,
    );
  }

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

  // Backups are taken *after* the git setup below. Taking them earlier writes
  // untracked *.depstorm-backup files into the tree, which the cleanliness
  // check then reports as the user's uncommitted work — and an untracked-only
  // tree produces no stash at all, so the stash bookkeeping fails on a repo
  // that was actually pristine.
  let backups: FileBackup[] = [];

  let originalBranch: string | undefined;
  let stash: StashHandle | undefined;
  let fixBranch: string | undefined;

  // Everything below this point holds recoverable state that only the finally
  // block gives back — and Ctrl+C never reaches a finally block. The same
  // unwind is registered so an interrupt can run it too.
  const cleanup: PendingCleanup = registerCleanup({
    describe: () => {
      const parts = [`${project.name} (${project.path})`];
      if (fixBranch) parts.push(`left on branch ${fixBranch}`);
      if (originalBranch) parts.push(`return with: git checkout ${originalBranch}`);
      if (stash) parts.push(`stashed work: ${stash.label} — git stash list`);
      if (backups.length > 0) {
        parts.push(`backup files left: *${BACKUP_SUFFIX}`);
      }
      return parts.join("; ");
    },
    run: async () => {
      await unwind();
    },
  });

  /**
   * Hand the repository back the way it was found. Backups go first: they are
   * untracked files depstorm created, and leaving them on disk while switching
   * branches or popping the stash makes depstorm's own artifacts look like the
   * user's uncommitted work.
   *
   * Safe to call twice — the finally block and an interrupt can race.
   */
  async function unwind(): Promise<void> {
    const ourBackups = backups;
    backups = [];
    await cleanupBackups(ourBackups);

    if (originalBranch) {
      const branch = originalBranch;
      originalBranch = undefined;
      await switchBack(project, branch);
    }

    if (stash) {
      const handle = stash;
      stash = undefined;
      report.stashRestore = await restoreStash(project, handle);
    }
  }

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

    backups = await backupProjectFiles(project.path);

    report.fix = await applyFix(project, report.audit, config);

    if (!report.fix.applied) {
      // The fixer may still have rewritten the manifest or lockfile even when
      // it resolved nothing. Leaving those edits behind strands generated
      // changes in the tree and blocks the stash from being popped back.
      await restoreProjectFiles(project, backups, config);
      backups = [];
      return report;
    }

    if (config.verifyBuild) {
      report.build = await verifyBuild(project);

      if (!report.build.success && config.revertOnFailure) {
        consola.warn(`${project.name}: Build failed, reverting changes`);
        report.revertIncomplete = await revertFix(project, backups, config);
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
    // Mutating `report` in here still reaches the caller: the returns above
    // hand back this same object reference, not a copy.
    await unwind();
    unregisterCleanup(cleanup);
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
): Promise<string | undefined> {
  const touched = await listTouchedFiles(project.path);

  if (project.hasGit) {
    await revertTouchedFiles(project, touched);
    await cleanupBackups(backups);
    consola.info(`${project.name}: Reinstalling from restored lockfile...`);
    const install = await runInstall(project, config);
    if (!install.ok) {
      consola.error(
        `${project.name}: Reinstall after revert FAILED — the manifest and lockfile are restored but node_modules is not. Run "${project.packageManager} install" here.\n${install.message ?? ""}`,
      );
      return install.message ?? "reinstall after revert failed";
    }
    return undefined;
  }

  const install = await restoreProjectFiles(project, backups, config);
  return install.ok ? undefined : (install.message ?? "reinstall after revert failed");
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
