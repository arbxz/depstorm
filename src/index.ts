#!/usr/bin/env node

import consola from "consola";
import path from "node:path";
import { createRequire } from "node:module";
import { installSignalHandlers } from "./cleanup.js";
import { loadConfig, normaliseGitFlags, resolveRoots } from "./config.js";
import { discoverProjects, resolveExplicitProjects } from "./discover.js";
import { hasBranch, mergeBranch, pushBranch } from "./git.js";
import { runPipeline } from "./pipeline.js";
import { promptBranchSelection } from "./prompt.js";
import {
  hasQualityIssuesAtOrAbove,
  hasUnresolvedAtOrAbove,
  operationalFailure,
} from "./report.js";
import { scheduleTask } from "./scheduler.js";
import {
  DEFAULT_CONFIG,
  isSeverity,
  SEVERITIES,
  type DepstormConfig,
  type ProjectInfo,
  type ProjectReport,
  type Severity,
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
function applyExitCode(reports: ProjectReport[], config: DepstormConfig): void {
  // A working tree depstorm could not hand back intact outranks everything
  // else here: the user has conflict markers or a missing stash to deal with.
  const unrestored = reports.filter((r) => r.stashRestore?.ok === false);
  if (unrestored.length > 0) {
    consola.error(
      `${unrestored.length} project(s) were left with unrestored work in progress: ${unrestored
        .map((r) => r.project.name)
        .join(", ")}`,
    );
    process.exitCode = EXIT_OPERATIONAL_FAILURE;
    return;
  }

  const broken = reports.filter((r) => operationalFailure(r) !== undefined);
  if (broken.length > 0) {
    consola.error(
      `${broken.length} project(s) could not be audited, fixed or reverted cleanly`,
    );
    process.exitCode = EXIT_OPERATIONAL_FAILURE;
    return;
  }

  if (config.failOn) {
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
      return;
    }
  }

  if (config.failOnQuality) {
    const offenders = reports.filter((r) =>
      hasQualityIssuesAtOrAbove(r, config.failOnQuality as Severity),
    );
    if (offenders.length > 0) {
      consola.error(
        `${offenders.length} project(s) still have "${config.failOnQuality}" or higher code quality issues: ${offenders
          .map((r) => r.project.name)
          .join(", ")}`,
      );
      process.exitCode = EXIT_POLICY_FAILURE;
    }
  }
}

// ── Interactive mode (no args) ─────────────────────────────────────────
async function interactiveMode() {
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

/**
 * Let the user narrow a discovered list. Everything is pre-selected, so the
 * default answer matches what depstorm used to do unconditionally.
 */
async function selectProjects(
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
    // Worth showing: a project whose repository is an ancestor behaves
    // differently from one that is its own repository root.
    if (p.gitRoot && p.gitRoot !== p.path) {
      console.log(`  \x1b[90m      repo: ${p.gitRoot}\x1b[0m`);
    }
  }
  console.log();
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

  // Derived from DEFAULT_CONFIG rather than restated. The hand-written copy
  // that used to live here had already drifted from it.
  const defaultConfig = {
    ...DEFAULT_CONFIG,
    schedule: "0 9 * * 1",
    reportPath: "./audit-reports/report",
    ignore: [] as Array<Record<string, string>>,
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
      "--concurrency <number>",
      "Repositories to process at once (only when git operations are off)",
      parsePositiveInt,
    )
    .option(
      "--fail-on <level>",
      `Exit non-zero if vulnerabilities at or above this level remain (${SEVERITIES.join("|")})`,
    )
    .option(
      "--fail-on-quality <level>",
      `Exit non-zero if code quality issues at or above this level remain (${SEVERITIES.join("|")})`,
    )
    .option(
      "--ignore <packages...>",
      "Suppress advisories for these packages for this run only",
    )
    .option("--report <path>", "Report output path (extension added for you)")
    .option("--no-report", "Do not write report files, even if configured")
    .option("-b, --branch <name>", "Source branch to pull from")
    .option("-y, --yes", "Answer prompts with their defaults and never block")
    .option("--no-prompt", "Never prompt; use whatever the config already says")
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const projects = await getProjects(config, opts);
      if (projects.length === 0) {
        consola.warn("No projects found.");
        return;
      }

      // Without this, `depstorm run` in a terminal stops on a branch-selection
      // menu partway through — surprising for a scripted-but-interactive run.
      const mayPrompt =
        opts.prompt !== false && !opts.yes && process.stdin.isTTY === true;

      if (!config.sourceBranch && config.gitBranch && mayPrompt) {
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
    .option("--timezone <name>", "IANA timezone for the schedule")
    .option("--run-now", "Run once immediately, then keep to the schedule")
    .action(async (opts) => {
      const config = await buildConfig(opts);
      const cronExpr = opts.cron ?? config.schedule ?? "0 9 * * 1";
      consola.info("Starting scheduled mode. Press Ctrl+C to stop.");
      scheduleTask(
        cronExpr,
        async () => {
          const projects = await getProjects(config, opts);
          if (projects.length > 0) await runPipeline(projects, config);
        },
        {
          timezone: opts.timezone as string | undefined,
          runImmediately: Boolean(opts.runNow),
        },
      );
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

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--concurrency must be an integer of 1 or more, got "${value}"`);
  }
  return parsed;
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
): Promise<DepstormConfig> {
  const config = await loadConfig(opts.config as string | undefined);

  if (opts.root) config.roots = opts.root as string[];
  if (opts.severity !== undefined) {
    config.severityThreshold = requireSeverity(opts.severity, "--severity");
  }
  if (opts.failOn !== undefined) {
    config.failOn = requireSeverity(opts.failOn, "--fail-on");
  }
  if (opts.failOnQuality !== undefined) {
    config.failOnQuality = requireSeverity(
      opts.failOnQuality,
      "--fail-on-quality",
    );
  }
  if (opts.ignore) {
    // A flag cannot carry a rationale, so it says so rather than pretending
    // to be a reviewed entry in the config file.
    const adhoc = (opts.ignore as string[]).map((name) => ({
      package: name,
      reason: "suppressed with --ignore on the command line",
    }));
    config.ignore = [...(config.ignore ?? []), ...adhoc];
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

  if (opts.report === false) config.reportPath = undefined;
  else if (opts.report) config.reportPath = opts.report as string;
  if (opts.depth !== undefined) config.scanDepth = opts.depth as number;
  if (opts.concurrency !== undefined) {
    config.concurrency = opts.concurrency as number;
  }
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
  config: DepstormConfig,
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
// Registered before any work starts so an interrupt during the very first
// project still unwinds the branch, stash and backups it created.
installSignalHandlers();

const run = process.argv.length > 2 ? cliMode : interactiveMode;

run().catch((err: unknown) => {
  consola.error(err instanceof Error ? err.message : String(err));
  process.exitCode = EXIT_OPERATIONAL_FAILURE;
});
