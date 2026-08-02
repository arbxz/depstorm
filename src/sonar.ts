import consola from "consola";
import {
  emptySeverityMap,
  type ProjectInfo,
  type Severity,
  type SonarIssue,
  type SonarResult,
} from "./types.js";

const ESLINT_SEVERITY_MAP: Record<number, Severity> = {
  1: "moderate", // warning
  2: "high", // error
};

/**
 * Run SonarJS code quality checks on a project using ESLint + eslint-plugin-sonarjs.
 *
 * ESLint is an optional dependency and is imported lazily so that a depstorm
 * install without it still audits and fixes normally.
 */
export async function runSonarCheck(
  project: ProjectInfo,
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
            Object.keys(plugin.rules ?? {}).map((rule) => [
              `sonarjs/${rule}`,
              "warn",
            ]),
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

    const results = await eslint.lintFiles(["."]);
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

    consola.warn(`${project.name}: SonarJS check failed — ${message}`);
    return {
      issues: [],
      issuesBySeverity,
      totalCount: 0,
      error: message,
    };
  }
}
