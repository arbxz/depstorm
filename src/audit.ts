import { execa } from "execa";
import consola from "consola";
import {
  emptySeverityMap,
  isSeverity,
  type AuditResult,
  type ProjectInfo,
  type Severity,
  type Vulnerability,
} from "./types.js";

const AUDIT_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

interface NpmAuditVuln {
  severity?: string;
  title?: string;
  url?: string;
  range?: string;
  fixAvailable?: boolean | { name: string; version: string };
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

function parseNpmAudit(json: NpmAuditJson): Vulnerability[] {
  return Object.entries(json.vulnerabilities ?? {}).map(([name, data]) => {
    // npm nests the advisory detail under `via` for transitive vulnerabilities
    const advisory = data.via?.find(
      (v): v is { title?: string; url?: string; severity?: string } =>
        typeof v === "object" && v !== null,
    );

    return {
      name,
      severity: toSeverity(data.severity ?? advisory?.severity),
      title: data.title ?? advisory?.title ?? name,
      url: data.url ?? advisory?.url ?? "",
      range: data.range ?? "*",
      fixAvailable: Boolean(data.fixAvailable),
    };
  });
}

function parsePnpmAudit(json: PnpmAuditJson): Vulnerability[] {
  return Object.values(json.advisories ?? {}).map((advisory) => ({
    name: advisory.module_name ?? "unknown",
    severity: toSeverity(advisory.severity),
    title: advisory.title ?? "",
    url: advisory.url ?? "",
    range: advisory.vulnerable_versions ?? "*",
    fixAvailable: Boolean(advisory.patched_versions),
  }));
}

/**
 * Yarn emits NDJSON: one JSON document per line. The `auditAdvisory` entries
 * carry the same advisory shape as pnpm, so real vulnerability detail is
 * available — the previous summary-only parse produced a non-zero count with
 * an empty vulnerability list, which made every downstream check a no-op.
 */
function parseYarnAudit(stdout: string): Vulnerability[] {
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
    });
  }

  return vulns;
}

function failed(message: string): AuditResult {
  return {
    vulnerabilities: [],
    totalCount: 0,
    fixableCount: 0,
    bySeverity: emptySeverityMap(),
    error: message,
  };
}

export async function runAudit(
  project: ProjectInfo,
  options: { quiet?: boolean } = {},
): Promise<AuditResult> {
  const log = options.quiet
    ? { start: () => {}, info: () => {}, success: () => {} }
    : {
        start: (m: string) => consola.start(m),
        info: (m: string) => consola.info(m),
        success: (m: string) => consola.success(m),
      };

  log.start(`Auditing ${project.name} (${project.packageManager})...`);

  const args =
    project.packageManager === "yarn"
      ? ["audit", "--json"]
      : ["audit", "--json"];

  let stdout: string;
  try {
    const result = await execa(project.packageManager, args, {
      cwd: project.path,
      reject: false, // audit exits non-zero when vulnerabilities exist
      timeout: AUDIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    stdout = result.stdout ?? "";

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
      bySeverity: emptySeverityMap(),
    };
  }

  let vulnerabilities: Vulnerability[];

  try {
    if (project.packageManager === "yarn") {
      vulnerabilities = parseYarnAudit(stdout);
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

  const bySeverity = emptySeverityMap();
  for (const v of vulnerabilities) {
    bySeverity[v.severity]++;
  }

  const fixableCount = vulnerabilities.filter((v) => v.fixAvailable).length;

  log.info(
    `${project.name}: ${vulnerabilities.length} vulnerabilities found (${fixableCount} fixable)`,
  );

  return {
    vulnerabilities,
    totalCount: vulnerabilities.length,
    fixableCount,
    bySeverity,
  };
}
