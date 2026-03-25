import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import type { BuildResult, ProjectInfo } from "./types.js";

async function readPackageJson(
  projectPath: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(
      path.join(projectPath, "package.json"),
      "utf-8",
    );
    return JSON.parse(raw);
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
 * - React Native / Expo → tsc or lint (no native build possible without SDKs)
 * - Regular project → npm run build
 */
async function pickVerifyCommand(
  project: ProjectInfo,
  pkg: Record<string, unknown>,
): Promise<{ label: string; bin: string; args: string[] } | null> {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;

  if (isReactNative(pkg)) {
    // Prefer typecheck > lint > skip
    if (scripts["typecheck"]) {
      return {
        label: "typecheck",
        bin: project.packageManager,
        args: ["run", "typecheck"],
      };
    }
    if (scripts["lint"]) {
      return {
        label: "lint",
        bin: project.packageManager,
        args: ["run", "lint"],
      };
    }
    // Try bare tsc if tsconfig exists
    const hasTsConfig = await fs
      .access(path.join(project.path, "tsconfig.json"))
      .then(() => true)
      .catch(() => false);
    if (hasTsConfig) {
      return { label: "tsc --noEmit", bin: "npx", args: ["tsc", "--noEmit"] };
    }
    // Nothing useful to run
    return null;
  }

  // Regular project — use build script
  if (scripts["build"]) {
    return {
      label: "build",
      bin: project.packageManager === "yarn" ? "yarn" : project.packageManager,
      args: ["run", "build"],
    };
  }

  return null;
}

/**
 * Run the project's build script to verify fixes didn't break anything.
 * React Native / Expo projects use typecheck or lint instead.
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
    return { project, success: true, output: reason };
  }

  consola.info(`${project.name}: Running "${cmd.label}"...`);

  try {
    const result = await execa(cmd.bin, cmd.args, {
      cwd: project.path,
      reject: false,
      timeout: 5 * 60 * 1000, // 5 minute timeout
    });

    if (result.exitCode === 0) {
      consola.success(`${project.name}: Build passed`);
      return {
        project,
        success: true,
        output: result.stdout.slice(-2000), // last 2KB of output
      };
    }

    consola.error(`${project.name}: Build failed`);
    return {
      project,
      success: false,
      output: result.stdout.slice(-2000),
      error: result.stderr.slice(-2000),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // If there's no build script, that's fine
    if (message.includes("Missing script") || message.includes("not found")) {
      consola.info(
        `${project.name}: No build script found, skipping verification`,
      );
      return {
        project,
        success: true,
        output: "No build script — skipped",
      };
    }

    consola.error(`${project.name}: Build verification error: ${message}`);
    return {
      project,
      success: false,
      output: "",
      error: message,
    };
  }
}
