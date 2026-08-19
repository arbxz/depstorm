import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import consola from "consola";
import type { ProjectInfo, WizardConfig } from "../../src/types.js";
import { DEFAULT_CONFIG } from "../../src/types.js";

/** Keep test output readable — the modules under test log heavily */
export function silenceLogs(): void {
  consola.level = -999;
}

const createdDirs: string[] = [];

/**
 * Create an isolated temp directory. Always under the OS temp dir so a test
 * can never touch the working repository.
 */
export function tempDir(prefix = "depstorm-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/** Remove every directory created by tempDir() */
export function cleanupTempDirs(): void {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows occasionally holds a handle; the OS reclaims temp dirs anyway
    }
  }
}

export function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export function readFile(dir: string, relPath: string): string {
  return fs.readFileSync(path.join(dir, relPath), "utf-8");
}

export function fileExists(dir: string, relPath: string): boolean {
  return fs.existsSync(path.join(dir, relPath));
}

export function writeJson(dir: string, relPath: string, value: unknown): void {
  writeFile(dir, relPath, JSON.stringify(value, null, 2) + "\n");
}

/** Run a git command in `cwd` and return trimmed stdout */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

export interface TestRepoOptions {
  /** Files to create and commit in the initial commit */
  files?: Record<string, string>;
  /** Branch name for the initial commit */
  branch?: string;
}

/**
 * Create a throwaway git repository with one commit.
 *
 * Identity and autocrlf are set locally so the tests behave identically
 * regardless of the developer's global git config.
 */
export function createRepo(options: TestRepoOptions = {}): string {
  const dir = tempDir();
  const files = options.files ?? {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "package-lock.json": '{"lockfileVersion":3}\n',
    "src.js": "original\n",
  };

  for (const [name, content] of Object.entries(files)) {
    writeFile(dir, name, content);
  }

  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "test@depstorm.invalid");
  git(dir, "config", "user.name", "depstorm tests");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "initial");

  // Pin the default branch name so tests don't depend on init.defaultBranch
  git(dir, "branch", "-M", options.branch ?? "main");

  return dir;
}

export function commitAll(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
}

export function currentBranch(dir: string): string {
  return git(dir, "rev-parse", "--abbrev-ref", "HEAD");
}

export function localBranches(dir: string): string[] {
  return git(dir, "branch", "--format=%(refname:short)")
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean);
}

export function stashCount(dir: string): number {
  const list = git(dir, "stash", "list");
  return list ? list.split("\n").filter(Boolean).length : 0;
}

export function isDirty(dir: string): boolean {
  return git(dir, "status", "--porcelain").length > 0;
}

export function projectInfo(
  dir: string,
  overrides: Partial<ProjectInfo> = {},
): ProjectInfo {
  return {
    name: path.basename(dir),
    path: dir,
    packageManager: "npm",
    hasGit: true,
    ...overrides,
  };
}

export function testConfig(overrides: Partial<WizardConfig> = {}): WizardConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export interface CapturedLog {
  type: string;
  text: string;
}

/**
 * Collect what the modules under test report, so a test can assert on the
 * absence of an alarming error and not just on the resulting git state.
 * Several bugs here were "right outcome, wrong report".
 */
export function captureLogs(): {
  logs: CapturedLog[];
  errors: () => string[];
  restore: () => void;
} {
  const logs: CapturedLog[] = [];
  const previousLevel = consola.level;
  const reporter = {
    log(entry: { type?: string; args?: unknown[] }) {
      logs.push({
        type: String(entry.type ?? ""),
        text: (entry.args ?? []).map((a) => String(a)).join(" "),
      });
    },
  };

  consola.level = 999;
  consola.addReporter(reporter);

  return {
    logs,
    errors: () =>
      logs.filter((l) => l.type === "error").map((l) => l.text),
    restore: () => {
      consola.removeReporter(reporter);
      consola.level = previousLevel;
    },
  };
}
