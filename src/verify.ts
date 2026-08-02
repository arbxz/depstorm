import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import type { BuildResult, ProjectInfo } from "./types.js";

const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2000;

async function readPackageJson(
  projectPath: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(
      path.join(projectPath, "package.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isReactNative(pkg: Record<string, unknown>): boolean {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  return "react-native" in deps || "expo" in deps;
}

/**
 * Pick the best verification strategy for a project:
 * - React Native / Expo → typecheck or lint (no native build without SDKs)
 * - Regular project → the build script
 */
async function pickVerifyCommand(
  project: ProjectInfo,
  pkg: Record<string, unknown>,
): Promise<{ label: string; bin: string; args: string[] } | null> {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;

  if (isReactNative(pkg)) {
    for (const script of ["typecheck", "lint"] as const) {
      if (scripts[script]) {
        return {
          label: script,
          bin: project.packageManager,
          args: ["run", script],
        };
      }
    }

    const hasTsConfig = await fs
      .access(path.join(project.path, "tsconfig.json"))
      .then(() => true)
      .catch(() => false);
    if (hasTsConfig) {
      return { label: "tsc --noEmit", bin: "npx", args: ["tsc", "--noEmit"] };
    }
    return null;
  }

  if (scripts["build"]) {
    return {
      label: "build",
      bin: project.packageManager,
      args: ["run", "build"],
    };
  }

  return null;
}

/**
 * Run the project's build script to verify fixes didn't break anything.
 *
 * NOTE: this executes code from the target project by design. It only runs
 * for projects the user pointed depstorm at.
 */
export async function verifyBuild(project: ProjectInfo): Promise<BuildResult> {
  consola.start(`Verifying build for ${project.name}...`);

  const pkg = await readPackageJson(project.path);
  const cmd = await pickVerifyCommand(project, pkg);

  if (!cmd) {
    const reason = isReactNative(pkg)
      ? "React Native project — no typecheck/lint script available, skipping"
      : "No build script — skipped";
    consola.info(`${project.name}: ${reason}`);
    return { success: true, skipped: true, output: reason };
  }

  consola.info(`${project.name}: Running "${cmd.label}"...`);

  try {
    const result = await execa(cmd.bin, cmd.args, {
      cwd: project.path,
      reject: false,
      timeout: BUILD_TIMEOUT_MS,
    });

    const stdout = (result.stdout ?? "").slice(-MAX_OUTPUT_BYTES);

    if (result.exitCode === 0) {
      consola.success(`${project.name}: Build passed`);
      return { success: true, skipped: false, output: stdout };
    }

    consola.error(`${project.name}: Build failed`);
    return {
      success: false,
      skipped: false,
      output: stdout,
      error: (result.stderr ?? "").slice(-MAX_OUTPUT_BYTES),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("Missing script") || message.includes("not found")) {
      consola.info(
        `${project.name}: No build script found, skipping verification`,
      );
      return {
        success: true,
        skipped: true,
        output: "No build script — skipped",
      };
    }

    consola.error(`${project.name}: Build verification error: ${message}`);
    return { success: false, skipped: false, output: "", error: message };
  }
}
