import { execa } from "execa";
import consola from "consola";
import type {
  AuditResult,
  ProjectInfo,
  Severity,
  Vulnerability,
} from "./types.js";

interface NpmAuditVuln {
  name: string;
  severity: Severity;
  title?: string;
  url?: string;
  range?: string;
  fixAvailable: boolean | { name: string; version: string };
}

interface NpmAuditJson {
  vulnerabilities?: Record<string, NpmAuditVuln>;
  metadata?: {
    vulnerabilities?: Record<Severity, number>;
  };
}

interface PnpmAuditAdvisory {
  module_name?: string;
  severity?: Severity;
  title?: string;
  url?: string;
  vulnerable_versions?: string;
  patched_versions?: string;
}

interface PnpmAuditJson {
  advisories?: Record<string, PnpmAuditAdvisory>;
  metadata?: {
    vulnerabilities?: Record<Severity, number>;
  };
}

function initSeverityMap(): Record<Severity, number> {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
}

function parseNpmAudit(json: NpmAuditJson): Vulnerability[] {
  const vulns: Vulnerability[] = [];
  const vulnerabilities = json.vulnerabilities ?? {};

  for (const [name, data] of Object.entries(vulnerabilities)) {
    vulns.push({
      name,
      severity: data.severity,
      title: data.title ?? name,
      url: data.url ?? "",
      range: data.range ?? "*",
      fixAvailable:
        typeof data.fixAvailable === "boolean"
          ? data.fixAvailable
          : !!data.fixAvailable,
    });
  }

  return vulns;
}

function parsePnpmAudit(json: PnpmAuditJson): Vulnerability[] {
  const vulns: Vulnerability[] = [];
  const advisories = json.advisories ?? {};

  for (const [, advisory] of Object.entries(advisories)) {
    vulns.push({
      name: advisory.module_name ?? "unknown",
      severity: advisory.severity ?? "info",
      title: advisory.title ?? "",
      url: advisory.url ?? "",
      range: advisory.vulnerable_versions ?? "*",
      fixAvailable: !!advisory.patched_versions,
    });
  }

  return vulns;
}

export async function runAudit(project: ProjectInfo): Promise<AuditResult> {
  consola.start(`Auditing ${project.name} (${project.packageManager})...`);

  const bySeverity = initSeverityMap();
  let vulnerabilities: Vulnerability[] = [];

  try {
    const cmd =
      project.packageManager === "pnpm"
        ? { bin: "pnpm", args: ["audit", "--json"] }
        : project.packageManager === "yarn"
          ? { bin: "yarn", args: ["audit", "--json"] }
          : { bin: "npm", args: ["audit", "--json"] };

    const result = await execa(cmd.bin, cmd.args, {
      cwd: project.path,
      reject: false, // audit returns non-zero when vulns exist
    });

    const stdout = result.stdout;

    if (!stdout.trim()) {
      consola.success(`${project.name}: No audit output (clean)`);
      return {
        project,
        vulnerabilities: [],
        totalCount: 0,
        fixableCount: 0,
        bySeverity,
      };
    }

    // Yarn outputs NDJSON (one JSON per line), take the summary line
    if (project.packageManager === "yarn") {
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "auditSummary" && parsed.data?.vulnerabilities) {
            const counts = parsed.data.vulnerabilities as Record<
              Severity,
              number
            >;
            for (const sev of Object.keys(counts) as Severity[]) {
              bySeverity[sev] = counts[sev] ?? 0;
            }
          }
        } catch {
          // skip non-JSON lines
        }
      }
      const total = Object.values(bySeverity).reduce((a, b) => a + b, 0);
      return {
        project,
        vulnerabilities: [],
        totalCount: total,
        fixableCount: 0,
        bySeverity,
      };
    }

    const json = JSON.parse(stdout);

    if (project.packageManager === "pnpm") {
      vulnerabilities = parsePnpmAudit(json as PnpmAuditJson);
    } else {
      vulnerabilities = parseNpmAudit(json as NpmAuditJson);
    }

    for (const v of vulnerabilities) {
      bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
    }

    const fixableCount = vulnerabilities.filter((v) => v.fixAvailable).length;

    consola.info(
      `${project.name}: ${vulnerabilities.length} vulnerabilities found (${fixableCount} fixable)`,
    );

    return {
      project,
      vulnerabilities,
      totalCount: vulnerabilities.length,
      fixableCount,
      bySeverity,
    };
  } catch (err) {
    consola.error(`Failed to audit ${project.name}: ${err}`);
    return {
      project,
      vulnerabilities: [],
      totalCount: 0,
      fixableCount: 0,
      bySeverity,
    };
  }
}
