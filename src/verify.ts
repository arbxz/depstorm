import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import { timeoutMs, type BuildResult, type DepstormConfig, type ProjectInfo } from "./types.js";

const MAX_OUTPUT_BYTES = 2000;
/** How much of a failing build's output to echo to the console. */
const BUILD_ERROR_LINES = 15;

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
 * Scripts worth running to prove a dependency change did not break anything,
 * best evidence first.
 *
 * React Native and Expo have no build that runs without native SDKs, so they
 * start further down the list.
 */
const VERIFY_SCRIPTS = ["build", "typecheck", "test"] as const;
const RN_VERIFY_SCRIPTS = ["typecheck", "lint", "test"] as const;

/**
 * Pick the best verification strategy for a project.
 *
 * The chain matters: only checking for a `build` script meant every project
 * without one was committed with no verification at all and reported as
 * "skipped" — technically honest, but a large share of libraries and every
 * app using a bundler-less setup fell into it.
 */
async function pickVerifyCommand(
  project: ProjectInfo,
  pkg: Record<string, unknown>,
): Promise<{ label: string; bin: string; args: string[] } | null> {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const candidates = isReactNative(pkg) ? RN_VERIFY_SCRIPTS : VERIFY_SCRIPTS;

  for (const script of candidates) {
    if (scripts[script]) {
      return {
        label: script,
        bin: project.packageManager,
        args: ["run", script],
      };
    }
  }

  // No script to lean on, but a TypeScript project can still be type-checked,
  // which catches the shape of breakage a dependency bump usually causes.
  const hasTsConfig = await fs
    .access(path.join(project.path, "tsconfig.json"))
    .then(() => true)
    .catch(() => false);
  if (hasTsConfig) {
    return { label: "tsc --noEmit", bin: "npx", args: ["tsc", "--noEmit"] };
  }

  return null;
}

/**
 * Run the project's build script to verify fixes didn't break anything.
 *
 * NOTE: this executes code from the target project by design. It only runs
 * for projects the user pointed depstorm at.
 */
export async function verifyBuild(
  project: ProjectInfo,
  config: Pick<DepstormConfig, "timeouts"> = {},
): Promise<BuildResult> {
  consola.start(`Verifying build for ${project.name}...`);

  const pkg = await readPackageJson(project.path);
  const cmd = await pickVerifyCommand(project, pkg);

  if (!cmd) {
    const tried = (
      isReactNative(pkg) ? RN_VERIFY_SCRIPTS : VERIFY_SCRIPTS
    ).join(", ");
    const reason = `No ${tried} script and no tsconfig.json — nothing to verify, so this fix is UNVERIFIED`;
    consola.warn(`${project.name}: ${reason}`);
    return { success: true, skipped: true, output: reason };
  }

  consola.info(`${project.name}: Running "${cmd.label}"...`);

  try {
    const result = await execa(cmd.bin, cmd.args, {
      cwd: project.path,
      reject: false,
      timeout: timeoutMs(config, "build"),
    });

    const stdout = (result.stdout ?? "").slice(-MAX_OUTPUT_BYTES);

    if (result.exitCode === 0) {
      consola.success(`${project.name}: Build passed`);
      return { success: true, skipped: false, output: stdout };
    }

    const stderr = (result.stderr ?? "").slice(-MAX_OUTPUT_BYTES);

    // Without this the console says only "Build failed", and the reason for a
    // revert is invisible unless someone goes digging in the JSON report.
    const detail = (stderr.trim() || stdout.trim())
      .split("\n")
      .slice(-BUILD_ERROR_LINES)
      .join("\n");

    consola.error(
      `${project.name}: Build failed${detail ? `\n${detail}` : ""}`,
    );
    return {
      success: false,
      skipped: false,
      output: stdout,
      error: stderr,
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
