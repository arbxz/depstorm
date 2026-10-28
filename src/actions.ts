import consola from "consola";
import path from "node:path";
import { getCurrentBranch, hasBranch, mergeBranch, pushBranch } from "./git.js";
import { confirm } from "./prompt.js";
import {
  DEFAULT_RELEASE_BRANCHES,
  planRelease,
  releaseRepository,
  type ReleasePlan,
} from "./release.js";
import {
  DEFAULT_CONFIG,
  type DepstormConfig,
  type ProjectInfo,
} from "./types.js";

/**
 * Operations shared by the flag-driven CLI and the interactive wizard.
 *
 * Both front ends drive the same work; keeping it here is what stops the two
 * from drifting into subtly different behaviour for the same action.
 */

/** The branch name a same-day run would have created. */
export function defaultFixBranch(): string {
  return `audit-fix/${new Date().toISOString().slice(0, 10)}`;
}

export async function findProjectsWithBranch(
  projects: ProjectInfo[],
  branch: string,
): Promise<ProjectInfo[]> {
  const eligible: ProjectInfo[] = [];
  for (const p of projects.filter((p) => p.hasGit)) {
    if (await hasBranch(p, branch)) eligible.push(p);
  }
  return eligible;
}

export function listProjects(projects: ProjectInfo[], branch: string): void {
  console.log(
    `\n  Found \x1b[1m${projects.length}\x1b[0m project(s) with branch "${branch}":\n`,
  );
  for (const p of projects) console.log(`    - ${p.name}`);
  console.log();
}

export async function runPush(
  projects: ProjectInfo[],
  branch: string,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;

  for (const p of projects) {
    if (await pushBranch(p, branch)) ok++;
    else failed++;
  }

  console.log();
  consola.success(`Pushed: ${ok}, Failed: ${failed}`);
  if (ok > 0) {
    consola.info(`Create PRs to merge "${branch}" into your main branch.`);
  }
  return { ok, failed };
}

export async function runMerge(
  projects: ProjectInfo[],
  fixBranch: string,
  targetBranch: string,
  push: boolean,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;

  for (const p of projects) {
    const merged = await mergeBranch(p, fixBranch, targetBranch, {
      push,
      deleteBranch: true,
    });
    if (merged) ok++;
    else failed++;
  }

  console.log();
  consola.success(`Merged: ${ok}, Failed: ${failed}`);
  if (ok > 0 && !push) {
    consola.info(
      `Merges are local. Push "${targetBranch}" yourself, or re-run with --push.`,
    );
  }
  return { ok, failed };
}

/**
 * Release every repository that is on a release branch and has commits since
 * its last version tag. Each repository is released once, however many
 * projects it holds.
 */
export async function runRelease(
  projects: ProjectInfo[],
  config: DepstormConfig,
  options: { dryRun: boolean; assumeYes: boolean },
): Promise<{ ok: number; failed: number }> {
  const branches = config.releaseBranches ?? DEFAULT_RELEASE_BRANCHES;
  const roots = [
    ...new Map(
      projects
        .filter((p) => p.gitRoot !== undefined)
        .map((p) => [p.gitRoot as string, p] as const),
    ).keys(),
  ];

  const planned: { repo: ProjectInfo; branch: string; plan: ReleasePlan }[] = [];
  for (const root of roots) {
    const repo: ProjectInfo = {
      name: path.basename(root),
      path: root,
      packageManager: "npm",
      hasGit: true,
      gitRoot: root,
    };
    try {
      const branch = await getCurrentBranch(repo);
      if (!branches.includes(branch)) {
        consola.info(`${repo.name}: on ${branch}, not a release branch — skipping`);
        continue;
      }
      const plan = await planRelease(repo, branch);
      if ("skip" in plan) {
        consola.info(`${repo.name}: ${plan.skip}`);
        continue;
      }
      planned.push({ repo, branch, plan });
    } catch (err) {
      consola.warn(
        `${repo.name}: Could not check for a release: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (planned.length === 0) {
    consola.info("Nothing to release.");
    return { ok: 0, failed: 0 };
  }

  console.log(`\n  ${planned.length} release(s):\n`);
  for (const { repo, branch, plan } of planned) {
    console.log(
      `    - ${repo.name} (${branch}): ${plan.from} -> ${plan.to}, tag ${plan.tag}, ${plan.system.files.map((f) => f.file).join(", ")}${plan.system.tagWorkflow ? `; published by ${plan.system.tagWorkflow}` : ""}`,
    );
  }
  console.log();

  if (options.dryRun) return { ok: 0, failed: 0 };
  if (
    !(await confirm(`Commit, tag and push ${planned.length} release(s)?`, {
      assumeYes: options.assumeYes,
    }))
  ) {
    consola.info("Cancelled.");
    return { ok: 0, failed: 0 };
  }

  let ok = 0;
  let failed = 0;
  for (const { repo, branch } of planned) {
    const outcome = await releaseRepository(repo, branch, "Released with depstorm.");
    if (outcome) ok++;
    else failed++;
  }
  consola.success(`Released: ${ok}, Failed: ${failed}`);
  return { ok, failed };
}

const PM_COLORS: Record<string, string> = {
  npm: "\x1b[31m",
  pnpm: "\x1b[33m",
  yarn: "\x1b[34m",
};

export function actionScan(projects: ProjectInfo[]): void {
  console.log(`\n  Found \x1b[1m${projects.length}\x1b[0m project(s):\n`);

  for (const p of projects) {
    const color = PM_COLORS[p.packageManager] ?? "";
    const git = p.hasGit ? "\x1b[32m✓ git\x1b[0m" : "\x1b[90m✗ git\x1b[0m";
    console.log(
      `  ${color}${p.packageManager.padEnd(4)}\x1b[0m  ${p.name.padEnd(30)} ${git}`,
    );
    console.log(`  \x1b[90m      ${p.path}\x1b[0m`);
    // Worth showing: a project whose repository is an ancestor behaves
    // differently from one that is its own repository root.
    if (p.gitRoot && p.gitRoot !== p.path) {
      console.log(`  \x1b[90m      repo: ${p.gitRoot}\x1b[0m`);
    }
  }
  console.log();
}

/**
 * The file `depstorm init` writes.
 *
 * Derived from DEFAULT_CONFIG rather than restated, plus the few keys that
 * have no default but are worth showing someone starting out.
 */
export function starterConfig(): Record<string, unknown> {
  return {
    ...DEFAULT_CONFIG,
    schedule: "0 9 * * 1",
    reportPath: "./audit-reports/report",
    ignore: [],
  };
}

export async function actionInit(): Promise<void> {
  const fs = await import("node:fs/promises");
  const configPath = path.resolve(".depstorm.json");

  try {
    await fs.access(configPath);
    consola.warn("Config file already exists at " + configPath);
    return;
  } catch {
    // doesn't exist — good
  }

  await fs.writeFile(
    configPath,
    JSON.stringify(starterConfig(), null, 2) + "\n",
    "utf-8",
  );
  consola.success(`Created config at ${configPath}`);
  consola.info(
    "Reports contain absolute paths and build output — keep them out of version control.",
  );
}
