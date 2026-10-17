import { DEFAULT_MIN_RELEASE_AGE_DAYS } from "./cooldown.js";
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
   * The repository this project lives in — not necessarily `path`. A project
   * nested inside a repository is still under version control, and treating
   * it as though it were not skipped every git operation without saying so.
   */
  gitRoot?: string;
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
  /**
   * npm also lists every package that is vulnerable only because it depends
   * on a vulnerable package. For those this names the packages it inherits
   * from; it is absent when the package carries an advisory of its own.
   */
  inheritedFrom?: string[];
}

/**
 * A consciously accepted advisory.
 *
 * `reason` is mandatory and `expires` makes the suppression lapse on its own,
 * so the list stays a record of decisions rather than a place vulnerabilities
 * go to be forgotten.
 */
export interface IgnoreRule {
  /** Package name to match, e.g. "brace-expansion" */
  package?: string;
  /** Advisory id to match, e.g. "GHSA-xxxx-xxxx-xxxx" or "CVE-2026-1234" */
  advisory?: string;
  /** Why this is accepted. Required. */
  reason: string;
  /** YYYY-MM-DD, inclusive. After this the rule stops suppressing. */
  expires?: string;
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
  /**
   * Advisories suppressed by an ignore rule. Kept rather than dropped: a
   * suppression nobody can see is indistinguishable from a bug.
   */
  ignored?: Vulnerability[];
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
  /**
   * Overrides that were rewritten with a major ceiling the fixer left off,
   * as "key: old -> new". Recorded so the report can show that the fix was
   * narrowed, and why the resolved versions differ from a bare `audit fix`.
   */
  boundedOverrides?: string[];
  /**
   * Versions the fix wanted to pin that are still inside the release-age
   * quarantine, as "name@version (Nh old)". Present means the fix was held
   * back rather than applied.
   */
  heldForCooldown?: string[];
  /**
   * Set when the resolved tree now requires a newer Node than the project
   * declares. The fix is sound; the deploy target is what will break.
   */
  raisedNodeFloor?: string;
  error?: string;
}

export interface BuildResult {
  success: boolean;
  output: string;
  /** True when there was nothing meaningful to verify */
  skipped: boolean;
  error?: string;
  /**
   * True when this same command already failed *before* the fix was applied.
   *
   * A dependency fix cannot be blamed for breakage that predates it, and
   * reverting on one throws away a real security fix to leave the build
   * exactly as broken as it already was.
   */
  preexistingFailure?: boolean;
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

/** Outcome of popping the stash depstorm created back onto the working tree. */
export type RestoreStashResult =
  | { ok: true }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "conflict"; conflicts: string[] }
  | { ok: false; reason: "error"; message: string };

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
  /**
   * Outcome of restoring the user's stashed work, when depstorm stashed any.
   * A conflicted pop leaves conflict markers in the working tree, so this has
   * to reach the summary and the exit code rather than only the log.
   */
  stashRestore?: RestoreStashResult;
  /**
   * Why no branch or commit was made despite the project being in a
   * repository. Silently doing nothing was the previous behaviour and it left
   * users wondering where their fix branch went.
   */
  gitSkippedReason?: string;
}

export interface DepstormConfig {
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
  /**
   * How many repositories to process at once. Only honoured when nothing
   * writes to git — see concurrencyFor in pipeline.ts.
   */
  concurrency?: number;
  /**
   * Per-step time limits in seconds. A large monorepo routinely exceeds the
   * defaults, and a hardcoded ceiling turns that into an unexplained failure.
   */
  timeouts?: Partial<Record<TimeoutStep, number>>;
  /** Directories to exclude from scanning */
  excludeDirs: string[];
  /** Output report path (extension is added automatically) */
  reportPath?: string;
  /**
   * Source branch to pull from before applying fixes (e.g. main, develop).
   *
   * The literal "current" keeps each repository on the branch it was found
   * on. A fixed name is applied to every repository alike, which silently
   * moves work off a feature branch and can select a different lockfile than
   * the one the package manager was detected from.
   */
  sourceBranch?: string;
  /**
   * Run the verification command once before fixing, to learn whether the
   * project already built. Costs a second build; without it any pre-existing
   * breakage is attributed to the fix and reverts it.
   */
  baselineVerify?: boolean;
  /**
   * Refuse to install a version published fewer than this many days ago.
   *
   * A compromised release is typically caught and yanked within a couple of
   * days, and `audit fix` reaches for exactly the brand-new patch releases
   * that window covers. 0 disables the quarantine.
   */
  minReleaseAgeDays?: number;
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
  /** Exit non-zero when code quality issues at or above this severity remain */
  failOnQuality?: Severity;
  /** Advisories deliberately accepted — see IgnoreRule */
  ignore?: IgnoreRule[];
}

export type TimeoutStep = "audit" | "install" | "build" | "sonar";

/** Per-step time limits, in seconds. */
export const DEFAULT_TIMEOUTS: Record<TimeoutStep, number> = {
  audit: 3 * 60,
  install: 10 * 60,
  build: 5 * 60,
  sonar: 5 * 60,
};

/** Resolve a step's timeout to milliseconds. */
export function timeoutMs(
  config: Pick<DepstormConfig, "timeouts">,
  step: TimeoutStep,
): number {
  const seconds = config.timeouts?.[step] ?? DEFAULT_TIMEOUTS[step];
  return seconds * 1000;
}

export const DEFAULT_CONFIG: DepstormConfig = {
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
  baselineVerify: true,
  minReleaseAgeDays: DEFAULT_MIN_RELEASE_AGE_DAYS,
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
