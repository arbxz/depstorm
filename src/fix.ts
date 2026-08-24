import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import { runAudit } from "./audit.js";
import {
  BACKUP_SUFFIX,
  FIXABLE_PACKAGE_MANAGERS,
  SEVERITY_ORDER,
  type AuditResult,
  type FixResult,
  type ProjectInfo,
  type Severity,
  type WizardConfig,
} from "./types.js";

const FIX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The only files a dependency fix is allowed to change. Everything that stages,
 * reverts or backs up work uses this list, so depstorm never commits or
 * destroys files outside it.
 */
export const FIX_TOUCHED_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

export interface FileBackup {
  original: string;
  backup: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Relative paths of the fix-relevant files that actually exist in a project
 */
export async function listTouchedFiles(projectPath: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of FIX_TOUCHED_FILES) {
    if (await exists(path.join(projectPath, file))) found.push(file);
  }
  return found;
}

/**
 * Back up manifest and lockfile before applying fixes so a non-git project can
 * still be restored. `package.json` matters too — both `npm audit fix` and
 * `pnpm audit --fix` rewrite it.
 */
export async function backupProjectFiles(
  projectPath: string,
): Promise<FileBackup[]> {
  const backups: FileBackup[] = [];

  for (const file of await listTouchedFiles(projectPath)) {
    const original = path.join(projectPath, file);
    const backup = `${original}${BACKUP_SUFFIX}`;
    await fs.copyFile(original, backup);
    backups.push({ original, backup });
  }

  if (backups.length > 0) {
    consola.debug(`Backed up ${backups.length} file(s)`);
  }
  return backups;
}

/**
 * Restore manifest/lockfile from backup and reinstall, so that node_modules
 * matches the restored lockfile again.
 */
export async function restoreProjectFiles(
  project: ProjectInfo,
  backups: FileBackup[],
  config: WizardConfig,
): Promise<InstallResult> {
  for (const { original, backup } of backups) {
    try {
      await fs.copyFile(backup, original);
      await fs.unlink(backup);
    } catch (err) {
      consola.error(`Failed to restore ${original}: ${err}`);
    }
  }

  if (backups.length === 0) return { ok: true };

  consola.info(`${project.name}: Reinstalling from restored lockfile...`);
  const install = await runInstall(project, config);

  if (!install.ok) {
    consola.error(
      `${project.name}: Reinstall after restore FAILED — node_modules no longer matches the restored lockfile. Run "${project.packageManager} install" here before trusting this checkout.\n${install.message ?? ""}`,
    );
  }

  return install;
}

export async function cleanupBackups(backups: FileBackup[]): Promise<void> {
  await Promise.all(
    backups.map(({ backup }) => fs.unlink(backup).catch(() => {})),
  );
}

function meetsThreshold(
  auditResult: AuditResult,
  threshold: Severity,
): boolean {
  const thresholdLevel = SEVERITY_ORDER[threshold];
  return auditResult.vulnerabilities.some(
    (v) => SEVERITY_ORDER[v.severity] >= thresholdLevel,
  );
}

/**
 * Whether a fix would be attempted at all — checked before any git branching
 * so depstorm doesn't stash, pull and branch for a project it will then skip.
 */
export function canAttemptFix(
  project: ProjectInfo,
  auditResult: AuditResult,
  config: WizardConfig,
): { ok: boolean; reason?: string } {
  if (auditResult.error) {
    return { ok: false, reason: "Audit failed — not attempting a fix" };
  }
  if (!config.autoFix) {
    return { ok: false, reason: "Auto-fix disabled" };
  }
  if (!FIXABLE_PACKAGE_MANAGERS.includes(project.packageManager)) {
    return {
      ok: false,
      reason: `${project.packageManager} has no non-interactive audit fix — upgrade the reported packages manually`,
    };
  }
  if (!meetsThreshold(auditResult, config.severityThreshold)) {
    return {
      ok: false,
      reason: `No vulnerabilities at or above "${config.severityThreshold}" severity`,
    };
  }
  if (auditResult.fixableCount === 0) {
    // Distinguishing this from "nothing is fixable" matters: the user *can*
    // act on it, just not by re-running depstorm.
    if (auditResult.breakingFixCount > 0) {
      const n = auditResult.breakingFixCount;
      return {
        ok: false,
        reason: `${n} vulnerabilit${n === 1 ? "y" : "ies"} can only be fixed by a semver-major upgrade, which "${project.packageManager} audit fix" will not apply — upgrade the reported packages manually`,
      };
    }
    return { ok: false, reason: "No auto-fixable vulnerabilities" };
  }
  return { ok: true };
}

export interface InstallResult {
  ok: boolean;
  /** Why the install failed, when ok === false */
  message?: string;
}

/**
 * Reinstall so node_modules matches the lockfile on disk.
 *
 * The outcome is returned rather than discarded: a failed install leaves
 * node_modules describing a different dependency tree than the lockfile, and
 * every caller here goes on to either verify a build or declare a revert
 * complete. Silently continuing made both of those claims untrue.
 */
export async function runInstall(
  project: ProjectInfo,
  config: WizardConfig,
): Promise<InstallResult> {
  const args = ["install"];
  // Installing runs third-party lifecycle scripts. Off unless asked for.
  if (!config.allowInstallScripts) args.push("--ignore-scripts");
  // pnpm turns on --frozen-lockfile by itself when CI=true. A fix rewrites
  // package.json on purpose, so a frozen install is guaranteed to fail there.
  if (project.packageManager === "pnpm") args.push("--no-frozen-lockfile");

  const result = await execa(project.packageManager, args, {
    cwd: project.path,
    reject: false,
    timeout: FIX_TIMEOUT_MS,
  });

  if (result.exitCode === 0) return { ok: true };

  const message =
    (result.stderr ?? "").trim().slice(-500) ||
    (result.stdout ?? "").trim().slice(-500) ||
    result.message ||
    `${project.packageManager} install exited with ${String(result.exitCode)}`;

  return { ok: false, message };
}

function skipped(reason: string, auditResult: AuditResult): FixResult {
  return {
    applied: false,
    fixedCount: 0,
    remainingCount: auditResult.totalCount,
    remainingBySeverity: auditResult.bySeverity,
    verified: false,
    skippedReason: reason,
  };
}

/**
 * Run audit fix for a project and confirm the result with a second audit.
 */
export async function applyFix(
  project: ProjectInfo,
  auditResult: AuditResult,
  config: WizardConfig,
): Promise<FixResult> {
  const eligibility = canAttemptFix(project, auditResult, config);
  if (!eligibility.ok) {
    consola.info(`${project.name}: ${eligibility.reason}, skipping fix`);
    return skipped(eligibility.reason ?? "Not eligible", auditResult);
  }

  if (config.dryRun) {
    consola.info(
      `${project.name}: [dry-run] would run "${project.packageManager} audit fix" for ${auditResult.fixableCount} fixable vulnerabilit${auditResult.fixableCount === 1 ? "y" : "ies"}`,
    );
    return skipped("Dry run — no changes made", auditResult);
  }

  consola.start(`Fixing ${project.name}...`);

  try {
    const fixArgs =
      project.packageManager === "pnpm"
        ? ["audit", "--fix"]
        : ["audit", "fix"];

    const result = await execa(project.packageManager, fixArgs, {
      cwd: project.path,
      reject: false,
      timeout: FIX_TIMEOUT_MS,
    });

    if (result.exitCode !== 0 && result.stderr) {
      consola.warn(
        `${project.name} fix warnings: ${result.stderr.slice(0, 500)}`,
      );
    }

    // Re-install so node_modules matches the rewritten lockfile. If this
    // fails, the re-audit below would be measuring the *old* tree, so the
    // only honest outcome is an error — not "fix ran but nothing changed".
    const install = await runInstall(project, config);
    if (!install.ok) {
      consola.error(
        `${project.name}: Reinstall after the fix failed — ${install.message ?? "unknown error"}`,
      );
      return {
        applied: false,
        fixedCount: 0,
        remainingCount: auditResult.totalCount,
        remainingBySeverity: auditResult.bySeverity,
        verified: false,
        error: `Reinstall after "${project.packageManager} audit fix" failed: ${install.message ?? "unknown error"}`,
      };
    }

    // Confirm what actually changed rather than assuming every fixable
    // vulnerability was fixed — `audit fix` routinely fixes fewer.
    const after = await runAudit(project, { quiet: true });

    if (after.error) {
      consola.warn(
        `${project.name}: Could not verify fixes (re-audit failed: ${after.error})`,
      );
      return {
        applied: true,
        fixedCount: 0,
        remainingCount: auditResult.totalCount,
        remainingBySeverity: auditResult.bySeverity,
        verified: false,
      };
    }

    const fixedCount = Math.max(0, auditResult.totalCount - after.totalCount);

    if (fixedCount === 0) {
      consola.warn(`${project.name}: Fix ran but nothing was resolved`);
    } else {
      consola.success(
        `${project.name}: Fixed ${fixedCount} of ${auditResult.totalCount} vulnerabilit${auditResult.totalCount === 1 ? "y" : "ies"}`,
      );
    }

    return {
      applied: fixedCount > 0,
      fixedCount,
      remainingCount: after.totalCount,
      remainingBySeverity: after.bySeverity,
      verified: true,
      skippedReason:
        fixedCount === 0 ? "audit fix resolved nothing" : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    consola.error(`Failed to fix ${project.name}: ${message}`);
    return {
      applied: false,
      fixedCount: 0,
      remainingCount: auditResult.totalCount,
      remainingBySeverity: auditResult.bySeverity,
      verified: false,
      error: message,
    };
  }
}
