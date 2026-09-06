import { cosmiconfig } from "cosmiconfig";
import consola from "consola";
import path from "node:path";
import { expiredRules, parseIgnoreRules } from "./ignore.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_TIMEOUTS,
  SEVERITIES,
  isSeverity,
  type DepstormConfig,
  type Severity,
  type TimeoutStep,
} from "./types.js";

const TIMEOUT_STEPS = Object.keys(DEFAULT_TIMEOUTS) as TimeoutStep[];

const MODULE_NAME = "depstorm";

/**
 * Data-only config formats. Executable config (`depstorm.config.js`) is
 * deliberately NOT supported: cosmiconfig searches upwards from the cwd, so
 * allowing JS would mean running depstorm inside an untrusted repository
 * executes that repository's code.
 */
const explorer = cosmiconfig(MODULE_NAME, {
  searchPlaces: [
    `.${MODULE_NAME}.json`,
    `.${MODULE_NAME}.yaml`,
    `.${MODULE_NAME}.yml`,
    `.${MODULE_NAME}rc`,
    `.${MODULE_NAME}rc.json`,
    `.${MODULE_NAME}rc.yaml`,
    `.${MODULE_NAME}rc.yml`,
  ],
});

export async function loadConfig(configPath?: string): Promise<DepstormConfig> {
  try {
    const result = configPath
      ? await explorer.load(configPath)
      : await explorer.search();

    if (result && !result.isEmpty) {
      consola.info(`Loaded config from ${result.filepath}`);
      return mergeConfig(result.config, result.filepath);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (configPath) {
      // An explicitly requested config that cannot be read is a hard error —
      // silently falling back to defaults would run with the wrong settings.
      throw new Error(`Failed to load config "${configPath}": ${message}`);
    }
    consola.warn(`Failed to load config: ${message}`);
  }

  consola.info("Using default configuration");
  return { ...DEFAULT_CONFIG };
}

/**
 * Validate and normalise a user-supplied config.
 *
 * Unknown or malformed values are reported loudly rather than silently
 * coerced — an unrecognised `severityThreshold` used to make every comparison
 * false, which quietly disabled fixing altogether.
 */
export function mergeConfig(raw: unknown, source = "config"): DepstormConfig {
  const problems: string[] = [];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: expected a JSON object`);
  }

  const input = raw as Record<string, unknown>;
  const config: DepstormConfig = { ...DEFAULT_CONFIG };

  const stringArray = (key: string): string[] | undefined => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string")
    ) {
      problems.push(`"${key}" must be an array of strings`);
      return undefined;
    }
    return value as string[];
  };

  const bool = (key: keyof DepstormConfig): boolean | undefined => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      problems.push(`"${String(key)}" must be true or false`);
      return undefined;
    }
    return value;
  };

  const str = (key: string): string | undefined => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`"${key}" must be a non-empty string`);
      return undefined;
    }
    return value;
  };

  const severity = (key: string): Severity | undefined => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (!isSeverity(value)) {
      problems.push(`"${key}" must be one of: ${SEVERITIES.join(", ")}`);
      return undefined;
    }
    return value;
  };

  /** Assign only when the key was actually supplied, so absent stays absent */
  const set = <K extends keyof DepstormConfig>(
    key: K,
    value: DepstormConfig[K] | undefined,
  ): void => {
    if (value !== undefined) config[key] = value;
  };

  config.roots = stringArray("roots") ?? DEFAULT_CONFIG.roots;
  config.excludeDirs = stringArray("excludeDirs") ?? DEFAULT_CONFIG.excludeDirs;
  config.severityThreshold =
    severity("severityThreshold") ?? DEFAULT_CONFIG.severityThreshold;

  set("projects", stringArray("projects"));
  set("failOn", severity("failOn"));
  set("failOnQuality", severity("failOnQuality"));
  set("schedule", str("schedule"));
  set("sourceBranch", str("sourceBranch"));
  set("reportPath", str("reportPath"));

  for (const key of [
    "autoFix",
    "verifyBuild",
    "revertOnFailure",
    "gitBranch",
    "gitCommit",
    "gitPush",
    "gitMerge",
    "autoStash",
    "sonarCheck",
    "dryRun",
    "allowInstallScripts",
    "baselineVerify",
  ] as const) {
    set(key, bool(key));
  }

  const depth = input.scanDepth;
  if (depth !== undefined) {
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0) {
      problems.push(`"scanDepth" must be a non-negative integer`);
    } else {
      config.scanDepth = depth;
    }
  }

  const concurrency = input.concurrency;
  if (concurrency !== undefined) {
    if (
      typeof concurrency !== "number" ||
      !Number.isInteger(concurrency) ||
      concurrency < 1
    ) {
      problems.push(`"concurrency" must be an integer of 1 or more`);
    } else {
      config.concurrency = concurrency;
    }
  }

  const minReleaseAge = input.minReleaseAgeDays;
  if (minReleaseAge !== undefined) {
    if (
      typeof minReleaseAge !== "number" ||
      !Number.isFinite(minReleaseAge) ||
      minReleaseAge < 0
    ) {
      problems.push(`"minReleaseAgeDays" must be a non-negative number`);
    } else {
      config.minReleaseAgeDays = minReleaseAge;
    }
  }

  const branches = input.projectBranches;
  if (branches !== undefined) {
    if (
      branches === null ||
      typeof branches !== "object" ||
      Array.isArray(branches) ||
      Object.values(branches).some((v) => typeof v !== "string")
    ) {
      problems.push(`"projectBranches" must be an object of string values`);
    } else {
      config.projectBranches = branches as Record<string, string>;
    }
  }

  const timeouts = input.timeouts;
  if (timeouts !== undefined) {
    if (
      timeouts === null ||
      typeof timeouts !== "object" ||
      Array.isArray(timeouts)
    ) {
      problems.push(`"timeouts" must be an object of step: seconds`);
    } else {
      const resolved: Partial<Record<TimeoutStep, number>> = {};
      for (const [step, value] of Object.entries(timeouts)) {
        if (!TIMEOUT_STEPS.includes(step as TimeoutStep)) {
          problems.push(
            `"timeouts.${step}" is not a step (expected: ${TIMEOUT_STEPS.join(", ")})`,
          );
        } else if (typeof value !== "number" || !(value > 0)) {
          problems.push(`"timeouts.${step}" must be a positive number of seconds`);
        } else {
          resolved[step as TimeoutStep] = value;
        }
      }
      if (Object.keys(resolved).length > 0) config.timeouts = resolved;
    }
  }

  if (input.ignore !== undefined) {
    const parsed = parseIgnoreRules(input.ignore);
    problems.push(...parsed.problems);
    if (parsed.rules.length > 0) config.ignore = parsed.rules;
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid ${source}:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  // A lapsed suppression stops suppressing, but doing that silently would be
  // its own surprise — the advisory simply reappears with no explanation.
  const lapsed = expiredRules(config.ignore);
  if (lapsed.length > 0) {
    consola.warn(
      `${lapsed.length} ignore rule(s) have expired and no longer suppress anything:\n${lapsed
        .map(
          (rule) =>
            `  - ${rule.package ?? rule.advisory ?? "?"} (expired ${rule.expires ?? "?"}) — ${rule.reason}`,
        )
        .join("\n")}`,
    );
  }

  return normaliseGitFlags(config);
}

/**
 * Collapse git flags into a coherent state.
 *
 * The four booleans allow combinations that used to do surprising things —
 * notably `gitMerge` without `gitCommit`, which merged whatever branch the
 * user happened to be on into the source branch.
 */
export function normaliseGitFlags(config: DepstormConfig): DepstormConfig {
  if (config.gitMerge && !config.gitBranch) {
    consola.warn(
      'Config: "gitMerge" requires "gitBranch" — enabling branch creation',
    );
    config.gitBranch = true;
  }
  if ((config.gitBranch || config.gitPush || config.gitMerge) && !config.gitCommit) {
    consola.warn(
      'Config: git branch/push/merge require "gitCommit" — enabling commits',
    );
    config.gitCommit = true;
  }
  return config;
}

export function resolveRoots(config: DepstormConfig, cwd: string): string[] {
  return config.roots.map((root) =>
    path.isAbsolute(root) ? root : path.resolve(cwd, root),
  );
}

/**
 * Turn a user-supplied report path into a base path without an extension.
 *
 * `path.parse` is used rather than a regex: `"./audit-reports/report"` has a
 * leading dot and no extension, and a naive `/\.[^.]+$/` strip collapsed the
 * whole path to an empty string, writing reports to `./.json` in the cwd.
 */
export function resolveReportBase(reportPath: string, cwd: string): string {
  const absolute = path.isAbsolute(reportPath)
    ? reportPath
    : path.resolve(cwd, reportPath);
  const parsed = path.parse(absolute);
  const known = [".json", ".html", ".htm"];
  const name = known.includes(parsed.ext.toLowerCase())
    ? parsed.name
    : parsed.base;
  return path.join(parsed.dir, name);
}
