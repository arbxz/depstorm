import { loadConfig, normaliseGitFlags, resolveRoots } from "./config.js";
import { discoverProjects, resolveExplicitProjects } from "./discover.js";
import {
  SEVERITIES,
  isSeverity,
  type DepstormConfig,
  type ProjectInfo,
  type Severity,
} from "./types.js";

/** Commander option values, as parsed. */
export type CliOptions = Record<string, unknown>;

export function parseDepth(value: string): number {
  const depth = Number.parseInt(value, 10);
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`--depth must be a non-negative integer, got "${value}"`);
  }
  return depth;
}

/**
 * Days, not necessarily whole ones — "--min-release-age 0.5" is a legitimate
 * way to say "a few hours is enough" without turning the check off entirely.
 */
export function parseMinReleaseAge(value: string): number {
  const days = Number.parseFloat(value);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(
      `--min-release-age must be a non-negative number of days, got "${value}"`,
    );
  }
  return days;
}

export function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `--concurrency must be an integer of 1 or more, got "${value}"`,
    );
  }
  return parsed;
}

export function requireSeverity(value: unknown, flag: string): Severity {
  if (!isSeverity(value)) {
    throw new Error(
      `${flag} must be one of: ${SEVERITIES.join(", ")} (got "${String(value)}")`,
    );
  }
  return value;
}

/**
 * Layer command-line options on top of a loaded config.
 *
 * Split out from `buildConfig` and kept free of I/O because the precedence
 * rules here are the fiddly part and the part worth asserting on: opt-outs
 * beat opt-ins, both beat the config file, and `--no-git` has to reach every
 * git flag rather than only the obvious one.
 *
 * Mutates and returns `config`, matching the rest of the config module.
 */
export function applyCliOptions(
  config: DepstormConfig,
  opts: CliOptions,
): DepstormConfig {
  if (opts.root) config.roots = opts.root as string[];

  if (opts.severity !== undefined) {
    config.severityThreshold = requireSeverity(opts.severity, "--severity");
  }
  if (opts.failOn !== undefined) {
    config.failOn = requireSeverity(opts.failOn, "--fail-on");
  }
  if (opts.failOnQuality !== undefined) {
    config.failOnQuality = requireSeverity(
      opts.failOnQuality,
      "--fail-on-quality",
    );
  }

  if (opts.ignore) {
    // A flag cannot carry a rationale, so it says so rather than pretending
    // to be a reviewed entry in the config file.
    const adhoc = (opts.ignore as string[]).map((name) => ({
      package: name,
      reason: "suppressed with --ignore on the command line",
    }));
    config.ignore = [...(config.ignore ?? []), ...adhoc];
  }

  if (opts.fix === false) config.autoFix = false;
  if (opts.build === false) config.verifyBuild = false;

  // `--no-git` must disable every git operation, including ones enabled in
  // the config file. Leaving push/merge on made it merge into the source branch.
  if (opts.git === false) {
    config.gitBranch = false;
    config.gitCommit = false;
    config.gitPush = false;
    config.gitMerge = false;
    config.gitRelease = false;
    config.gitPull = false;
  }
  if (opts.pull === false) config.gitPull = false;

  if (opts.report === false) config.reportPath = undefined;
  else if (opts.report) config.reportPath = opts.report as string;

  if (opts.depth !== undefined) config.scanDepth = opts.depth as number;
  if (opts.concurrency !== undefined) {
    config.concurrency = opts.concurrency as number;
  }
  if (opts.branch) config.sourceBranch = opts.branch as string;
  // commander gives `baseline: false` for --no-baseline and leaves it
  // undefined otherwise, so absent must stay absent.
  if (opts.baseline === false) config.baselineVerify = false;
  if (opts.releaseCooldown === false) config.minReleaseAgeDays = 0;
  if (typeof opts.minReleaseAge === "number") {
    config.minReleaseAgeDays = opts.minReleaseAge;
  }

  // Opt-outs win over opt-ins, and over anything the config file enabled
  if (opts.push) config.gitPush = true;
  if (opts.merge) config.gitMerge = true;
  if (opts.skipPush) config.gitPush = false;
  if (opts.skipMerge) config.gitMerge = false;
  if (opts.release) config.gitRelease = true;
  if (opts.skipRelease) config.gitRelease = false;

  if (opts.autoStash) config.autoStash = true;
  if (opts.allowInstallScripts) config.allowInstallScripts = true;
  if (opts.dryRun) config.dryRun = true;

  // Normalising after `--no-git` would switch the git flags back on, since
  // normalisation exists to make a *requested* combination coherent.
  if (opts.git !== false) normaliseGitFlags(config);
  return config;
}

/** Load the config file named by `--config`, then layer the flags onto it. */
export async function buildConfig(opts: CliOptions): Promise<DepstormConfig> {
  const config = await loadConfig(opts.config as string | undefined);
  return applyCliOptions(config, opts);
}

/**
 * Resolve the projects a command should act on: explicit paths if given,
 * otherwise whatever discovery finds under the configured roots.
 */
export async function getProjects(
  config: DepstormConfig,
  opts: CliOptions,
): Promise<ProjectInfo[]> {
  if (opts.project) {
    return resolveExplicitProjects(opts.project as string[]);
  }
  if (config.projects?.length) {
    return resolveExplicitProjects(config.projects);
  }
  const roots = resolveRoots(config, process.cwd());
  return discoverProjects(roots, config);
}
