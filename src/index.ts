#!/usr/bin/env node

import consola from "consola";
import path from "node:path";
import { loadConfig, resolveRoots } from "./config.js";
import { discoverProjects, resolveExplicitProjects } from "./discover.js";
import { getCurrentBranch, hasBranch, mergeBranch, pushBranch } from "./git.js";
import { runPipeline } from "./pipeline.js";
import { promptBranchSelection } from "./prompt.js";
import { scheduleTask } from "./scheduler.js";
import type { ProjectInfo, Severity, WizardConfig } from "./types.js";

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
async function interactiveMode() {
  printBanner();

  const config = await loadConfig();

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
      {
        label: "❌  Exit",
        value: "exit",
      },
    ],
  })) as unknown as string;

  if (action === "exit") {
    consola.info("Bye!");
    return;
  }

  if (action === "init") {
    await actionInit();
    return;
  }

  // Ask for project root
  const rootInput = (await consola.prompt(
    "Root directory to scan for projects:",
    {
      type: "text",
      placeholder: process.cwd(),
      default: process.cwd(),
    },
  )) as unknown as string;

  const root = path.resolve(rootInput.trim() || process.cwd());
  config.roots = [root];

  // Scan depth
  const depthInput = (await consola.prompt("Max scan depth:", {
    type: "select",
    options: [
      { label: "1 — Direct subdirectories only", value: "1" },
      { label: "2 — Two levels deep", value: "2" },
      { label: "3 — Three levels deep (default)", value: "3" },
      { label: "5 — Five levels deep", value: "5" },
    ],
  })) as unknown as string;
  config.scanDepth = parseInt(depthInput);

  // Discover projects
  const roots = resolveRoots(config, process.cwd());
  const projects = await discoverProjects(roots, config);

  if (projects.length === 0) {
    consola.warn("No projects found in that directory.");
    return;
  }

  consola.success(`Found ${projects.length} project(s)`);

  switch (action) {
    case "scan":
      await actionScan(projects);
      break;
    case "run":
      await actionRun(projects, config);
      break;
    case "push":
      await actionPush(projects);
      break;
    case "merge":
      await actionMerge(projects);
      break;
    case "schedule":
      await actionSchedule(projects, config);
      break;
  }

  // Loop back
  console.log();
  const again = (await consola.prompt("Would you like to do anything else?", {
    type: "select",
    options: [
      { label: "Yes — back to menu", value: "yes" },
      { label: "No — exit", value: "no" },
    ],
  })) as unknown as string;

  if (again === "yes") {
    await interactiveMode();
  } else {
    consola.info("Done! 👋");
  }
}

// ── Action: Scan ───────────────────────────────────────────────────────
async function actionScan(projects: ProjectInfo[]) {
  console.log(`\n  Found \x1b[1m${projects.length}\x1b[0m project(s):\n`);

  const pmColors: Record<string, string> = {
    npm: "\x1b[31m",
    pnpm: "\x1b[33m",
    yarn: "\x1b[34m",
  };

  for (const p of projects) {
    const color = pmColors[p.packageManager] ?? "";
    const git = p.hasGit ? "\x1b[32m✓ git\x1b[0m" : "\x1b[90m✗ git\x1b[0m";
    console.log(
      `  ${color}${p.packageManager.padEnd(4)}\x1b[0m  ${p.name.padEnd(30)} ${git}`,
    );
    console.log(`  \x1b[90m      ${p.path}\x1b[0m`);
  }
  console.log();
}

// ── Action: Run ────────────────────────────────────────────────────────
async function actionRun(projects: ProjectInfo[], config: WizardConfig) {
  // Severity threshold
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

  // SonarJS code quality check
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

  // Auto-fix toggle
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

  // Build verification
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
  }

  // Git options
  const gitProjects = projects.filter((p) => p.hasGit);
  if (gitProjects.length > 0 && config.autoFix) {
    const gitMode = (await consola.prompt("Git workflow:", {
      type: "select",
      options: [
        {
          label: "Create branch + commit + push + merge",
          value: "full-merge",
          hint: "fully automated",
        },
        {
          label: "Create branch + commit + push",
          value: "full-push",
          hint: "push but merge manually",
        },
        {
          label: "Create branch + commit fixes",
          value: "full",
          hint: "local only",
        },
        { label: "Commit fixes on current branch", value: "commit-only" },
        { label: "No git operations", value: "none" },
      ],
    })) as unknown as string;

    config.gitBranch = ["full", "full-push", "full-merge"].includes(gitMode);
    config.gitCommit = gitMode !== "none";
    config.gitPush = ["full-push", "full-merge"].includes(gitMode);
    config.gitMerge = gitMode === "full-merge";

    if (config.gitBranch) {
      await promptBranchSelection(projects, config);
    }
  }

  // Report
  const report = (await consola.prompt("Save reports?", {
    type: "select",
    options: [
      { label: "Yes — JSON + HTML", value: "yes" },
      { label: "No — console output only", value: "no" },
    ],
  })) as unknown as string;
  if (report === "yes") {
    config.reportPath = "./audit-reports/report";
  }

  // Summary & confirm
  console.log();
  console.log("  \x1b[1mReady to run:\x1b[0m");
  console.log(`    Projects:    ${projects.length}`);
  console.log(`    Severity:    ${config.severityThreshold}+`);
  console.log(`    Auto-fix:    ${config.autoFix ? "yes" : "no"}`);
  console.log(`    Build check: ${config.verifyBuild ? "yes" : "no"}`);
  console.log(`    SonarJS:     ${config.sonarCheck ? "yes" : "no"}`);
  const gitDesc = config.gitMerge
    ? "branch + commit + push + merge"
    : config.gitPush
      ? "branch + commit + push"
      : config.gitBranch
        ? "branch + commit"
        : config.gitCommit
          ? "commit only"
          : "off";
  console.log(`    Git:         ${gitDesc}`);
  console.log();

  const go = (await consola.prompt("Start the pipeline?", {
    type: "confirm",
    initial: true,
  })) as unknown as boolean;

  if (!go) {
    consola.info("Cancelled.");
    return;
  }

  await runPipeline(projects, config);
}

// ── Action: Push ───────────────────────────────────────────────────────
async function actionPush(projects: ProjectInfo[]) {
  const gitProjects = projects.filter((p) => p.hasGit);

  if (gitProjects.length === 0) {
    consola.warn("No git projects found.");
    return;
  }

  const branchInput = (await consola.prompt("Fix branch to push:", {
    type: "text",
    placeholder: `audit-fix/${new Date().toISOString().slice(0, 10)}`,
    default: `audit-fix/${new Date().toISOString().slice(0, 10)}`,
  })) as unknown as string;

  const fixBranchName = branchInput.trim();

  // Find eligible projects
  const eligible: ProjectInfo[] = [];
  for (const p of gitProjects) {
    if (await hasBranch(p, fixBranchName)) {
      eligible.push(p);
    }
  }

  if (eligible.length === 0) {
    consola.warn(`No projects have branch "${fixBranchName}".`);
    return;
  }

  console.log(
    `\n  Found \x1b[1m${eligible.length}\x1b[0m project(s) with branch "${fixBranchName}":\n`,
  );
  for (const p of eligible) {
    console.log(`    - ${p.name}`);
  }
  console.log();

  const selected = (await consola.prompt("Select projects to push:", {
    type: "multiselect",
    options: eligible.map((p) => ({ label: p.name, value: p.name })),
  })) as unknown as string[];

  const toPush = eligible.filter((p) => selected.includes(p.name));

  if (toPush.length === 0) {
    consola.info("No projects selected.");
    return;
  }

  const confirm = (await consola.prompt(
    `Push ${toPush.length} project(s) to origin?`,
    { type: "confirm", initial: true },
  )) as unknown as boolean;

  if (!confirm) {
    consola.info("Cancelled.");
    return;
  }

  console.log();
  let pushed = 0;
  let failed = 0;

  for (const p of toPush) {
    if (await pushBranch(p, fixBranchName)) {
      pushed++;
    } else {
      failed++;
    }
  }

  console.log();
  consola.success(`Pushed: ${pushed}, Failed: ${failed}`);
  if (pushed > 0) {
    consola.info(
      `Create PRs to merge "${fixBranchName}" into your main branch.`,
    );
  }
}

// ── Action: Merge ──────────────────────────────────────────────────────
async function actionMerge(projects: ProjectInfo[]) {
  const gitProjects = projects.filter((p) => p.hasGit);

  if (gitProjects.length === 0) {
    consola.warn("No git projects found.");
    return;
  }

  const branchInput = (await consola.prompt("Fix branch to merge:", {
    type: "text",
    placeholder: `audit-fix/${new Date().toISOString().slice(0, 10)}`,
    default: `audit-fix/${new Date().toISOString().slice(0, 10)}`,
  })) as unknown as string;

  const fixBranchName = branchInput.trim();

  const targetInput = (await consola.prompt("Target branch to merge into:", {
    type: "text",
    placeholder: "main",
    default: "main",
  })) as unknown as string;

  const targetBranch = targetInput.trim();

  // Find eligible projects
  const eligible: ProjectInfo[] = [];
  for (const p of gitProjects) {
    if (await hasBranch(p, fixBranchName)) {
      eligible.push(p);
    }
  }

  if (eligible.length === 0) {
    consola.warn(`No projects have branch "${fixBranchName}".`);
    return;
  }

  console.log(
    `\n  Found \x1b[1m${eligible.length}\x1b[0m project(s) with branch "${fixBranchName}":\n`,
  );
  for (const p of eligible) {
    console.log(`    - ${p.name}`);
  }
  console.log();

  const selected = (await consola.prompt("Select projects to merge:", {
    type: "multiselect",
    options: eligible.map((p) => ({ label: p.name, value: p.name })),
  })) as unknown as string[];

  const toMerge = eligible.filter((p) => selected.includes(p.name));

  if (toMerge.length === 0) {
    consola.info("No projects selected.");
    return;
  }

  const confirm = (await consola.prompt(
    `Merge "${fixBranchName}" into "${targetBranch}" for ${toMerge.length} project(s)?`,
    { type: "confirm", initial: true },
  )) as unknown as boolean;

  if (!confirm) {
    consola.info("Cancelled.");
    return;
  }

  console.log();
  let merged = 0;
  let failed = 0;

  for (const p of toMerge) {
    if (await mergeBranch(p, fixBranchName, targetBranch)) {
      merged++;
    } else {
      failed++;
    }
  }

  console.log();
  consola.success(`Merged: ${merged}, Failed: ${failed}`);
}

// ── Action: Schedule ───────────────────────────────────────────────────
async function actionSchedule(projects: ProjectInfo[], config: WizardConfig) {
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
    cronExpr = (await consola.prompt("Enter cron expression:", {
      type: "text",
      placeholder: "0 9 * * 1",
    })) as unknown as string;
  }

  consola.info("Starting scheduled mode. Press Ctrl+C to stop.\n");

  scheduleTask(cronExpr, async () => {
    if (projects.length > 0) {
      await runPipeline(projects, config);
    }
  });

  await new Promise(() => {});
}

// ── Action: Init ───────────────────────────────────────────────────────
async function actionInit() {
  const fs = await import("node:fs/promises");
  const configPath = path.resolve(".depstorm.json");

  try {
    await fs.access(configPath);
    consola.warn("Config file already exists at " + configPath);
    return;
  } catch {
    // doesn't exist — good
  }

  const defaultConfig = {
    roots: ["."],
    severityThreshold: "high",
    autoFix: true,
    verifyBuild: true,
    revertOnFailure: true,
    gitBranch: true,
    gitCommit: true,
    gitPush: false,
    gitMerge: false,
    scanDepth: 3,
    excludeDirs: ["node_modules", ".git", "dist", "build", ".next", ".nuxt"],
    schedule: "0 9 * * 1",
    reportPath: "./audit-reports/report",
  };

  await fs.writeFile(
    configPath,
    JSON.stringify(defaultConfig, null, 2),
    "utf-8",
  );
  consola.success(`Created config at ${configPath}`);
}

// ── CLI mode (with args) ───────────────────────────────────────────────
async function cliMode() {
  const { Command } = await import("commander");
  const program = new Command();

  program
    .name("depstorm")
    .description(
      "Audit, fix, and verify npm/pnpm/yarn projects for security vulnerabilities",
    )
    .version("1.0.0");

  program
    .command("run")
    .description("Run audit → fix → verify pipeline")
    .option("-r, --root <paths...>", "Root directories to scan")
    .option("-p, --project <paths...>", "Specific project paths")
    .option("-c, --config <path>", "Path to config file")
    .option("-s, --severity <level>", "Severity threshold")
    .option("--no-fix", "Skip auto-fix")
    .option("--no-build", "Skip build verification")
    .option("--no-git", "Skip git operations")
    .option("--push", "Auto-push fix branches to origin")
    .option("--merge", "Auto-merge fix branches into source branch")
    .option("--report <path>", "Report output path")
    .option("-d, --depth <number>", "Max scan depth", parseInt)
    .option("-b, --branch <name>", "Source branch to pull from")
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const projects = await getProjects(config, opts);
      if (projects.length === 0) {
        consola.warn("No projects found.");
        return;
      }
      if (!config.sourceBranch && process.stdin.isTTY) {
        await promptBranchSelection(projects, config);
      }
      await runPipeline(projects, config);
    });

  program
    .command("scan")
    .description("Discover projects")
    .option("-r, --root <paths...>", "Root directories to scan")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --depth <number>", "Max scan depth", parseInt)
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const projects = await getProjects(config, opts);
      if (projects.length === 0) {
        consola.warn("No projects found.");
        return;
      }
      await actionScan(projects);
    });

  program
    .command("push")
    .description("Push fix branches to origin")
    .option("-r, --root <paths...>", "Root directories to scan")
    .option("-p, --project <paths...>", "Specific project paths")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --depth <number>", "Max scan depth", parseInt)
    .option("--fix-branch <name>", "Fix branch name")
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const projects = await getProjects(config, opts);
      const gitProjects = projects.filter((p) => p.hasGit);
      const fixBranchName =
        (opts.fixBranch as string) ??
        `audit-fix/${new Date().toISOString().slice(0, 10)}`;

      const eligible: ProjectInfo[] = [];
      for (const p of gitProjects) {
        if (await hasBranch(p, fixBranchName)) eligible.push(p);
      }

      if (eligible.length === 0) {
        consola.warn(`No projects have branch "${fixBranchName}".`);
        return;
      }

      for (const p of eligible) {
        await pushBranch(p, fixBranchName);
      }
    });

  program
    .command("merge")
    .description("Merge fix branches into a target branch")
    .option("-r, --root <paths...>", "Root directories to scan")
    .option("-p, --project <paths...>", "Specific project paths")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --depth <number>", "Max scan depth", parseInt)
    .option("--fix-branch <name>", "Fix branch name")
    .option("-b, --branch <name>", "Target branch to merge into", "main")
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const projects = await getProjects(config, opts);
      const gitProjects = projects.filter((p) => p.hasGit);
      const fixBranchName =
        (opts.fixBranch as string) ??
        `audit-fix/${new Date().toISOString().slice(0, 10)}`;
      const targetBranch = (opts.branch as string) ?? "main";

      const eligible: ProjectInfo[] = [];
      for (const p of gitProjects) {
        if (await hasBranch(p, fixBranchName)) eligible.push(p);
      }

      if (eligible.length === 0) {
        consola.warn(`No projects have branch "${fixBranchName}".`);
        return;
      }

      console.log(
        `\n  Found \x1b[1m${eligible.length}\x1b[0m project(s) with branch "${fixBranchName}":\n`,
      );
      for (const p of eligible) {
        console.log(`    - ${p.name}`);
      }
      console.log();

      const confirm = (await consola.prompt(
        `Merge "${fixBranchName}" into "${targetBranch}" for ${eligible.length} project(s)?`,
        { type: "confirm", initial: true },
      )) as unknown as boolean;

      if (!confirm) {
        consola.info("Cancelled.");
        return;
      }

      let merged = 0;
      let failed = 0;

      for (const p of eligible) {
        const success = await mergeBranch(p, fixBranchName, targetBranch);
        if (success) {
          merged++;
        } else {
          failed++;
        }
      }

      console.log();
      consola.success(`Merged: ${merged}, Failed: ${failed}`);
    });

  program
    .command("schedule")
    .description("Run on a cron schedule")
    .option("-c, --config <path>", "Path to config file")
    .option("--cron <expression>", "Cron expression")
    .option("-r, --root <paths...>", "Root directories")
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const cronExpr = opts.cron ?? config.schedule ?? "0 9 * * 1";
      consola.info("Starting scheduled mode. Press Ctrl+C to stop.");
      scheduleTask(cronExpr, async () => {
        const projects = await getProjects(config, opts);
        if (projects.length > 0) await runPipeline(projects, config);
      });
      await new Promise(() => {});
    });

  program
    .command("init")
    .description("Create a config file")
    .action(actionInit);

  program.parse();
}

// ── Helpers ────────────────────────────────────────────────────────────
async function buildConfig(
  opts: Record<string, unknown>,
): Promise<WizardConfig> {
  const config = await loadConfig(opts.config as string | undefined);
  if (opts.root) config.roots = opts.root as string[];
  if (opts.severity) config.severityThreshold = opts.severity as Severity;
  if (opts.fix === false) config.autoFix = false;
  if (opts.build === false) config.verifyBuild = false;
  if (opts.git === false) {
    config.gitBranch = false;
    config.gitCommit = false;
  }
  if (opts.report) config.reportPath = opts.report as string;
  if (opts.depth) config.scanDepth = opts.depth as number;
  if (opts.branch) config.sourceBranch = opts.branch as string;
  if (opts.push) config.gitPush = true;
  if (opts.merge) config.gitMerge = true;
  return config;
}

async function getProjects(
  config: WizardConfig,
  opts: Record<string, unknown>,
) {
  if (opts.project) {
    return resolveExplicitProjects(opts.project as string[]);
  }
  if (config.projects?.length) {
    return resolveExplicitProjects(config.projects);
  }
  const roots = resolveRoots(config, process.cwd());
  return discoverProjects(roots, config);
}

// ── Entry point ────────────────────────────────────────────────────────
const hasArgs = process.argv.length > 2;

if (hasArgs) {
  cliMode();
} else {
  interactiveMode();
}
