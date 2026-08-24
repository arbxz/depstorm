import consola from "consola";
import {
  emptySeverityMap,
  timeoutMs,
  type DepstormConfig,
  type ProjectInfo,
  type Severity,
  type SonarIssue,
  type SonarResult,
} from "./types.js";

const ESLINT_SEVERITY_MAP: Record<number, Severity> = {
  1: "moderate", // warning
  2: "high", // error
};


export type RuleLevel = "error" | "warn" | "off";

/** The parts of an ESLint rule's `meta` this module actually reads. */
export interface RuleMetaLike {
  type?: string;
  deprecated?: unknown;
  docs?: { recommended?: boolean };
}

/**
 * Decide how loudly a SonarJS rule should report.
 *
 * Every rule used to be registered at "warn", so `msg.severity` was always 1,
 * the "high" branch of ESLINT_SEVERITY_MAP was unreachable, and the severity
 * breakdown in both reports was a single bucket dressed up as a distribution.
 *
 * SonarJS already separates bug risk from style: `meta.type === "problem"` is
 * the former, "suggestion" the latter. That distinction is what gets mapped.
 */
export function classifyRule(meta: RuleMetaLike | undefined): RuleLevel {
  // Deprecated rules are on their way out of the plugin and usually duplicate
  // a live one. Reporting them is noise the user cannot act on.
  if (meta?.deprecated) return "off";
  return meta?.type === "problem" ? "error" : "warn";
}

/** Reject rather than hang — a lint pass with no ceiling can outlast the run. */
function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** ESLint is optional; say what to install rather than leaking a loader error. */
function isMissingDependency(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /Cannot find (module|package) ['"]?(eslint|eslint-plugin-sonarjs)/i.test(
    message,
  );
}

/**
 * Run SonarJS code quality checks on a project using ESLint + eslint-plugin-sonarjs.
 *
 * ESLint is an optional dependency and is imported lazily so that a depstorm
 * install without it still audits and fixes normally.
 */
export async function runSonarCheck(
  project: ProjectInfo,
  config: Pick<DepstormConfig, "timeouts"> = {},
): Promise<SonarResult> {
  consola.start(`${project.name}: Running SonarJS code quality checks…`);

  const issuesBySeverity = emptySeverityMap();

  try {
    const [{ ESLint }, sonarPlugin] = await Promise.all([
      import("eslint"),
      import("eslint-plugin-sonarjs"),
    ]);

    const plugin = sonarPlugin.default ?? sonarPlugin;

    const eslint = new ESLint({
      cwd: project.path,
      // Ignore the target project's own ESLint config. Loading it would
      // execute code from the project being scanned.
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.js", "**/*.ts", "**/*.jsx", "**/*.tsx"],
          plugins: { sonarjs: plugin },
          rules: Object.fromEntries(
            Object.entries(plugin.rules ?? {})
              .map(
                ([rule, impl]) =>
                  [
                    `sonarjs/${rule}`,
                    classifyRule((impl as { meta?: RuleMetaLike }).meta),
                  ] as const,
              )
              .filter(([, level]) => level !== "off"),
          ),
        },
        {
          ignores: [
            "**/node_modules/**",
            "**/dist/**",
            "**/build/**",
            "**/.next/**",
            "**/.nuxt/**",
            "**/coverage/**",
          ],
        },
      ],
    });

    const results = await withTimeout(
      eslint.lintFiles(["."]),
      timeoutMs(config, "sonar"),
      `SonarJS check for ${project.name}`,
    );
    const issues: SonarIssue[] = [];


    for (const result of results) {
      const relFile = result.filePath
        .replace(project.path, "")
        .replace(/^[/\\]/, "");
      for (const msg of result.messages) {
        if (!msg.ruleId?.startsWith("sonarjs/")) continue;
        const severity = ESLINT_SEVERITY_MAP[msg.severity] ?? "info";
        issues.push({
          rule: msg.ruleId,
          severity,
          message: msg.message,
          file: relFile,
          line: msg.line,
          column: msg.column,
        });
        issuesBySeverity[severity]++;
      }
    }

    if (issues.length === 0) {
      consola.success(`${project.name}: No code quality issues found`);
    } else {
      consola.warn(
        `${project.name}: ${issues.length} code quality issue(s) found`,
      );
    }

    return { issues, issuesBySeverity, totalCount: issues.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // "All files matched by '.' are ignored" just means there is no lintable
    // source here — a clean result, not a failed check.
    if (/are ignored|matched by/i.test(message)) {
      consola.info(`${project.name}: No lintable source files`);
      return { issues: [], issuesBySeverity, totalCount: 0 };
    }

    if (isMissingDependency(err)) {
      const advice =
        "SonarJS checks need the optional \"eslint\" and \"eslint-plugin-sonarjs\" packages. Install them, or set \"sonarCheck\": false to stop asking.";
      consola.warn(`${project.name}: ${advice}`);
      return { issues: [], issuesBySeverity, totalCount: 0, error: advice };
    }

    consola.warn(`${project.name}: SonarJS check failed — ${message}`);
    return {
      issues: [],
      issuesBySeverity,
      totalCount: 0,
      error: message,
    };
  }
}
