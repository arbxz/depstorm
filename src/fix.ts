import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import type {
  AuditResult,
  FixResult,
  Severity,
  WizardConfig,
} from "./types.js";
import { SEVERITY_ORDER } from "./types.js";

const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "node_modules",
];

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backup lockfile before applying fixes so we can revert if build fails
 */
export async function backupLockfile(
  projectPath: string,
): Promise<string | null> {
  for (const lockfile of LOCKFILES) {
    if (lockfile === "node_modules") continue; // skip node_modules for backup
    const src = path.join(projectPath, lockfile);
    if (await exists(src)) {
      const dest = `${src}.backup`;
      await fs.copyFile(src, dest);
      consola.debug(`Backed up ${lockfile}`);
      return dest;
    }
  }
  return null;
}

/**
 * Restore lockfile from backup
 */
export async function restoreLockfile(backupPath: string): Promise<void> {
  const original = backupPath.replace(/\.backup$/, "");
  await fs.copyFile(backupPath, original);
  await fs.unlink(backupPath);
  consola.debug(`Restored lockfile from backup`);
}

/**
 * Remove lockfile backup after successful fix
 */
export async function cleanupBackup(backupPath: string): Promise<void> {
  try {
    await fs.unlink(backupPath);
  } catch {
    // ignore
  }
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
 * Run audit fix for a project
 */
export async function applyFix(
  auditResult: AuditResult,
  config: WizardConfig,
): Promise<FixResult> {
  const { project } = auditResult;

  if (!meetsThreshold(auditResult, config.severityThreshold)) {
    consola.info(
      `${project.name}: No vulnerabilities at or above "${config.severityThreshold}" severity, skipping fix`,
    );
    return {
      project,
      applied: false,
      fixedCount: 0,
      remainingCount: auditResult.totalCount,
    };
  }

  if (auditResult.fixableCount === 0) {
    consola.warn(`${project.name}: No auto-fixable vulnerabilities`);
    return {
      project,
      applied: false,
      fixedCount: 0,
      remainingCount: auditResult.totalCount,
    };
  }

  consola.start(`Fixing ${project.name}...`);

  try {
    const cmd =
      project.packageManager === "pnpm"
        ? { bin: "pnpm", args: ["audit", "--fix"] }
        : project.packageManager === "yarn"
          ? { bin: "yarn", args: ["audit", "fix"] }
          : { bin: "npm", args: ["audit", "fix"] };

    const result = await execa(cmd.bin, cmd.args, {
      cwd: project.path,
      reject: false,
    });

    if (result.exitCode !== 0 && result.stderr) {
      consola.warn(
        `${project.name} fix warnings: ${result.stderr.slice(0, 500)}`,
      );
    }

    // Re-install to ensure consistency
    const installCmd =
      project.packageManager === "pnpm"
        ? { bin: "pnpm", args: ["install"] }
        : project.packageManager === "yarn"
          ? { bin: "yarn", args: ["install"] }
          : { bin: "npm", args: ["install"] };

    await execa(installCmd.bin, installCmd.args, {
      cwd: project.path,
      reject: false,
    });

    consola.success(`${project.name}: Fixes applied`);

    return {
      project,
      applied: true,
      fixedCount: auditResult.fixableCount,
      remainingCount: auditResult.totalCount - auditResult.fixableCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    consola.error(`Failed to fix ${project.name}: ${message}`);
    return {
      project,
      applied: false,
      fixedCount: 0,
      remainingCount: auditResult.totalCount,
      error: message,
    };
  }
}
