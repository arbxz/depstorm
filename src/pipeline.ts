import consola from "consola";
import type { ProjectInfo, ProjectReport, WizardConfig } from "./types.js";
import { runAudit } from "./audit.js";
import {
  applyFix,
  backupLockfile,
  cleanupBackup,
  restoreLockfile,
} from "./fix.js";
import { verifyBuild } from "./verify.js";
import {
  commitFixes,
  createFixBranch,
  getCurrentBranch,
  getSourceBranch,
  mergeBranch,
  pullSourceBranch,
  pushBranch,
  revertChanges,
  switchBack,
} from "./git.js";
import { printSummary, saveHtmlReport, saveJsonReport } from "./report.js";
import { runSonarCheck } from "./sonar.js";

/**
 * Run the full audit → fix → verify → report pipeline for a list of projects
 */
export async function runPipeline(
  projects: ProjectInfo[],
  config: WizardConfig,
): Promise<ProjectReport[]> {
  const reports: ProjectReport[] = [];

  for (const project of projects) {
    consola.box(`Processing: ${project.name}`);

    const report = await processProject(project, config);
    reports.push(report);
  }

  // Print summary
  printSummary(reports);

  // Save reports if configured
  if (config.reportPath) {
    const basePath = config.reportPath.replace(/\.[^.]+$/, "");
    await saveJsonReport(reports, `${basePath}.json`);
    await saveHtmlReport(reports, `${basePath}.html`);
  }

  return reports;
}

async function processProject(
  project: ProjectInfo,
  config: WizardConfig,
): Promise<ProjectReport> {
  const timestamp = new Date().toISOString();

  // Step 1: Audit
  const auditResult = await runAudit(project);

  // Step 1b: SonarJS code quality check
  const sonarResult = config.sonarCheck
    ? await runSonarCheck(project)
    : undefined;

  if (auditResult.totalCount === 0) {
    return {
      project,
      audit: auditResult,
      sonar: sonarResult,
      reverted: false,
      timestamp,
    };
  }

  // Step 2: Auto-fix (if enabled)
  if (!config.autoFix) {
    consola.info(`${project.name}: Auto-fix disabled, skipping`);
    return {
      project,
      audit: auditResult,
      sonar: sonarResult,
      reverted: false,
      timestamp,
    };
  }

  // Backup lockfile
  const backupPath = await backupLockfile(project.path);

  // Pull from source branch first, then create fix branch
  let originalBranch: string | undefined;
  if (config.gitBranch && project.hasGit) {
    try {
      originalBranch = await getCurrentBranch(project);

      // Pull latest from the source branch before applying fixes
      const sourceBranch = getSourceBranch(project, config);
      if (sourceBranch) {
        const proceeded = await pullSourceBranch(project, sourceBranch);
        if (!proceeded) {
          // User chose to skip this project
          if (backupPath) await cleanupBackup(backupPath);
          return {
            project,
            audit: auditResult,
            reverted: false,
            timestamp,
          };
        }
      }

      const fixBranch = await createFixBranch(project);
      if (!fixBranch) {
        // User chose to skip this project
        if (backupPath) await cleanupBackup(backupPath);
        if (originalBranch) await switchBack(project, originalBranch);
        return {
          project,
          audit: auditResult,
          reverted: false,
          timestamp,
        };
      }
    } catch {
      consola.warn(`${project.name}: Skipping git branch creation`);
    }
  }

  // Apply fix
  const fixResult = await applyFix(auditResult, config);

  if (!fixResult.applied) {
    // No fixes applied, clean up
    if (backupPath) await cleanupBackup(backupPath);
    if (originalBranch && project.hasGit) {
      await switchBack(project, originalBranch);
    }
    return {
      project,
      audit: auditResult,
      sonar: sonarResult,
      fix: fixResult,
      reverted: false,
      timestamp,
    };
  }

  // Step 3: Build verification (if enabled)
  let buildResult;
  let reverted = false;

  if (config.verifyBuild) {
    buildResult = await verifyBuild(project);

    if (!buildResult.success && config.revertOnFailure) {
      consola.warn(`${project.name}: Build failed, reverting changes`);

      if (project.hasGit) {
        await revertChanges(project);
      } else if (backupPath) {
        await restoreLockfile(backupPath);
      }

      reverted = true;
    }
  }

  // Step 4: Commit (if build passed & git enabled)
  let fixBranchName: string | undefined;
  if (config.gitCommit && project.hasGit && fixResult.applied && !reverted) {
    try {
      await commitFixes(project, fixResult.fixedCount);

      // Step 5: Push fix branch to origin (if enabled)
      if (config.gitPush) {
        fixBranchName = await getCurrentBranch(project);
        await pushBranch(project, fixBranchName);
      }
    } catch {
      consola.warn(`${project.name}: Failed to commit fixes`);
    }
  }

  // Step 6: Merge fix branch into source branch (if enabled)
  const sourceBranch = getSourceBranch(project, config);
  if (
    config.gitMerge &&
    project.hasGit &&
    fixResult.applied &&
    !reverted &&
    sourceBranch
  ) {
    const branch = fixBranchName ?? (await getCurrentBranch(project));
    const merged = await mergeBranch(project, branch, sourceBranch);
    if (merged) {
      // Already on source branch after merge, no need to switchBack
      if (backupPath) await cleanupBackup(backupPath);
      return {
        project,
        audit: auditResult,
        sonar: sonarResult,
        fix: fixResult,
        build: buildResult,
        reverted,
        timestamp,
      };
    }
  }

  // Switch back to original branch
  if (originalBranch && project.hasGit) {
    await switchBack(project, originalBranch);
  }

  // Cleanup backup
  if (backupPath) await cleanupBackup(backupPath);

  return {
    project,
    audit: auditResult,
    sonar: sonarResult,
    fix: fixResult,
    build: buildResult,
    reverted,
    timestamp,
  };
}
