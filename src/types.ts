export type PackageManager = "npm" | "pnpm" | "yarn";

export type Severity = "info" | "low" | "moderate" | "high" | "critical";

export interface ProjectInfo {
  name: string;
  path: string;
  packageManager: PackageManager;
  hasGit: boolean;
}

export interface Vulnerability {
  name: string;
  severity: Severity;
  title: string;
  url: string;
  range: string;
  fixAvailable: boolean;
}

export interface AuditResult {
  project: ProjectInfo;
  vulnerabilities: Vulnerability[];
  totalCount: number;
  fixableCount: number;
  bySeverity: Record<Severity, number>;
}

export interface FixResult {
  project: ProjectInfo;
  applied: boolean;
  fixedCount: number;
  remainingCount: number;
  error?: string;
}

export interface BuildResult {
  project: ProjectInfo;
  success: boolean;
  output: string;
  error?: string;
}

export interface ProjectReport {
  project: ProjectInfo;
  audit: AuditResult;
  fix?: FixResult;
  build?: BuildResult;
  reverted: boolean;
  timestamp: string;
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
  /** Max directory scan depth */
  scanDepth: number;
  /** Directories to exclude from scanning */
  excludeDirs: string[];
  /** Output report path */
  reportPath?: string;
  /** Source branch to pull from before applying fixes (e.g. main, develop) */
  sourceBranch?: string;
  /** Per-project source branch overrides: { projectName: branchName } */
  projectBranches?: Record<string, string>;
}

export const DEFAULT_CONFIG: WizardConfig = {
  roots: ["."],
  severityThreshold: "high",
  autoFix: true,
  verifyBuild: true,
  revertOnFailure: true,
  gitBranch: true,
  gitCommit: true,
  scanDepth: 3,
  excludeDirs: ["node_modules", ".git", "dist", "build", ".next", ".nuxt"],
};

export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};
