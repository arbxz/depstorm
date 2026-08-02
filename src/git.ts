import { simpleGit, type SimpleGit } from "simple-git";
import consola from "consola";
import type { ProjectInfo, WizardConfig } from "./types.js";

function getGit(project: ProjectInfo): SimpleGit {
  return simpleGit(project.path);
}

/**
 * Git errors embed the command line, which for token-in-URL remotes means the
 * credential ends up in logs and reports. Strip anything that looks like one.
 */
export function redactGitError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1***:***@")
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, "$1***")
    .replace(/\b(glpat-)[A-Za-z0-9_-]{10,}/g, "$1***");
}

export interface StashHandle {
  /** Commit SHA of the stash depstorm created, so it pops its own and no other */
  sha: string;
  label: string;
}

function stashLabel(): string {
  return `depstorm-${new Date().toISOString()}`;
}

async function baseBranchName(git: SimpleGit): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const base = `audit-fix/${date}`;
  const existing = (await git.branchLocal()).all;

  if (!existing.includes(base)) return base;

  // Reusing a branch appends today's second run onto the first one's history
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Get the source branch for a project (per-project override or global)
 */
export function getSourceBranch(
  project: ProjectInfo,
  config: WizardConfig,
): string | undefined {
  return config.projectBranches?.[project.name] ?? config.sourceBranch;
}

export async function getCurrentBranch(project: ProjectInfo): Promise<string> {
  const branch = await getGit(project).revparse(["--abbrev-ref", "HEAD"]);
  return branch.trim();
}

export async function hasBranch(
  project: ProjectInfo,
  branch: string,
): Promise<boolean> {
  const branches = await getGit(project).branchLocal();
  return branches.all.includes(branch);
}

/**
 * Make sure the working tree is clean before depstorm starts moving between
 * branches, stashing only with consent.
 *
 * Returns the handle of the stash it created, if any, so the exact same stash
 * can be popped later — checking `stashList().total > 0` used to pop whatever
 * happened to be on top, including stashes the user made themselves.
 */
export async function ensureCleanTree(
  project: ProjectInfo,
  config: WizardConfig,
): Promise<{ ok: boolean; stash?: StashHandle }> {
  const git = getGit(project);
  const status = await git.status();

  const dirty =
    status.modified.length > 0 ||
    status.not_added.length > 0 ||
    status.staged.length > 0 ||
    status.deleted.length > 0 ||
    status.renamed.length > 0;

  if (!dirty) return { ok: true };

  const changed = [
    ...status.staged.map((f) => `  S ${f}`),
    ...status.modified.map((f) => `  M ${f}`),
    ...status.deleted.map((f) => `  D ${f}`),
    ...status.not_added.map((f) => `  ? ${f}`),
  ];

  consola.warn(
    `${project.name}: Working tree has uncommitted changes:\n${changed
      .slice(0, 10)
      .join("\n")}${changed.length > 10 ? `\n  ... and ${changed.length - 10} more` : ""}`,
  );

  if (config.dryRun) {
    consola.info(`${project.name}: [dry-run] would stash these changes`);
    return { ok: false };
  }

  if (!process.stdin.isTTY) {
    if (!config.autoStash) {
      // Unattended runs must not silently pocket someone's work in progress
      consola.warn(
        `${project.name}: Skipped — dirty working tree and no TTY to ask. Set "autoStash": true to stash automatically.`,
      );
      return { ok: false };
    }
    const stash = await createStash(git, project);
    return { ok: true, stash };
  }

  const answer = (await consola.prompt(
    `${project.name}: Stash these changes before proceeding?`,
    {
      type: "select",
      options: [
        { label: "Yes — stash changes and continue", value: "stash" },
        { label: "No — skip this project", value: "skip" },
      ],
    },
  )) as unknown as string;

  if (answer !== "stash") {
    consola.info(`${project.name}: Skipped by user`);
    return { ok: false };
  }

  const stash = await createStash(git, project);
  return { ok: true, stash };
}

async function createStash(
  git: SimpleGit,
  project: ProjectInfo,
): Promise<StashHandle | undefined> {
  const label = stashLabel();
  try {
    await git.stash(["push", "-m", label]);
    const sha = (await git.revparse(["stash@{0}"])).trim();
    consola.success(`${project.name}: Changes stashed (${label})`);
    return { sha, label };
  } catch (err) {
    consola.error(
      `${project.name}: Failed to stash changes: ${redactGitError(err)}`,
    );
    return undefined;
  }
}

/**
 * Pop the stash depstorm created — identified by SHA, never by position.
 */
export async function restoreStash(
  project: ProjectInfo,
  handle: StashHandle,
): Promise<void> {
  const git = getGit(project);

  try {
    const list = await git.stashList();
    const index = list.all.findIndex((entry) => entry.hash === handle.sha);

    if (index === -1) {
      consola.warn(
        `${project.name}: Could not find depstorm's stash (${handle.label}) — leaving the stash list untouched. Recover it with: git stash list`,
      );
      return;
    }

    await git.stash(["pop", `stash@{${index}}`]);
    consola.success(`${project.name}: Restored stashed changes`);
  } catch (err) {
    consola.error(
      `${project.name}: Failed to restore stash "${handle.label}": ${redactGitError(err)}. Your changes are still in "git stash list".`,
    );
  }
}

/**
 * Checkout and pull the source branch to get the latest code.
 * Assumes the working tree is already clean (see ensureCleanTree).
 */
export async function pullSourceBranch(
  project: ProjectInfo,
  branch: string,
): Promise<boolean> {
  const git = getGit(project);

  try {
    const branches = await git.branchLocal();

    if (!branches.all.includes(branch)) {
      try {
        await git.checkout(["-b", branch, `origin/${branch}`]);
      } catch {
        consola.warn(
          `${project.name}: Branch "${branch}" not found locally or on remote, using current branch`,
        );
        return true;
      }
    } else {
      await git.checkout(branch);
    }

    try {
      await git.pull("origin", branch);
      consola.success(`${project.name}: Pulled latest from ${branch}`);
    } catch (err) {
      consola.warn(
        `${project.name}: Could not pull from origin/${branch}, continuing with local: ${redactGitError(err)}`,
      );
    }
    return true;
  } catch (err) {
    consola.error(
      `${project.name}: Failed to pull source branch: ${redactGitError(err)}`,
    );
    return false;
  }
}

/**
 * Create a fresh branch for audit fixes. Returns the branch name, or null on failure.
 */
export async function createFixBranch(
  project: ProjectInfo,
): Promise<string | null> {
  const git = getGit(project);

  try {
    const name = await baseBranchName(git);
    await git.checkoutLocalBranch(name);
    consola.info(`${project.name}: Created branch ${name}`);
    return name;
  } catch (err) {
    consola.error(
      `${project.name}: Git branch error: ${redactGitError(err)}`,
    );
    return null;
  }
}

/**
 * Commit the audit fix changes.
 *
 * Only the manifest and lockfile are staged — `git add .` swept up unrelated
 * work and, with auto-merge enabled, carried it onto the source branch.
 */
export async function commitFixes(
  project: ProjectInfo,
  paths: string[],
  fixedCount: number,
  verified: boolean,
): Promise<boolean> {
  const git = getGit(project);

  if (paths.length === 0) {
    consola.info(`${project.name}: Nothing to stage`);
    return false;
  }

  try {
    await git.add(paths);
    const status = await git.status();

    if (status.staged.length === 0) {
      consola.info(`${project.name}: No changes to commit`);
      return false;
    }

    const plural = fixedCount === 1 ? "y" : "ies";
    const qualifier = verified ? "" : " (unverified)";
    const message = `fix(deps): auto-fix ${fixedCount} security vulnerabilit${plural}${qualifier}\n\nApplied by depstorm to: ${status.staged.join(", ")}`;

    await git.commit(message);
    consola.success(`${project.name}: Committed fixes`);
    return true;
  } catch (err) {
    consola.error(
      `${project.name}: Git commit error: ${redactGitError(err)}`,
    );
    return false;
  }
}

/**
 * Undo a failed fix by restoring only the files depstorm touched.
 *
 * This deliberately does NOT run `git checkout -- .` or `git clean -fd`: those
 * discarded unrelated uncommitted work and deleted untracked files.
 */
export async function revertTouchedFiles(
  project: ProjectInfo,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const git = getGit(project);

  try {
    await git.checkout(["--", ...paths]);
    consola.info(`${project.name}: Reverted ${paths.join(", ")}`);
  } catch (err) {
    consola.error(
      `${project.name}: Git revert error: ${redactGitError(err)}`,
    );
  }
}

/**
 * Switch back to the branch the project was on when depstorm found it
 */
export async function switchBack(
  project: ProjectInfo,
  originalBranch: string,
): Promise<void> {
  try {
    const current = await getCurrentBranch(project);
    if (current === originalBranch) return;
    await getGit(project).checkout(originalBranch);
    consola.debug(`${project.name}: Switched back to ${originalBranch}`);
  } catch (err) {
    consola.error(
      `${project.name}: Failed to switch back to ${originalBranch}: ${redactGitError(err)}`,
    );
  }
}

export async function pushBranch(
  project: ProjectInfo,
  branch: string,
): Promise<boolean> {
  try {
    await getGit(project).push("origin", branch);
    consola.success(`${project.name}: Pushed ${branch} to origin`);
    return true;
  } catch (err) {
    consola.error(`${project.name}: Push failed: ${redactGitError(err)}`);
    return false;
  }
}

export interface MergeOptions {
  /** Push the target branch after merging. Never implied by merging alone. */
  push: boolean;
  /** Delete the fix branch once the merge is durable */
  deleteBranch?: boolean;
}

/**
 * Merge a fix branch into the target branch.
 *
 * Pushing is opt-in: merging used to push the result to origin unconditionally,
 * which turned a local operation into a write to a shared branch.
 */
export async function mergeBranch(
  project: ProjectInfo,
  fixBranch: string,
  targetBranch: string,
  options: MergeOptions = { push: false },
): Promise<boolean> {
  const git = getGit(project);

  if (fixBranch === targetBranch) {
    consola.warn(
      `${project.name}: Refusing to merge "${fixBranch}" into itself`,
    );
    return false;
  }

  try {
    await git.checkout(targetBranch);
    await git.merge([
      fixBranch,
      "--no-ff",
      "-m",
      `Merge ${fixBranch} into ${targetBranch}`,
    ]);
    consola.success(
      `${project.name}: Merged ${fixBranch} into ${targetBranch}`,
    );

    let pushed = true;
    if (options.push) {
      pushed = await pushBranch(project, targetBranch);
      if (!pushed) {
        consola.warn(
          `${project.name}: Merge succeeded locally but the push failed — keeping ${fixBranch}`,
        );
      }
    }

    if (options.deleteBranch && pushed) {
      try {
        await git.deleteLocalBranch(fixBranch);
        consola.info(`${project.name}: Deleted local branch ${fixBranch}`);
      } catch {
        // not critical
      }
    }

    return true;
  } catch (err) {
    consola.error(`${project.name}: Merge failed: ${redactGitError(err)}`);

    try {
      await git.merge(["--abort"]);
      consola.info(`${project.name}: Aborted the conflicted merge`);
    } catch {
      // not in a merge state
    }

    return false;
  }
}
