import { simpleGit, type SimpleGit } from "simple-git";
import consola from "consola";
import type { ProjectInfo, WizardConfig } from "./types.js";

function getGit(project: ProjectInfo): SimpleGit {
  return simpleGit(project.path);
}

function branchName(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `audit-fix/${date}`;
}

/**
 * Check for uncommitted/unstaged changes and prompt the user to stash them.
 * Returns true if the working tree is clean (or was stashed), false if the user declined.
 */
async function promptAndStashIfDirty(
  project: ProjectInfo,
  git: SimpleGit,
): Promise<boolean> {
  const status = await git.status();
  const dirty =
    status.modified.length > 0 ||
    status.not_added.length > 0 ||
    status.staged.length > 0;

  if (!dirty) return true;

  const changedFiles = [
    ...status.modified.map((f) => `  M ${f}`),
    ...status.not_added.map((f) => `  ? ${f}`),
    ...status.staged.map((f) => `  S ${f}`),
  ];

  consola.warn(
    `${project.name}: Working tree has uncommitted changes:\n${changedFiles.slice(0, 10).join("\n")}${changedFiles.length > 10 ? `\n  ... and ${changedFiles.length - 10} more` : ""}`,
  );

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

  if (answer === "skip") {
    consola.info(`${project.name}: Skipped by user`);
    return false;
  }

  await git.stash();
  consola.success(`${project.name}: Changes stashed`);
  return true;
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

/**
 * Checkout and pull the source branch to get the latest code.
 * Returns false if the user chose to skip due to dirty working tree.
 */
export async function pullSourceBranch(
  project: ProjectInfo,
  branch: string,
): Promise<boolean> {
  const git = getGit(project);

  try {
    const clean = await promptAndStashIfDirty(project, git);
    if (!clean) return false;

    // Check if the branch exists locally
    const branches = await git.branchLocal();
    if (!branches.all.includes(branch)) {
      // Try to check it out from remote
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

    // Pull latest changes
    try {
      await git.pull("origin", branch);
      consola.success(`${project.name}: Pulled latest from ${branch}`);
    } catch {
      consola.warn(
        `${project.name}: Could not pull from origin/${branch} (no remote?), continuing with local`,
      );
    }
    return true;
  } catch (err) {
    consola.error(`${project.name}: Failed to pull source branch: ${err}`);
    throw err;
  }
}

/**
 * Create a new branch for audit fixes.
 * Returns the branch name, or null if the user chose to skip due to dirty working tree.
 */
export async function createFixBranch(
  project: ProjectInfo,
): Promise<string | null> {
  const git = getGit(project);
  const name = branchName();

  try {
    const clean = await promptAndStashIfDirty(project, git);
    if (!clean) return null;

    // Create and checkout the branch
    const branches = await git.branchLocal();
    if (branches.all.includes(name)) {
      await git.checkout(name);
      consola.info(`${project.name}: Switched to existing branch ${name}`);
    } else {
      await git.checkoutLocalBranch(name);
      consola.info(`${project.name}: Created branch ${name}`);
    }

    return name;
  } catch (err) {
    consola.error(`${project.name}: Git branch error: ${err}`);
    throw err;
  }
}

/**
 * Commit the audit fix changes
 */
export async function commitFixes(
  project: ProjectInfo,
  fixedCount: number,
): Promise<void> {
  const git = getGit(project);

  try {
    await git.add(".");
    const status = await git.status();

    if (status.staged.length === 0) {
      consola.info(`${project.name}: No changes to commit`);
      return;
    }

    const message = `fix(deps): auto-fix ${fixedCount} security vulnerabilit${fixedCount === 1 ? "y" : "ies"}\n\nApplied by depstorm`;
    await git.commit(message);
    consola.success(`${project.name}: Committed fixes`);
  } catch (err) {
    consola.error(`${project.name}: Git commit error: ${err}`);
    throw err;
  }
}

/**
 * Revert all changes in the working tree (used when build fails)
 */
export async function revertChanges(project: ProjectInfo): Promise<void> {
  const git = getGit(project);

  try {
    await git.checkout(["--", "."]);
    await git.clean("fd");
    consola.info(`${project.name}: Reverted changes`);
  } catch (err) {
    consola.error(`${project.name}: Git revert error: ${err}`);
  }
}

/**
 * Switch back to the original branch
 */
export async function switchBack(
  project: ProjectInfo,
  originalBranch: string,
): Promise<void> {
  const git = getGit(project);

  try {
    await git.checkout(originalBranch);

    // Restore stashed changes if any
    try {
      const stashList = await git.stashList();
      if (stashList.total > 0) {
        await git.stash(["pop"]);
      }
    } catch {
      // no stash to pop
    }
  } catch (err) {
    consola.error(`${project.name}: Failed to switch back: ${err}`);
  }
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(project: ProjectInfo): Promise<string> {
  const git = getGit(project);
  const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
  return branch.trim();
}

/**
 * Check if a project has a specific branch locally
 */
export async function hasBranch(
  project: ProjectInfo,
  branch: string,
): Promise<boolean> {
  const git = getGit(project);
  const branches = await git.branchLocal();
  return branches.all.includes(branch);
}

/**
 * Push a branch to origin
 */
export async function pushBranch(
  project: ProjectInfo,
  branch: string,
): Promise<boolean> {
  const git = getGit(project);

  try {
    await git.push("origin", branch);
    consola.success(`${project.name}: Pushed ${branch} to origin`);
    return true;
  } catch (err) {
    consola.error(`${project.name}: Push failed: ${err}`);
    return false;
  }
}
