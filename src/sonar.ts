import { ESLint } from "eslint";
import consola from "consola";
import type {
  ProjectInfo,
  Severity,
  SonarIssue,
  SonarResult,
} from "./types.js";

const ESLINT_SEVERITY_MAP: Record<number, Severity> = {
  1: "moderate", // warning
  2: "high", // error
};

/**
 * Run SonarJS code quality checks on a project using ESLint + eslint-plugin-sonarjs
 */
export async function runSonarCheck(
  project: ProjectInfo,
): Promise<SonarResult> {
  consola.start(`${project.name}: Running SonarJS code quality checks…`);

  const issuesBySeverity: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };

  try {
    const sonarPlugin = await import("eslint-plugin-sonarjs");

    const eslint = new ESLint({
      cwd: project.path,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.js", "**/*.ts", "**/*.jsx", "**/*.tsx"],
          plugins: {
            sonarjs: sonarPlugin.default ?? sonarPlugin,
          },
          rules: Object.fromEntries(
            Object.keys((sonarPlugin.default ?? sonarPlugin).rules ?? {}).map(
              (rule) => [`sonarjs/${rule}`, "warn"],
            ),
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

    const totalCount = issues.length;

    if (totalCount === 0) {
      consola.success(`${project.name}: No code quality issues found`);
    } else {
      consola.warn(
        `${project.name}: ${totalCount} code quality issue(s) found`,
      );
    }

    return { project, issues, issuesBySeverity, totalCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    consola.warn(`${project.name}: SonarJS check failed — ${message}`);
    return { project, issues: [], issuesBySeverity, totalCount: 0 };
  }
}
