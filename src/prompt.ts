import consola from "consola";
import type { ProjectInfo, WizardConfig } from "./types.js";

const COMMON_BRANCHES = ["main", "master", "develop", "production"];

/**
 * Prompt the user to choose a source branch for pulling before fixes.
 * Supports global (all projects) or per-project branch selection.
 */
export async function promptBranchSelection(
  projects: ProjectInfo[],
  config: WizardConfig,
): Promise<WizardConfig> {
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
