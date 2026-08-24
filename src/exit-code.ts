import consola from "consola";
import { hasQualityIssuesAtOrAbove, hasUnresolvedAtOrAbove } from "./report.js";
import { operationalFailure } from "./report.js";
import type { DepstormConfig, ProjectReport, Severity } from "./types.js";

/** Exit codes: 0 clean · 1 operational failure · 2 policy failure */
export const EXIT_OK = 0;
export const EXIT_OPERATIONAL_FAILURE = 1;
export const EXIT_POLICY_FAILURE = 2;

export interface ExitDecision {
  code: number;
  /** What went wrong, absent when the run was clean */
  reason?: string;
  /** Projects the reason refers to */
  projects?: string[];
}

const names = (reports: ProjectReport[]): string[] =>
  reports.map((report) => report.project.name);

/**
 * Decide what a completed run should exit with.
 *
 * Kept separate from `applyExitCode` and free of side effects: this is the
 * rule that makes depstorm usable as a CI gate, and it is worth being able to
 * assert on directly rather than through `process.exitCode`.
 *
 * The ordering is deliberate. A repository left in a state the user has to
 * repair outranks a policy threshold — being told "high severity remains"
 * matters less than being told your work in progress is sitting in a
 * conflicted stash.
 */
export function resolveExitCode(
  reports: ProjectReport[],
  config: DepstormConfig,
): ExitDecision {
  const unrestored = reports.filter((r) => r.stashRestore?.ok === false);
  if (unrestored.length > 0) {
    return {
      code: EXIT_OPERATIONAL_FAILURE,
      reason: `${unrestored.length} project(s) were left with unrestored work in progress`,
      projects: names(unrestored),
    };
  }

  const broken = reports.filter((r) => operationalFailure(r) !== undefined);
  if (broken.length > 0) {
    return {
      code: EXIT_OPERATIONAL_FAILURE,
      reason: `${broken.length} project(s) could not be audited, fixed or reverted cleanly`,
      projects: names(broken),
    };
  }

  if (config.failOn) {
    const threshold = config.failOn;
    const offenders = reports.filter((r) =>
      hasUnresolvedAtOrAbove(r, threshold as Severity),
    );
    if (offenders.length > 0) {
      return {
        code: EXIT_POLICY_FAILURE,
        reason: `${offenders.length} project(s) still have "${threshold}" or higher vulnerabilities`,
        projects: names(offenders),
      };
    }
  }

  if (config.failOnQuality) {
    const threshold = config.failOnQuality;
    const offenders = reports.filter((r) =>
      hasQualityIssuesAtOrAbove(r, threshold as Severity),
    );
    if (offenders.length > 0) {
      return {
        code: EXIT_POLICY_FAILURE,
        reason: `${offenders.length} project(s) still have "${threshold}" or higher code quality issues`,
        projects: names(offenders),
      };
    }
  }

  return { code: EXIT_OK };
}

/** Report the decision and set the process exit code from it. */
export function applyExitCode(
  reports: ProjectReport[],
  config: DepstormConfig,
): ExitDecision {
  const decision = resolveExitCode(reports, config);

  if (decision.code !== EXIT_OK && decision.reason) {
    const suffix = decision.projects?.length
      ? `: ${decision.projects.join(", ")}`
      : "";
    consola.error(`${decision.reason}${suffix}`);
  }

  process.exitCode = decision.code;
  return decision;
}
