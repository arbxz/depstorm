import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import type { PackageManager, ProjectInfo, WizardConfig } from "./types.js";

const LOCKFILE_MAP: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
};

/** Cap on concurrent directory reads so large trees can't exhaust file handles */
const IO_CONCURRENCY = 16;

class Semaphore {
  private waiters: Array<() => void> = [];

  constructor(private slots: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.slots++;
  }
}

const io = new Semaphore(IO_CONCURRENCY);

async function exists(filePath: string): Promise<boolean> {
  return io.run(async () => {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  });
}

async function detectPackageManager(
  projectPath: string,
): Promise<PackageManager> {
  for (const [lockfile, pm] of Object.entries(LOCKFILE_MAP)) {
    if (await exists(path.join(projectPath, lockfile))) {
      return pm;
    }
  }
  return "npm"; // default fallback
}

async function hasGitRepo(projectPath: string): Promise<boolean> {
  // `.git` is a directory in a normal clone and a file in worktrees/submodules
  return exists(path.join(projectPath, ".git"));
}

async function readPackageJson(
  pkgPath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await io.run(() => fs.readFile(pkgPath, "utf-8"));
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A workspace root delegates its real dependencies to child packages, so
 * discovery must keep descending instead of stopping at the first package.json.
 */
async function isWorkspaceRoot(
  dir: string,
  pkg: Record<string, unknown>,
): Promise<boolean> {
  const workspaces = pkg.workspaces;
  if (Array.isArray(workspaces) && workspaces.length > 0) return true;
  if (
    workspaces !== null &&
    typeof workspaces === "object" &&
    Array.isArray((workspaces as { packages?: unknown }).packages)
  ) {
    return true;
  }
  return exists(path.join(dir, "pnpm-workspace.yaml"));
}

async function toProjectInfo(
  dir: string,
  pkg: Record<string, unknown>,
): Promise<ProjectInfo> {
  const name = typeof pkg.name === "string" ? pkg.name : path.basename(dir);
  return {
    name,
    path: dir,
    packageManager: await detectPackageManager(dir),
    hasGit: await hasGitRepo(dir),
  };
}

/**
 * Recursively scan directories to find projects containing package.json.
 *
 * `remaining` is the number of levels still allowed *below* `dir`, so
 * `scanDepth: 3` visits the root plus three levels — matching the docs.
 */
async function scanDir(
  dir: string,
  remaining: number,
  config: WizardConfig,
  results: ProjectInfo[],
): Promise<void> {
  const pkgPath = path.join(dir, "package.json");
  let keepDescending = true;

  if (await exists(pkgPath)) {
    const pkg = await readPackageJson(pkgPath);
    if (pkg) {
      results.push(await toProjectInfo(dir, pkg));
      consola.debug(`Found project: ${dir}`);
      // Only keep walking when this is a monorepo root; a leaf project's
      // subdirectories are its own source, not separate projects.
      keepDescending = await isWorkspaceRoot(dir, pkg);
    } else {
      consola.warn(`Failed to parse package.json in ${dir}`);
      keepDescending = false;
    }
  }

  if (!keepDescending || remaining <= 0) return;

  let entries;
  try {
    entries = await io.run(() => fs.readdir(dir, { withFileTypes: true }));
  } catch {
    return;
  }

  const subdirs = entries.filter((e) => {
    if (!e.isDirectory()) return false;
    if (config.excludeDirs.includes(e.name)) return false;
    if (e.name.startsWith(".")) return false;
    return true;
  });

  await Promise.all(
    subdirs.map((sub) =>
      scanDir(path.join(dir, sub.name), remaining - 1, config, results),
    ),
  );
}

/**
 * Discover all projects in the configured root directories
 */
export async function discoverProjects(
  roots: string[],
  config: WizardConfig,
): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];
  const seen = new Set<string>();

  consola.start("Scanning for projects...");

  for (const root of roots) {
    if (!(await exists(root))) {
      consola.warn(`Root directory not found: ${root}`);
      continue;
    }
    await scanDir(root, config.scanDepth, config, projects);
  }

  // Overlapping roots can surface the same project twice
  const unique = projects.filter((p) => {
    const key = path.resolve(p.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  consola.success(`Discovered ${unique.length} project(s)`);
  return unique;
}

/**
 * Resolve explicitly listed project paths from config
 */
export async function resolveExplicitProjects(
  paths: string[],
): Promise<ProjectInfo[]> {
  const results: ProjectInfo[] = [];

  for (const p of paths) {
    const absPath = path.resolve(p);
    const pkgPath = path.join(absPath, "package.json");

    if (!(await exists(pkgPath))) {
      consola.warn(`No package.json found at ${absPath}, skipping`);
      continue;
    }

    const pkg = await readPackageJson(pkgPath);
    if (!pkg) {
      consola.warn(`Failed to read project at ${absPath}`);
      continue;
    }

    results.push(await toProjectInfo(absPath, pkg));
  }

  return results;
}
