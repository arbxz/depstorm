import consola from "consola";
import type { DepstormConfig, ProjectInfo } from "./types.js";

const COMMON_BRANCHES = ["main", "master", "develop", "production"];

/**
 * Ask a yes/no question.
 *
 * Confirmations must never self-approve. consola returns the `initial` value
 * when there is no TTY, which silently green-lit merges in CI.
 */
export async function confirm(
  message: string,
  options: { assumeYes?: boolean } = {},
): Promise<boolean> {
  if (options.assumeYes) return true;

  if (!process.stdin.isTTY) {
    consola.warn(`${message} — no TTY to confirm. Pass --yes to proceed.`);
    return false;
  }

  return (await consola.prompt(message, {
    type: "confirm",
    initial: true,
  })) as unknown as boolean;
}

/**
 * Let the user narrow a discovered list. Everything is pre-selected, so the
 * default answer matches what depstorm used to do unconditionally.
 */
export async function selectProjects(
  projects: ProjectInfo[],
  message: string,
): Promise<ProjectInfo[]> {
  if (projects.length === 1) return projects;

  const selected = (await consola.prompt(message, {
    type: "multiselect",
    initial: projects.map((p) => p.path),
    options: projects.map((p) => ({
      label: p.name,
      value: p.path,
      hint: p.packageManager,
    })),
  })) as unknown as string[] | undefined;

  return projects.filter((p) => selected?.includes(p.path));
}

/**
 * Prompt the user to choose a source branch for pulling before fixes.
 * Supports global (all projects) or per-project branch selection.
 */
export async function promptBranchSelection(
  projects: ProjectInfo[],
  config: DepstormConfig,
): Promise<DepstormConfig> {
  const gitProjects = projects.filter((p) => p.hasGit);

  if (gitProjects.length === 0) {
    consola.info("No git projects found, skipping branch selection");
    return config;
  }

  // Ask for branch selection mode
  const mode = (await consola.prompt(
    "How would you like to set the source branch?",
    {
      type: "select",
      options: [
        { label: "Same branch for all projects (global)", value: "global" },
        { label: "Choose per project", value: "per-project" },
        {
          label: "Skip — use whatever branch each project is on",
          value: "skip",
        },
      ],
    },
  )) as unknown as string;

  if (mode === "skip") {
    return config;
  }

  if (mode === "global") {
    const branch = await promptBranchName("Source branch for all projects");
    if (branch) {
      config.sourceBranch = branch;
      consola.info(`All projects will pull from "${branch}" before fixing`);
    }
    return config;
  }

  // Per-project mode
  config.projectBranches = config.projectBranches ?? {};

  for (const project of gitProjects) {
    const branch = await promptBranchName(`Source branch for ${project.name}`);
    if (branch) {
      config.projectBranches[project.name] = branch;
    }
  }

  const configured = Object.entries(config.projectBranches);
  if (configured.length > 0) {
    consola.info("Branch assignments:");
    for (const [name, branch] of configured) {
      consola.info(`  ${name} → ${branch}`);
    }
  }

  return config;
}

async function promptBranchName(label: string): Promise<string | undefined> {
  const choice = (await consola.prompt(label, {
    type: "select",
    options: [
      ...COMMON_BRANCHES.map((b) => ({ label: b, value: b })),
      { label: "Enter custom branch name", value: "__custom__" },
      { label: "Skip (use current branch)", value: "__skip__" },
    ],
  })) as unknown as string;

  if (choice === "__skip__") {
    return undefined;
  }

  if (choice === "__custom__") {
    const custom = (await consola.prompt("Enter branch name:", {
      type: "text",
      placeholder: "e.g. release/v2",
    })) as unknown as string;
    return custom?.trim() || undefined;
  }

  return choice;
}
