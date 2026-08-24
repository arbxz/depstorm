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
 * A unit of git work: every project that shares one repository, plus the
 * standalone case of a project that is not in a repository at all.
 *
 * The pipeline used to treat a project as the unit, which was correct only
 * while a nested project was mistakenly reported as non-git. Once nesting is
 * recognised, two projects in one repository processed one after the other
 * would have the second branch off the fix branch of the first and stack its
 * commit on top. A repository is stashed, branched and committed once.
 */
export interface RepoGroup {
  /** Repository root, or undefined when these projects are not in one */
  gitRoot?: string;
  projects: ProjectInfo[];
}

/** Group projects by repository, preserving discovery order. */
export function groupByRepository(projects: ProjectInfo[]): RepoGroup[] {
  const groups: RepoGroup[] = [];
  const byRoot = new Map<string, RepoGroup>();

  for (const project of projects) {
    if (project.gitRoot === undefined) {
      groups.push({ projects: [project] });
      continue;
    }

    const existing = byRoot.get(project.gitRoot);
    if (existing) {
      existing.projects.push(project);
      continue;
    }

    const group: RepoGroup = { gitRoot: project.gitRoot, projects: [project] };
    byRoot.set(project.gitRoot, group);
    groups.push(group);
  }

  return groups;
}

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

  const groups = groupByRepository(projects);
  let done = 0;
  const advance = () => ++done;

  for (const group of groups) {
    try {
      reports.push(
        ...(await processGroup(group, config, advance, projects.length)),
      );
    } catch (err) {
      // One broken repository must not abort the whole run
      const message = err instanceof Error ? err.message : String(err);
      for (const project of group.projects) {
        consola.error(`${project.name}: Unexpected failure — ${message}`);
        reports.push(failedReport(project, message));
      }
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

function failedReport(project: ProjectInfo, message: string): ProjectReport {
  return {
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
  };
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

/**
 * A stand-in ProjectInfo pointing at the repository root.
 *
 * Every git helper takes a ProjectInfo but reads only `path` and `name`, so
 * this is what lets branch, stash and commit operate on the repository while
 * audit and fix keep operating on the individual projects.
 */
function repoContext(gitRoot: string, projects: ProjectInfo[]): ProjectInfo {
  return {
    name: path.basename(gitRoot) || gitRoot,
    path: gitRoot,
    packageManager: projects[0]?.packageManager ?? "npm",
    hasGit: true,
    gitRoot,
  };
}

/**
 * Paths to stage, relative to the repository root.
 *
 * listTouchedFiles returns bare filenames relative to the *project*. Staging
 * happens from the repository root once a group is committed as a unit, so
 * "package.json" would resolve to the wrong file — or to no file at all — for
 * any project that is not itself the repository root.
 *
 * @internal exported for tests
 */
export async function repoRelativeTouched(
  project: ProjectInfo,
  gitRoot: string,
): Promise<string[]> {
  const touched = await listTouchedFiles(project.path);
  return touched.map((file) =>
    path
      .relative(gitRoot, path.join(project.path, file))
      .split(path.sep)
      .join("/"),
  );
}

/**
 * The source branch for a repository.
 *
 * Per-project overrides are keyed by project name, so a repository holding
 * several projects can be told two different things. The first override wins
 * and the disagreement is reported rather than silently resolved.
 */
function groupSourceBranch(
  projects: ProjectInfo[],
  config: WizardConfig,
): string | undefined {
  const named = projects
    .map((project) => config.projectBranches?.[project.name])
    .filter((branch): branch is string => branch !== undefined);

  const distinct = [...new Set(named)];
  if (distinct.length > 1) {
    consola.warn(
      `Projects in one repository name different source branches (${distinct.join(", ")}) — using "${distinct[0]}"`,
    );
  }

  return distinct[0] ?? config.sourceBranch;
}

/** Audit (and optionally lint) a single project. Performs no writes. */
async function auditProject(
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
  }

  return report;
}

async function processGroup(
  group: RepoGroup,
  config: WizardConfig,
  advance: () => number,
  total: number,
): Promise<ProjectReport[]> {
  const reports: ProjectReport[] = [];

  for (const project of group.projects) {
    consola.box(`[${advance()}/${total}] ${project.name}`);
    reports.push(await auditProject(project, config));
  }

  // Decide eligibility before any git work, so depstorm does not stash, pull
  // and branch for a repository whose projects it is only going to skip.
  const eligible: ProjectReport[] = [];

  for (const report of reports) {
    if (report.audit.error !== undefined) continue;
    if (report.audit.coveredBy !== undefined) continue;
    if (report.audit.totalCount === 0) continue;

    const check = canAttemptFix(report.project, report.audit, config);
    if (!check.ok || config.dryRun) {
      report.fix = await applyFix(report.project, report.audit, config);
      continue;
    }
    eligible.push(report);
  }

  if (eligible.length === 0) return reports;

  const gitRoot = group.gitRoot;
  const repo =
    gitRoot === undefined ? undefined : repoContext(gitRoot, group.projects);
  const wantsGit = repo !== undefined && (config.gitBranch || config.gitCommit);

  // Backups are taken *after* the git setup below. Taking them earlier writes
  // untracked *.depstorm-backup files into the tree, which the cleanliness
  // check then reports as the user's uncommitted work — and an untracked-only
  // tree produces no stash at all, so the stash bookkeeping fails on a repo
  // that was actually pristine.
  const backupsByProject = new Map<string, FileBackup[]>();
  const allBackups = () => [...backupsByProject.values()].flat();

  let originalBranch: string | undefined;
  let stash: StashHandle | undefined;
  let fixBranch: string | undefined;

  /**
   * Hand the repository back the way it was found. Backups go first: they are
   * untracked files depstorm created, and leaving them on disk while switching
   * branches or popping the stash makes the artifacts of depstorm look like
   * the uncommitted work of the user.
   *
   * Safe to call twice — the finally block and an interrupt can race.
   */
  async function unwind(): Promise<void> {
    const ours = allBackups();
    backupsByProject.clear();
    await cleanupBackups(ours);

    if (repo && originalBranch !== undefined) {
      const branch = originalBranch;
      originalBranch = undefined;
      await switchBack(repo, branch);
    }

    if (repo && stash) {
      const handle = stash;
      stash = undefined;
      const result = await restoreStash(repo, handle);
      // The stash is repository-wide, so its fate belongs on every report
      // drawn from this repository, not only the first one.
      for (const report of reports) report.stashRestore = result;
    }
  }

  const cleanup: PendingCleanup = registerCleanup({
    describe: () => {
      const where = repo
        ? `${repo.name} (${repo.path})`
        : (group.projects[0]?.path ?? "unknown project");
      const parts = [where];
      if (fixBranch) parts.push(`left on branch ${fixBranch}`);
      if (originalBranch !== undefined) {
        parts.push(`return with: git checkout ${originalBranch}`);
      }
      if (stash) parts.push(`stashed work: ${stash.label} — git stash list`);
      if (allBackups().length > 0) {
        parts.push(`backup files left: *${BACKUP_SUFFIX}`);
      }
      return parts.join("; ");
    },
    run: unwind,
  });

  const skipGit = (reason: string) => {
    for (const report of eligible) report.gitSkippedReason = reason;
  };

  try {
    if (wantsGit && repo) {
      originalBranch = await getCurrentBranch(repo);

      const clean = await ensureCleanTree(repo, config);
      if (!clean.ok) {
        skipGit("working tree was not clean");
        return reports;
      }
      stash = clean.stash;

      if (config.gitBranch) {
        const sourceBranch = groupSourceBranch(group.projects, config);
        if (sourceBranch && !(await pullSourceBranch(repo, sourceBranch))) {
          skipGit(`could not pull source branch "${sourceBranch}"`);
          return reports;
        }

        const created = await createFixBranch(repo);
        if (!created) {
          consola.warn(
            `${repo.name}: Could not create a fix branch — skipping to avoid modifying ${originalBranch}`,
          );
          skipGit("could not create a fix branch");
          return reports;
        }
        fixBranch = created;
        for (const report of eligible) report.fixBranch = created;
      }
    }

    const applied: ProjectReport[] = [];

    for (const report of eligible) {
      const project = report.project;
      backupsByProject.set(project.path, await backupProjectFiles(project.path));

      report.fix = await applyFix(project, report.audit, config);

      if (!report.fix.applied) {
        // The fixer may still have rewritten the manifest or lockfile even
        // when it resolved nothing. Leaving those edits behind strands
        // generated changes in the tree and blocks the stash from coming back.
        await restoreProjectFiles(
          project,
          backupsByProject.get(project.path) ?? [],
          config,
        );
        backupsByProject.delete(project.path);
        continue;
      }

      if (config.verifyBuild) {
        report.build = await verifyBuild(project);

        if (!report.build.success && config.revertOnFailure) {
          consola.warn(`${project.name}: Build failed, reverting changes`);
          report.revertIncomplete = await revertFix(
            project,
            repo,
            backupsByProject.get(project.path) ?? [],
            config,
          );
          backupsByProject.delete(project.path);
          report.reverted = true;
          continue;
        }
      }

      applied.push(report);
    }

    if (config.gitCommit && repo && applied.length > 0) {
      await commitStep(repo, applied, config, fixBranch, group);
    }

    return reports;
  } finally {
    // Mutating the reports in here still reaches the caller: the returns above
    // hand back the same array and the same objects, not copies.
    await unwind();
    unregisterCleanup(cleanup);
  }
}

/**
 * Stage and commit every project in the repository that produced a verified
 * fix, as one commit, then push or merge if asked.
 */
async function commitStep(
  repo: ProjectInfo,
  applied: ProjectReport[],
  config: WizardConfig,
  fixBranch: string | undefined,
  group: RepoGroup,
): Promise<void> {
  const paths: string[] = [];
  for (const report of applied) {
    paths.push(...(await repoRelativeTouched(report.project, repo.path)));
  }

  const fixedCount = applied.reduce(
    (sum, report) => sum + (report.fix?.fixedCount ?? 0),
    0,
  );
  // One unverified project makes the whole commit message unverified — the
  // message describes the commit, and part of it is unconfirmed.
  const verified = applied.every((report) => report.fix?.verified === true);

  const committed = await commitFixes(repo, paths, fixedCount, verified);
  if (!committed) return;

  if (config.gitPush && fixBranch && !config.gitMerge) {
    await pushBranch(repo, fixBranch);
  }

  if (config.gitMerge) {
    await mergeStep(repo, config, fixBranch, group);
  }
}

/**
 * Undo a fix that broke the build, restoring only the files depstorm touched
 * and reinstalling so node_modules matches the restored lockfile again.
 */
async function revertFix(
  project: ProjectInfo,
  repo: ProjectInfo | undefined,
  backups: FileBackup[],
  config: WizardConfig,
): Promise<string | undefined> {
  if (repo) {
    const touched = await repoRelativeTouched(project, repo.path);
    await revertTouchedFiles(repo, touched);
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
  return install.ok
    ? undefined
    : (install.message ?? "reinstall after revert failed");
}

/**
 * Merge the fix branch into its source branch.
 *
 * Requires a branch depstorm created: merging "whatever branch we happen to be
 * on" into the source branch was never the intent of the `--merge` flag.
 */
async function mergeStep(
  repo: ProjectInfo,
  config: WizardConfig,
  fixBranch: string | undefined,
  group: RepoGroup,
): Promise<void> {
  if (!fixBranch) {
    consola.warn(
      `${repo.name}: Merge skipped — no fix branch was created (enable "gitBranch")`,
    );
    return;
  }

  const target = groupSourceBranch(group.projects, config);
  if (!target) {
    consola.warn(
      `${repo.name}: Merge skipped — no source branch configured (set "sourceBranch" or --branch)`,
    );
    return;
  }

  await mergeBranch(repo, fixBranch, target, {
    push: config.gitPush,
    deleteBranch: true,
  });
}
