export type PackageManager = "npm" | "pnpm" | "yarn";

export type Severity = "info" | "low" | "moderate" | "high" | "critical";

export const SEVERITIES: readonly Severity[] = [
  "info",
  "low",
  "moderate",
  "high",
  "critical",
];

export const PACKAGE_MANAGERS: readonly PackageManager[] = [
  "npm",
  "pnpm",
  "yarn",
];

/** Package managers we can drive a non-interactive fix through */
export const FIXABLE_PACKAGE_MANAGERS: readonly PackageManager[] = [
  "npm",
  "pnpm",
];

export interface ProjectInfo {
  name: string;
  path: string;
  packageManager: PackageManager;
  hasGit: boolean;
  /**
   * Set for a workspace member that has no lockfile of its own — the path of
   * the nearest ancestor that does. Its dependency tree is resolved by that
   * root, so auditing it standalone only produces "requires an existing
   * lockfile".
   */
  workspaceRoot?: string;
}

export interface Vulnerability {
  name: string;
  severity: Severity;
  title: string;
  url: string;
  range: string;
  /** A patched version exists, whether or not `audit fix` will reach for it */
  fixAvailable: boolean;
  /**
   * The only available fix is a semver-major upgrade. Plain `npm audit fix`
   * refuses these, so counting them as fixable promises a fix that never
   * arrives and makes a healthy run look like a failed one.
   */
  fixIsBreaking: boolean;
}

export interface AuditResult {
  vulnerabilities: Vulnerability[];
  totalCount: number;
  /** Vulnerabilities `audit fix` can resolve without a breaking upgrade */
  fixableCount: number;
  /** Vulnerabilities whose only fix is a semver-major upgrade */
  breakingFixCount: number;
  bySeverity: Record<Severity, number>;
  /**
   * Set when the audit could not be completed. When present the counts above
   * are NOT trustworthy and must never be reported as "clean".
   */
  error?: string;
  /**
   * Set when the project was deliberately not audited because its dependencies
   * are governed by the workspace root at this path. Not a failure — the root
   * is audited in its own right.
   */
  coveredBy?: string;
}

export interface FixResult {
  applied: boolean;
  fixedCount: number;
  remainingCount: number;
  /** True when fixedCount was confirmed by a post-fix re-audit */
  verified: boolean;
  /** Severity breakdown of what is still outstanding after the fix */
  remainingBySeverity?: Record<Severity, number>;
  /** Why no fix was applied, when applied === false */
  skippedReason?: string;
  error?: string;
}

export interface BuildResult {
  success: boolean;
  output: string;
  /** True when there was nothing meaningful to verify */
  skipped: boolean;
  error?: string;
}

export interface SonarIssue {
  rule: string;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  column: number;
}

export interface SonarResult {
  issues: SonarIssue[];
  issuesBySeverity: Record<Severity, number>;
  totalCount: number;
  error?: string;
}

export interface ProjectReport {
  project: ProjectInfo;
  audit: AuditResult;
  sonar?: SonarResult;
  fix?: FixResult;
  build?: BuildResult;
  reverted: boolean;
  timestamp: string;
  /** Branch the fixes were committed to, when git operations ran */
  fixBranch?: string;
  /**
   * Set when a revert could not be completed — typically the reinstall that
   * realigns node_modules with the restored lockfile failed. The repository
   * needs manual attention, so this must reach the summary and the exit code.
   */
  revertIncomplete?: string;
}

export interface WizardConfig {
  /** Root directories to scan for projects */
  roots: string[];
  /** Specific project paths (bypass discovery) */
  projects?: string[];
  /** Cron schedule expression */
  schedule?: string;
  /** Minimum severity to act on */
  severityThreshold: Severity;
  /** Whether to auto-apply safe fixes */
  autoFix: boolean;
  /** Whether to run build verification after fixing */
  verifyBuild: boolean;
  /** Whether to revert on build failure */
  revertOnFailure: boolean;
  /** Whether to create git branches for fixes */
  gitBranch: boolean;
  /** Whether to auto-commit fixes */
  gitCommit: boolean;
  /** Whether to auto-push branches to origin */
  gitPush: boolean;
  /** Whether to auto-merge fix branches back into the source branch */
  gitMerge: boolean;
  /**
   * Whether to stash a dirty working tree without asking when there is no TTY.
   * Off by default: unattended runs skip dirty projects instead of touching them.
   */
  autoStash: boolean;
  /** Max directory scan depth (levels below each root) */
  scanDepth: number;
  /** Directories to exclude from scanning */
  excludeDirs: string[];
  /** Output report path (extension is added automatically) */
  reportPath?: string;
  /** Source branch to pull from before applying fixes (e.g. main, develop) */
  sourceBranch?: string;
  /** Per-project source branch overrides: { projectName: branchName } */
  projectBranches?: Record<string, string>;
  /** Whether to run SonarJS code quality checks */
  sonarCheck: boolean;
  /** Report what would happen without touching anything */
  dryRun: boolean;
  /**
   * Allow dependency lifecycle scripts to run during the post-fix install.
   * Off by default — installing runs third-party code.
   */
  allowInstallScripts: boolean;
  /** Exit non-zero when vulnerabilities at or above this severity remain */
  failOn?: Severity;
}

export const DEFAULT_CONFIG: WizardConfig = {
  roots: ["."],
  severityThreshold: "high",
  autoFix: true,
  verifyBuild: true,
  revertOnFailure: true,
  gitBranch: true,
  gitCommit: true,
  gitPush: false,
  gitMerge: false,
  autoStash: false,
  scanDepth: 3,
  excludeDirs: ["node_modules", ".git", "dist", "build", ".next", ".nuxt"],
  sonarCheck: true,
  dryRun: false,
  allowInstallScripts: false,
};

/**
 * Suffix for the copies depstorm keeps while a fix is in flight. Shared so the
 * cleanliness check can tell depstorm's own artifacts from the user's work.
 */
export const BACKUP_SUFFIX = ".depstorm-backup";

export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

export function emptySeverityMap(): Record<Severity, number> {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && SEVERITIES.includes(value as Severity);
}
