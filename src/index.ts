#!/usr/bin/env node

import consola from "consola";
import path from "node:path";
import { createRequire } from "node:module";
import { loadConfig, normaliseGitFlags, resolveRoots } from "./config.js";
import { discoverProjects, resolveExplicitProjects } from "./discover.js";
import { hasBranch, mergeBranch, pushBranch } from "./git.js";
import { runPipeline } from "./pipeline.js";
import { promptBranchSelection } from "./prompt.js";
import { hasUnresolvedAtOrAbove } from "./report.js";
import { scheduleTask } from "./scheduler.js";
import {
  isSeverity,
  SEVERITIES,
  type ProjectInfo,
  type ProjectReport,
  type Severity,
  type WizardConfig,
} from "./types.js";

const require = createRequire(import.meta.url);
const { version = "0.0.0" } = require("../package.json") as { version?: string };

/** Exit codes: 0 clean · 1 operational failure · 2 policy failure (--fail-on) */
const EXIT_OPERATIONAL_FAILURE = 1;
const EXIT_POLICY_FAILURE = 2;

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

// ── Prompt helpers ─────────────────────────────────────────────────────

/**
 * Confirmations must never self-approve. consola returns the `initial` value
 * when there is no TTY, which silently green-lit merges in CI.
 */
async function confirm(
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

function defaultFixBranch(): string {
  return `audit-fix/${new Date().toISOString().slice(0, 10)}`;
}

// ── Shared actions ─────────────────────────────────────────────────────

async function findProjectsWithBranch(
  projects: ProjectInfo[],
  branch: string,
): Promise<ProjectInfo[]> {
  const eligible: ProjectInfo[] = [];
  for (const p of projects.filter((p) => p.hasGit)) {
    if (await hasBranch(p, branch)) eligible.push(p);
  }
  return eligible;
}

function listProjects(projects: ProjectInfo[], branch: string): void {
  console.log(
    `\n  Found \x1b[1m${projects.length}\x1b[0m project(s) with branch "${branch}":\n`,
  );
  for (const p of projects) console.log(`    - ${p.name}`);
  console.log();
}

async function runPush(
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

async function runMerge(
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
 * Translate a completed run into a process exit code so depstorm is usable
 * as a CI gate instead of always reporting success.
 */
function applyExitCode(reports: ProjectReport[], config: WizardConfig): void {
  const broken = reports.filter((r) => r.audit.error ?? r.fix?.error);
  if (broken.length > 0) {
    consola.error(
      `${broken.length} project(s) could not be audited or fixed cleanly`,
    );
    process.exitCode = EXIT_OPERATIONAL_FAILURE;
    return;
  }

  if (!config.failOn) return;

  const offenders = reports.filter((r) =>
    hasUnresolvedAtOrAbove(r, config.failOn as Severity),
  );
  if (offenders.length > 0) {
    consola.error(
      `${offenders.length} project(s) still have "${config.failOn}" or higher vulnerabilities: ${offenders
        .map((r) => r.project.name)
        .join(", ")}`,
    );
    process.exitCode = EXIT_POLICY_FAILURE;
  }
}

// ── Interactive mode (no args) ─────────────────────────────────────────
async function interactiveMode() {
  printBanner();

  let running = true;
  while (running) {
    running = await interactiveIteration();
  }
  consola.info("Done! 👋");
}

async function interactiveIteration(): Promise<boolean> {
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
      { label: "❌  Exit", value: "exit" },
    ],
  })) as unknown as string;

  if (action === "exit") return false;

  if (action === "init") {
    await actionInit();
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

  consola.success(`Found ${projects.length} project(s)`);

  switch (action) {
    case "scan":
      actionScan(projects);
      break;
    case "run":
      await actionRun(projects, config);
      break;
    case "push":
      await interactivePush(projects);
      break;
    case "merge":
      await interactiveMerge(projects);
      break;
    case "schedule":
      await interactiveSchedule(config);
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

// ── Action: Scan ───────────────────────────────────────────────────────
function actionScan(projects: ProjectInfo[]) {
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

function describeGit(config: WizardConfig): string {
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

async function interactiveSchedule(config: WizardConfig) {
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

  consola.info("Starting scheduled mode. Press Ctrl+C to stop.\n");

  scheduleTask(cronExpr, async () => {
    // Re-discover each run so newly added projects are picked up
    const roots = resolveRoots(config, process.cwd());
    const projects = await discoverProjects(roots, config);
    if (projects.length > 0) await runPipeline(projects, config);
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
    autoStash: false,
    allowInstallScripts: false,
    sonarCheck: true,
    dryRun: false,
    scanDepth: 3,
    excludeDirs: ["node_modules", ".git", "dist", "build", ".next", ".nuxt"],
    schedule: "0 9 * * 1",
    reportPath: "./audit-reports/report",
  };

  await fs.writeFile(
    configPath,
    JSON.stringify(defaultConfig, null, 2) + "\n",
    "utf-8",
  );
  consola.success(`Created config at ${configPath}`);
  consola.info(
    "Reports contain absolute paths and build output — keep them out of version control.",
  );
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
    .version(version);

  const discoveryOptions = (cmd: InstanceType<typeof Command>) =>
    cmd
      .option("-r, --root <paths...>", "Root directories to scan")
      .option("-p, --project <paths...>", "Specific project paths")
      .option("-c, --config <path>", "Path to config file")
      .option("-d, --depth <number>", "Max scan depth", parseDepth);

  discoveryOptions(program.command("run"))
    .description("Run audit → fix → verify pipeline")
    .option(
      "-s, --severity <level>",
      `Severity threshold (${SEVERITIES.join("|")})`,
    )
    .option("--no-fix", "Skip auto-fix")
    .option("--no-build", "Skip build verification")
    .option("--no-git", "Skip all git operations")
    .option("--push", "Push branches to origin")
    .option("--skip-push", "Never push, even if the config enables it")
    .option("--merge", "Merge fix branches into the source branch")
    .option("--skip-merge", "Never merge, even if the config enables it")
    .option("--auto-stash", "Stash a dirty working tree without asking")
    .option(
      "--allow-install-scripts",
      "Let dependency lifecycle scripts run during install",
    )
    .option("--dry-run", "Report what would happen without changing anything")
    .option(
      "--fail-on <level>",
      `Exit non-zero if vulnerabilities at or above this level remain (${SEVERITIES.join("|")})`,
    )
    .option("--report <path>", "Report output path (extension added for you)")
    .option("-b, --branch <name>", "Source branch to pull from")
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const projects = await getProjects(config, opts);
      if (projects.length === 0) {
        consola.warn("No projects found.");
        return;
      }
      if (!config.sourceBranch && config.gitBranch && process.stdin.isTTY) {
        await promptBranchSelection(projects, config);
      }
      const reports = await runPipeline(projects, config);
      applyExitCode(reports, config);
    });

  discoveryOptions(program.command("scan"))
    .description("Discover projects")
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const projects = await getProjects(config, opts);
      if (projects.length === 0) {
        consola.warn("No projects found.");
        return;
      }
      actionScan(projects);
    });

  discoveryOptions(program.command("push"))
    .description("Push fix branches to origin")
    .option("--fix-branch <name>", "Fix branch name", defaultFixBranch())
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const projects = await getProjects(config, opts);
      const fixBranch = opts.fixBranch as string;
      const eligible = await findProjectsWithBranch(projects, fixBranch);

      if (eligible.length === 0) {
        consola.warn(`No projects have branch "${fixBranch}".`);
        return;
      }

      listProjects(eligible, fixBranch);

      if (
        !(await confirm(`Push ${eligible.length} project(s) to origin?`, {
          assumeYes: Boolean(opts.yes),
        }))
      ) {
        consola.info("Cancelled.");
        return;
      }

      const { failed } = await runPush(eligible, fixBranch);
      if (failed > 0) process.exitCode = EXIT_OPERATIONAL_FAILURE;
    });

  discoveryOptions(program.command("merge"))
    .description("Merge fix branches into a target branch")
    .option("--fix-branch <name>", "Fix branch name", defaultFixBranch())
    .option("-b, --branch <name>", "Target branch to merge into", "main")
    .option("--push", "Push the target branch after merging")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const projects = await getProjects(config, opts);
      const fixBranch = opts.fixBranch as string;
      const targetBranch = opts.branch as string;
      const eligible = await findProjectsWithBranch(projects, fixBranch);

      if (eligible.length === 0) {
        consola.warn(`No projects have branch "${fixBranch}".`);
        return;
      }

      listProjects(eligible, fixBranch);

      const action = opts.push
        ? `Merge "${fixBranch}" into "${targetBranch}" and PUSH to origin`
        : `Merge "${fixBranch}" into "${targetBranch}" locally`;

      if (
        !(await confirm(`${action} for ${eligible.length} project(s)?`, {
          assumeYes: Boolean(opts.yes),
        }))
      ) {
        consola.info("Cancelled.");
        return;
      }

      const { failed } = await runMerge(
        eligible,
        fixBranch,
        targetBranch,
        Boolean(opts.push),
      );
      if (failed > 0) process.exitCode = EXIT_OPERATIONAL_FAILURE;
    });

  discoveryOptions(program.command("schedule"))
    .description("Run on a cron schedule")
    .option("--cron <expression>", "Cron expression")
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

  await program.parseAsync();
}

// ── Helpers ────────────────────────────────────────────────────────────
function parseDepth(value: string): number {
  const depth = Number.parseInt(value, 10);
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`--depth must be a non-negative integer, got "${value}"`);
  }
  return depth;
}

function requireSeverity(value: unknown, flag: string): Severity {
  if (!isSeverity(value)) {
    throw new Error(
      `${flag} must be one of: ${SEVERITIES.join(", ")} (got "${String(value)}")`,
    );
  }
  return value;
}

async function buildConfig(
  opts: Record<string, unknown>,
): Promise<WizardConfig> {
  const config = await loadConfig(opts.config as string | undefined);

  if (opts.root) config.roots = opts.root as string[];
  if (opts.severity !== undefined) {
    config.severityThreshold = requireSeverity(opts.severity, "--severity");
  }
  if (opts.failOn !== undefined) {
    config.failOn = requireSeverity(opts.failOn, "--fail-on");
  }
  if (opts.fix === false) config.autoFix = false;
  if (opts.build === false) config.verifyBuild = false;

  // `--no-git` must disable every git operation, including ones enabled in
  // the config file. Leaving push/merge on made it merge into the source branch.
  if (opts.git === false) {
    config.gitBranch = false;
    config.gitCommit = false;
    config.gitPush = false;
    config.gitMerge = false;
  }

  if (opts.report) config.reportPath = opts.report as string;
  if (opts.depth !== undefined) config.scanDepth = opts.depth as number;
  if (opts.branch) config.sourceBranch = opts.branch as string;
  // Opt-outs win over opt-ins, and over anything the config file enabled
  if (opts.push) config.gitPush = true;
  if (opts.merge) config.gitMerge = true;
  if (opts.skipPush) config.gitPush = false;
  if (opts.skipMerge) config.gitMerge = false;
  if (opts.autoStash) config.autoStash = true;
  if (opts.allowInstallScripts) config.allowInstallScripts = true;
  if (opts.dryRun) config.dryRun = true;

  if (opts.git !== false) normaliseGitFlags(config);
  return config;
}

async function getProjects(
  config: WizardConfig,
  opts: Record<string, unknown>,
): Promise<ProjectInfo[]> {
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
const run = process.argv.length > 2 ? cliMode : interactiveMode;

run().catch((err: unknown) => {
  consola.error(err instanceof Error ? err.message : String(err));
  process.exitCode = EXIT_OPERATIONAL_FAILURE;
});
