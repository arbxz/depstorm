import consola from "consola";
import path from "node:path";
import {
  actionInit,
  actionScan,
  defaultFixBranch,
  findProjectsWithBranch,
  listProjects,
  runMerge,
  runPush,
} from "./actions.js";
import { loadConfig, normaliseGitFlags, resolveRoots } from "./config.js";
import { discoverProjects } from "./discover.js";
import { runPipeline } from "./pipeline.js";
import { confirm, promptBranchSelection, selectProjects } from "./prompt.js";
import { scheduleTask } from "./scheduler.js";
import type { DepstormConfig, ProjectInfo, Severity } from "./types.js";

/**
 * The menu-driven front end, used when depstorm is run with no arguments.
 *
 * It shares every operation with the flag-driven CLI (see actions.ts) and
 * differs only in how the answers are collected.
 */

// ── Banner ─────────────────────────────────────────────────────────────
function printBanner() {
  console.log();
  console.log("  \x1b[36m┌─────────────────────────────────────────┐\x1b[0m");
  console.log(
    "  \x1b[36m│\x1b[0m  \x1b[1m⚡ DepStorm\x1b[0m                            \x1b[36m│\x1b[0m",
  );
  console.log(
    "  \x1b[36m│\x1b[0m  Audit · Fix · Verify · Push             \x1b[36m│\x1b[0m",
  );
  console.log("  \x1b[36m└─────────────────────────────────────────┘\x1b[0m");
  console.log();
}

// ── Interactive mode (no args) ─────────────────────────────────────────
export async function interactiveMode() {
  printBanner();

  // Loaded once. Reloading per iteration re-printed "Loaded config from ..."
  // every time round the menu, and each action gets a fresh copy anyway so
  // one action's answers cannot leak into the next.
  const baseConfig = await loadConfig();

  let running = true;
  while (running) {
    running = await interactiveIteration({ ...baseConfig });
  }
  consola.info("Done! 👋");
}

async function interactiveIteration(config: DepstormConfig): Promise<boolean> {
  const action = (await consola.prompt("What would you like to do?", {
    type: "select",
    options: [
      {
        label: "🔍  Scan — Discover projects",
        value: "scan",
        hint: "Find all JS/TS projects in a directory",
      },
      {
        label: "🚀  Run — Full audit → fix → verify pipeline",
        value: "run",
        hint: "Audit, auto-fix, build-verify, and commit",
      },
      {
        label: "📤  Push — Push fix branches to origin",
        value: "push",
        hint: "Push completed audit-fix branches",
      },
      {
        label: "🔀  Merge — Merge fix branches into main",
        value: "merge",
        hint: "Merge completed audit-fix branches into target branch",
      },
      {
        label: "⏰  Schedule — Set up recurring audits",
        value: "schedule",
        hint: "Run the pipeline on a cron schedule",
      },
      {
        label: "⚙️   Init — Create config file",
        value: "init",
        hint: "Generate a .depstorm.json",
      },
      { label: "❌  Exit", value: "exit" },
    ],
  })) as unknown as string;

  if (action === "exit") return false;

  if (action === "init") {
    await actionInit();
    return askAgain();
  }

  // Scheduling re-discovers on every run, so scanning now is wasted work and
  // an extra two prompts before the question the user actually came for.
  if (action === "schedule") {
    await interactiveSchedule(config);
    return askAgain();
  }

  const rootInput = (await consola.prompt(
    "Root directory to scan for projects:",
    { type: "text", placeholder: process.cwd(), default: process.cwd() },
  )) as unknown as string;

  config.roots = [path.resolve(rootInput.trim() || process.cwd())];

  const depthInput = (await consola.prompt("Max scan depth:", {
    type: "select",
    options: [
      { label: "1 — Direct subdirectories only", value: "1" },
      { label: "2 — Two levels deep", value: "2" },
      { label: "3 — Three levels deep (default)", value: "3" },
      { label: "5 — Five levels deep", value: "5" },
    ],
  })) as unknown as string;
  config.scanDepth = Number.parseInt(depthInput, 10) || 3;

  const roots = resolveRoots(config, process.cwd());
  const projects = await discoverProjects(roots, config);

  if (projects.length === 0) {
    consola.warn("No projects found in that directory.");
    return askAgain();
  }

  switch (action) {
    case "scan":
      actionScan(projects);
      break;
    case "run": {
      // Push and merge already let you choose; run — the destructive one —
      // used to take every project discovered, with no way to narrow it.
      const chosen = await selectProjects(projects, "Select projects to run:");
      if (chosen.length === 0) {
        consola.info("No projects selected.");
        break;
      }
      await actionRun(chosen, config);
      break;
    }
    case "push":
      await interactivePush(projects);
      break;
    case "merge":
      await interactiveMerge(projects);
      break;
  }

  return askAgain();
}

async function askAgain(): Promise<boolean> {
  console.log();
  const again = (await consola.prompt("Would you like to do anything else?", {
    type: "select",
    options: [
      { label: "Yes — back to menu", value: "yes" },
      { label: "No — exit", value: "no" },
    ],
  })) as unknown as string;
  return again === "yes";
}

// ── Action: Run ────────────────────────────────────────────────────────
async function actionRun(projects: ProjectInfo[], config: DepstormConfig) {
  const severity = (await consola.prompt("Minimum severity to fix:", {
    type: "select",
    options: [
      { label: "🔴 Critical only", value: "critical" },
      { label: "🟠 High + Critical (recommended)", value: "high" },
      { label: "🟡 Moderate and above", value: "moderate" },
      { label: "🟢 Low and above", value: "low" },
      { label: "ℹ️  Everything (including info)", value: "info" },
    ],
  })) as unknown as Severity;
  config.severityThreshold = severity;

  const sonarCheck = (await consola.prompt("Run SonarJS code quality checks?", {
    type: "select",
    options: [
      {
        label: "Yes — scan source code for bugs & code smells",
        value: "yes",
        hint: "recommended",
      },
      { label: "No — skip code quality analysis", value: "no" },
    ],
  })) as unknown as string;
  config.sonarCheck = sonarCheck === "yes";

  const autoFix = (await consola.prompt("Auto-fix vulnerabilities?", {
    type: "select",
    options: [
      {
        label: "Yes — apply safe fixes automatically",
        value: "yes",
        hint: "recommended",
      },
      { label: "No — audit only (report without fixing)", value: "no" },
    ],
  })) as unknown as string;
  config.autoFix = autoFix === "yes";

  if (config.autoFix) {
    const verify = (await consola.prompt("Verify builds after fixing?", {
      type: "select",
      options: [
        {
          label: "Yes — run build, revert if it fails",
          value: "yes",
          hint: "recommended",
        },
        { label: "No — skip build verification", value: "no" },
      ],
    })) as unknown as string;
    config.verifyBuild = verify === "yes";

    const scripts = (await consola.prompt(
      "Allow dependency install scripts to run?",
      {
        type: "select",
        options: [
          {
            label: "No — install with --ignore-scripts",
            value: "no",
            hint: "recommended",
          },
          {
            label: "Yes — some packages need postinstall to build",
            value: "yes",
            hint: "runs third-party code",
          },
        ],
      },
    )) as unknown as string;
    config.allowInstallScripts = scripts === "yes";
  }

  const gitProjects = projects.filter((p) => p.hasGit);
  if (gitProjects.length > 0 && config.autoFix) {
    const gitMode = (await consola.prompt("Git workflow:", {
      type: "select",
      options: [
        {
          label: "Create branch + commit fixes",
          value: "branch",
          hint: "local only, recommended",
        },
        {
          label: "Create branch + commit + push",
          value: "push",
          hint: "push, then open a PR yourself",
        },
        {
          label: "Create branch + commit + merge into source branch",
          value: "merge",
          hint: "local merge, no push",
        },
        {
          label: "Create branch + commit + merge + push",
          value: "merge-push",
          hint: "⚠ writes directly to your source branch on origin",
        },
        { label: "Commit fixes on current branch", value: "commit-only" },
        { label: "No git operations", value: "none" },
      ],
    })) as unknown as string;

    config.gitBranch = ["branch", "push", "merge", "merge-push"].includes(
      gitMode,
    );
    config.gitCommit = gitMode !== "none";
    config.gitPush = ["push", "merge-push"].includes(gitMode);
    config.gitMerge = ["merge", "merge-push"].includes(gitMode);
    normaliseGitFlags(config);

    if (config.gitBranch) {
      await promptBranchSelection(projects, config);
    }

    if (config.gitMerge && !config.sourceBranch && !config.projectBranches) {
      consola.warn(
        "Merging needs a source branch — none selected, merges will be skipped.",
      );
    }
  }

  const report = (await consola.prompt("Save reports?", {
    type: "select",
    options: [
      { label: "Yes — JSON + HTML", value: "yes" },
      { label: "No — console output only", value: "no" },
    ],
  })) as unknown as string;
  config.reportPath = report === "yes" ? "./audit-reports/report" : undefined;

  const mode = (await consola.prompt("Run mode:", {
    type: "select",
    options: [
      { label: "Apply changes", value: "apply" },
      {
        label: "Dry run — report what would happen",
        value: "dry",
        hint: "nothing is modified",
      },
    ],
  })) as unknown as string;
  config.dryRun = mode === "dry";

  console.log();
  console.log("  \x1b[1mReady to run:\x1b[0m");
  console.log(`    Projects:    ${projects.length}`);
  console.log(`    Severity:    ${config.severityThreshold}+`);
  console.log(`    Auto-fix:    ${config.autoFix ? "yes" : "no"}`);
  console.log(`    Build check: ${config.verifyBuild ? "yes" : "no"}`);
  console.log(`    SonarJS:     ${config.sonarCheck ? "yes" : "no"}`);
  console.log(`    Git:         ${describeGit(config)}`);
  if (config.dryRun) console.log("    Mode:        DRY RUN");
  console.log();

  if (!(await confirm("Start the pipeline?"))) {
    consola.info("Cancelled.");
    return;
  }

  await runPipeline(projects, config);
}

function describeGit(config: DepstormConfig): string {
  if (!config.gitCommit) return "off";
  const parts: string[] = [];
  if (config.gitBranch) parts.push("branch");
  parts.push("commit");
  if (config.gitPush) parts.push("push");
  if (config.gitMerge) parts.push("merge");
  return parts.join(" + ");
}

// ── Interactive: Push / Merge ──────────────────────────────────────────
async function interactivePush(projects: ProjectInfo[]) {
  if (projects.filter((p) => p.hasGit).length === 0) {
    consola.warn("No git projects found.");
    return;
  }

  const branchInput = (await consola.prompt("Fix branch to push:", {
    type: "text",
    placeholder: defaultFixBranch(),
    default: defaultFixBranch(),
  })) as unknown as string;

  const fixBranch = branchInput.trim();
  const eligible = await findProjectsWithBranch(projects, fixBranch);

  if (eligible.length === 0) {
    consola.warn(`No projects have branch "${fixBranch}".`);
    return;
  }

  listProjects(eligible, fixBranch);

  const selected = (await consola.prompt("Select projects to push:", {
    type: "multiselect",
    options: eligible.map((p) => ({ label: p.name, value: p.path })),
  })) as unknown as string[];

  const toPush = eligible.filter((p) => selected?.includes(p.path));
  if (toPush.length === 0) {
    consola.info("No projects selected.");
    return;
  }

  if (!(await confirm(`Push ${toPush.length} project(s) to origin?`))) {
    consola.info("Cancelled.");
    return;
  }

  console.log();
  await runPush(toPush, fixBranch);
}

async function interactiveMerge(projects: ProjectInfo[]) {
  if (projects.filter((p) => p.hasGit).length === 0) {
    consola.warn("No git projects found.");
    return;
  }

  const branchInput = (await consola.prompt("Fix branch to merge:", {
    type: "text",
    placeholder: defaultFixBranch(),
    default: defaultFixBranch(),
  })) as unknown as string;
  const fixBranch = branchInput.trim();

  const targetInput = (await consola.prompt("Target branch to merge into:", {
    type: "text",
    placeholder: "main",
    default: "main",
  })) as unknown as string;
  const targetBranch = targetInput.trim();

  const eligible = await findProjectsWithBranch(projects, fixBranch);
  if (eligible.length === 0) {
    consola.warn(`No projects have branch "${fixBranch}".`);
    return;
  }

  listProjects(eligible, fixBranch);

  const selected = (await consola.prompt("Select projects to merge:", {
    type: "multiselect",
    options: eligible.map((p) => ({ label: p.name, value: p.path })),
  })) as unknown as string[];

  const toMerge = eligible.filter((p) => selected?.includes(p.path));
  if (toMerge.length === 0) {
    consola.info("No projects selected.");
    return;
  }

  const pushAfter = (await consola.prompt("Push after merging?", {
    type: "select",
    options: [
      { label: "No — merge locally only", value: "no", hint: "recommended" },
      {
        label: `Yes — push "${targetBranch}" to origin`,
        value: "yes",
        hint: "⚠ writes to a shared branch",
      },
    ],
  })) as unknown as string;

  if (
    !(await confirm(
      `Merge "${fixBranch}" into "${targetBranch}" for ${toMerge.length} project(s)?`,
    ))
  ) {
    consola.info("Cancelled.");
    return;
  }

  console.log();
  await runMerge(toMerge, fixBranch, targetBranch, pushAfter === "yes");
}

async function interactiveSchedule(config: DepstormConfig) {
  const schedule = (await consola.prompt("How often should audits run?", {
    type: "select",
    options: [
      { label: "Every Monday at 9am", value: "0 9 * * 1" },
      { label: "Every day at 9am", value: "0 9 * * *" },
      { label: "Every 6 hours", value: "0 */6 * * *" },
      { label: "Custom cron expression", value: "__custom__" },
    ],
  })) as unknown as string;

  let cronExpr = schedule;
  if (schedule === "__custom__") {
    cronExpr = (
      (await consola.prompt("Enter cron expression:", {
        type: "text",
        placeholder: "0 9 * * 1",
      })) as unknown as string
    ).trim();
  }

  const first = (await consola.prompt("When should the first run happen?", {
    type: "select",
    options: [
      { label: "Now, then keep to the schedule", value: "now" },
      { label: "Wait for the next scheduled time", value: "wait" },
    ],
  })) as unknown as string;

  consola.info("Starting scheduled mode. Press Ctrl+C to stop.\n");

  scheduleTask(
    cronExpr,
    async () => {
      // Re-discover each run so newly added projects are picked up
      const roots = resolveRoots(config, process.cwd());
      const projects = await discoverProjects(roots, config);
      if (projects.length > 0) await runPipeline(projects, config);
    },
    { runImmediately: first === "now" },
  );

  await new Promise(() => {});
}
