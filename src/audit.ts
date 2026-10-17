import { execa } from "execa";
import consola from "consola";
import { applyIgnores } from "./ignore.js";
import {
  emptySeverityMap,
  isSeverity,
  timeoutMs,
  type AuditResult,
  type DepstormConfig,
  type IgnoreRule,
  type ProjectInfo,
  type Severity,
  type Vulnerability,
} from "./types.js";

/**
 * pnpm lists every dependency path to each vulnerable package, so a large tree
 * produces far more JSON than its advisory count suggests: an Expo app with a
 * handful of advisories emits ~128 MB. 32 MB cut that off mid-string. Kept
 * well under V8's ~512 MB limit on a single string.
 */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

interface NpmFixAvailable {
  name?: string;
  version?: string;
  /** npm's own signal that the fix is a semver-major bump */
  isSemVerMajor?: boolean;
}

interface NpmAuditVuln {
  severity?: string;
  title?: string;
  url?: string;
  range?: string;
  fixAvailable?: boolean | NpmFixAvailable;
  via?: Array<string | { title?: string; url?: string; severity?: string }>;
}

interface NpmAuditJson {
  vulnerabilities?: Record<string, NpmAuditVuln>;
  error?: { code?: string; summary?: string; detail?: string };
}

interface PnpmAuditAdvisory {
  module_name?: string;
  severity?: string;
  title?: string;
  url?: string;
  vulnerable_versions?: string;
  patched_versions?: string;
}

interface PnpmAuditJson {
  advisories?: Record<string, PnpmAuditAdvisory>;
}

function toSeverity(value: unknown): Severity {
  return isSeverity(value) ? value : "info";
}

/** @internal exported for tests */
export function parseNpmAudit(json: NpmAuditJson): Vulnerability[] {
  return Object.entries(json.vulnerabilities ?? {}).map(([name, data]) => {
    // npm nests the advisory detail under `via` for transitive vulnerabilities
    const advisory = data.via?.find(
      (v): v is { title?: string; url?: string; severity?: string } =>
        typeof v === "object" && v !== null,
    );

    // npm reports a semver-major remedy as an object carrying isSemVerMajor.
    // `npm audit fix` will not apply those without --force, so treating them
    // as plainly fixable promised a fix that never came.
    const fix = data.fixAvailable;
    const fixIsBreaking =
      typeof fix === "object" && fix !== null && fix.isSemVerMajor === true;

    // A `via` of bare package names means no advisory of its own: npm flags
    // the package only for what it depends on.
    const via = data.via ?? [];
    const inherited =
      advisory === undefined && via.length > 0
        ? via.filter((v): v is string => typeof v === "string")
        : undefined;

    return {
      name,
      severity: toSeverity(data.severity ?? advisory?.severity),
      title: data.title ?? advisory?.title ?? name,
      url: data.url ?? advisory?.url ?? "",
      range: data.range ?? "*",
      fixAvailable: Boolean(fix),
      fixIsBreaking,
      ...(inherited === undefined ? {} : { inheritedFrom: inherited }),
    };
  });
}

/**
 * @internal exported for tests
 *
 * `patched_versions` only says a patched release exists — it carries no signal
 * about whether reaching it crosses a major. Breaking-ness is therefore left
 * unknown (false) for pnpm, and the post-fix re-audit remains the source of
 * truth for what actually changed.
 */
export function parsePnpmAudit(json: PnpmAuditJson): Vulnerability[] {
  return Object.values(json.advisories ?? {}).map((advisory) => ({
    name: advisory.module_name ?? "unknown",
    severity: toSeverity(advisory.severity),
    title: advisory.title ?? "",
    url: advisory.url ?? "",
    range: advisory.vulnerable_versions ?? "*",
    fixAvailable: Boolean(advisory.patched_versions),
    fixIsBreaking: false,
  }));
}

/**
 * Yarn Berry (2+) has no `yarn audit`. Its equivalent is `yarn npm audit`,
 * which emits one JSON document per line keyed by package name:
 *
 *   {"value":"lodash","children":{"ID":"...","Severity":"high", ...}}
 *
 * Classic yarn 1 emits a different NDJSON shape, handled by parseYarnAudit.
 *
 * @internal exported for tests
 */
export function parseYarnBerryAudit(stdout: string): Vulnerability[] {
  const vulns: Vulnerability[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let parsed: {
      value?: string;
      children?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const children = parsed.children;
    if (!children || typeof parsed.value !== "string") continue;

    const pick = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = children[key];
        if (typeof value === "string" && value !== "") return value;
      }
      return undefined;
    };

    const name = parsed.value;
    const range = pick("Vulnerable Versions", "Range") ?? "*";
    const key = `${name}@${range}`;
    if (seen.has(key)) continue;
    seen.add(key);

    vulns.push({
      name,
      severity: toSeverity(pick("Severity")),
      title: pick("Issue", "Title") ?? "",
      url: pick("URL", "Url") ?? "",
      range,
      // Berry has `yarn npm audit` but still no non-interactive fix.
      fixAvailable: false,
      fixIsBreaking: false,
    });
  }

  return vulns;
}

/**
 * Yarn 1 emits NDJSON: one JSON document per line. The `auditAdvisory` entries
 * carry the same advisory shape as pnpm, so real vulnerability detail is
 * available — the previous summary-only parse produced a non-zero count with
 * an empty vulnerability list, which made every downstream check a no-op.
 */
export function parseYarnAudit(stdout: string): Vulnerability[] {
  const vulns: Vulnerability[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let parsed: { type?: string; data?: { advisory?: PnpmAuditAdvisory } };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (parsed.type !== "auditAdvisory" || !parsed.data?.advisory) continue;

    const advisory = parsed.data.advisory;
    const key = `${advisory.module_name}@${advisory.vulnerable_versions}`;
    if (seen.has(key)) continue;
    seen.add(key);

    vulns.push({
      name: advisory.module_name ?? "unknown",
      severity: toSeverity(advisory.severity),
      title: advisory.title ?? "",
      url: advisory.url ?? "",
      range: advisory.vulnerable_versions ?? "*",
      // Yarn has no non-interactive `audit fix`; see applyFix.
      fixAvailable: false,
      fixIsBreaking: false,
    });
  }

  return vulns;
}

/**
 * Yarn's major version, or 0 when it cannot be determined.
 *
 * Yarn 1 and Yarn Berry have different audit commands and different output
 * shapes, so the version has to be established before either is attempted.
 * Falling back to 0 keeps the classic path, which is what a machine without a
 * working yarn would have got anyway.
 */
async function yarnMajorVersion(project: ProjectInfo): Promise<number> {
  try {
    const result = await execa("yarn", ["--version"], {
      cwd: project.path,
      reject: false,
      timeout: 30_000,
    });
    const major = Number.parseInt((result.stdout ?? "").trim().split(".")[0] ?? "", 10);
    return Number.isInteger(major) ? major : 0;
  } catch {
    return 0;
  }
}

function failed(message: string): AuditResult {
  return {
    vulnerabilities: [],
    totalCount: 0,
    fixableCount: 0,
    breakingFixCount: 0,
    bySeverity: emptySeverityMap(),
    error: message,
  };
}

/**
 * Describe fixability without over-promising.
 *
 * pnpm's advisory feed only reports that a patched release exists, so its
 * "fixable" number is weaker evidence than npm's — the wording says so rather
 * than implying `audit fix` will clear them all.
 */
function describeFixability(
  packageManager: ProjectInfo["packageManager"],
  fixableCount: number,
  breakingFixCount: number,
): string {
  const label =
    packageManager === "pnpm" ? "with a published patch" : "fixable";
  const parts = [`${fixableCount} ${label}`];
  if (breakingFixCount > 0) {
    parts.push(`${breakingFixCount} require a breaking upgrade`);
  }
  return parts.join(", ");
}

export interface AuditOptions {
  quiet?: boolean;
  /**
   * Advisories to suppress. Applied here rather than by the caller so every
   * count downstream agrees — applyFix compares a before and an after audit,
   * and filtering only one of them would corrupt the arithmetic.
   */
  ignore?: IgnoreRule[];
  /** Per-step time limits, so a slow registry is configurable not fatal */
  timeouts?: DepstormConfig["timeouts"];
}

export async function runAudit(
  project: ProjectInfo,
  options: AuditOptions = {},
): Promise<AuditResult> {
  const log = options.quiet
    ? { start: () => {}, info: () => {}, success: () => {} }
    : {
        start: (m: string) => consola.start(m),
        info: (m: string) => consola.info(m),
        success: (m: string) => consola.success(m),
      };

  log.start(`Auditing ${project.name} (${project.packageManager})...`);

  // Yarn Berry dropped `yarn audit` entirely. Running it there produced a
  // generic "audit could not run" that told the user nothing actionable.
  const yarnMajor =
    project.packageManager === "yarn" ? await yarnMajorVersion(project) : 0;
  const berry = yarnMajor >= 2;

  const args = berry
    ? ["npm", "audit", "--json", "--all", "--recursive"]
    : ["audit", "--json"];

  let stdout: string;
  try {
    const result = await execa(project.packageManager, args, {
      cwd: project.path,
      reject: false, // audit exits non-zero when vulnerabilities exist
      timeout: timeoutMs(options, "audit"),
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    stdout = result.stdout ?? "";

    // Truncated output only ever surfaced as a JSON parse error, which reads
    // like a broken package manager rather than a buffer that was too small.
    if (result.isMaxBuffer) {
      return failed(
        `${project.packageManager} audit printed more than ${String(MAX_OUTPUT_BYTES / 1024 / 1024)} MB of JSON — run it by hand to inspect`,
      );
    }

    // A missing package manager surfaces as a spawn failure, not audit output
    if (result.failed && !stdout.trim()) {
      return failed(
        `${project.packageManager} audit could not run: ${
          (result.stderr ?? "").slice(0, 300) || result.message || "unknown error"
        }`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    consola.error(`Failed to audit ${project.name}: ${message}`);
    return failed(message);
  }

  if (!stdout.trim()) {
    log.success(`${project.name}: No audit output (clean)`);
    return {
      vulnerabilities: [],
      totalCount: 0,
      fixableCount: 0,
      breakingFixCount: 0,
      bySeverity: emptySeverityMap(),
    };
  }

  let vulnerabilities: Vulnerability[];

  try {
    if (project.packageManager === "yarn") {
      vulnerabilities = berry
        ? parseYarnBerryAudit(stdout)
        : parseYarnAudit(stdout);
    } else {
      const json: unknown = JSON.parse(stdout);
      if (json === null || typeof json !== "object") {
        return failed("Audit returned unexpected output");
      }
      if (project.packageManager === "pnpm") {
        vulnerabilities = parsePnpmAudit(json as PnpmAuditJson);
      } else {
        const npmJson = json as NpmAuditJson;
        if (npmJson.error) {
          return failed(
            npmJson.error.summary ?? npmJson.error.detail ?? "npm audit error",
          );
        }
        vulnerabilities = parseNpmAudit(npmJson);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A parse failure must never be reported as "no vulnerabilities"
    consola.error(`${project.name}: Could not parse audit output — ${message}`);
    return failed(`Could not parse audit output: ${message}`);
  }

  // Suppressions are applied before anything is counted, so totals, severity
  // breakdowns and --fail-on all describe the same set of advisories.
  const { vulnerabilities: kept, ignored } = partitionIgnored(
    vulnerabilities,
    options.ignore,
  );

  if (ignored.length > 0) {
    log.info(
      `${project.name}: ${ignored.length} advisor${ignored.length === 1 ? "y" : "ies"} suppressed by ignore rules`,
    );
  }
  vulnerabilities = kept;

  const bySeverity = emptySeverityMap();
  for (const v of vulnerabilities) {
    bySeverity[v.severity]++;
  }

  // A breaking fix is not something `audit fix` will apply, so it is counted
  // separately instead of inflating the number of fixes depstorm can deliver.
  const fixableCount = vulnerabilities.filter(
    (v) => v.fixAvailable && !v.fixIsBreaking,
  ).length;
  const breakingFixCount = vulnerabilities.filter((v) => v.fixIsBreaking).length;

  log.info(
    `${project.name}: ${vulnerabilities.length} vulnerabilities found (${describeFixability(
      project.packageManager,
      fixableCount,
      breakingFixCount,
    )})`,
  );

  return {
    vulnerabilities,
    totalCount: vulnerabilities.length,
    fixableCount,
    breakingFixCount,
    bySeverity,
    ...(ignored.length > 0 ? { ignored } : {}),
  };
}

/**
 * Split parsed advisories into those that still count and those a rule
 * suppresses. Reuses applyIgnores so there is one definition of "matched".
 */
function partitionIgnored(
  vulnerabilities: Vulnerability[],
  rules: IgnoreRule[] | undefined,
): { vulnerabilities: Vulnerability[]; ignored: Vulnerability[] } {
  const filtered = applyIgnores(
    {
      vulnerabilities,
      totalCount: vulnerabilities.length,
      fixableCount: 0,
      breakingFixCount: 0,
      bySeverity: emptySeverityMap(),
    },
    rules,
  );

  return {
    vulnerabilities: filtered.vulnerabilities,
    ignored: filtered.ignored ?? [],
  };
}
