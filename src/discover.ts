import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import type { PackageManager, ProjectInfo, WizardConfig } from "./types.js";

const LOCKFILE_MAP: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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
  return exists(path.join(projectPath, ".git"));
}

/**
 * Recursively scan directories to find projects containing package.json
 */
async function scanDir(
  dir: string,
  depth: number,
  config: WizardConfig,
  results: ProjectInfo[],
): Promise<void> {
  if (depth < 0) return;

  const pkgPath = path.join(dir, "package.json");
  if (await exists(pkgPath)) {
    try {
      const raw = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as { name?: string };
      const pm = await detectPackageManager(dir);
      const git = await hasGitRepo(dir);

      results.push({
        name: pkg.name ?? path.basename(dir),
        path: dir,
        packageManager: pm,
        hasGit: git,
      });

      consola.debug(`Found project: ${pkg.name ?? dir} (${pm})`);
    } catch {
      consola.warn(`Failed to parse package.json in ${dir}`);
    }
    // Don't recurse into a project's subdirectories
    return;
  }

  // Recurse into subdirectories
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
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
      scanDir(path.join(dir, sub.name), depth - 1, config, results),
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

  consola.start("Scanning for projects...");

  for (const root of roots) {
    if (!(await exists(root))) {
      consola.warn(`Root directory not found: ${root}`);
      continue;
    }
    await scanDir(root, config.scanDepth, config, projects);
  }

  consola.success(`Discovered ${projects.length} project(s)`);
  return projects;
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
    if (!(await exists(path.join(absPath, "package.json")))) {
      consola.warn(`No package.json found at ${absPath}, skipping`);
      continue;
    }
    try {
      const raw = await fs.readFile(
        path.join(absPath, "package.json"),
        "utf-8",
      );
      const pkg = JSON.parse(raw) as { name?: string };
      const pm = await detectPackageManager(absPath);
      const git = await hasGitRepo(absPath);

      results.push({
        name: pkg.name ?? path.basename(absPath),
        path: absPath,
        packageManager: pm,
        hasGit: git,
      });
    } catch {
      consola.warn(`Failed to read project at ${absPath}`);
    }
  }

  return results;
}
