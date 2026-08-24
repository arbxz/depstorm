import consola from "consola";
import { createRequire } from "node:module";
import {
  actionInit,
  actionScan,
  defaultFixBranch,
  findProjectsWithBranch,
  listProjects,
  runMerge,
  runPush,
} from "./actions.js";
import { applyExitCode, EXIT_OPERATIONAL_FAILURE } from "./exit-code.js";
import {
  buildConfig,
  getProjects,
  parseDepth,
  parsePositiveInt,
} from "./options.js";
import { runPipeline } from "./pipeline.js";
import { confirm, promptBranchSelection } from "./prompt.js";
import { scheduleTask } from "./scheduler.js";
import { SEVERITIES } from "./types.js";

const require = createRequire(import.meta.url);
const { version = "0.0.0" } = require("../package.json") as { version?: string };

/**
 * The flag-driven front end. Every command here does its work through
 * actions.ts or pipeline.ts, the same code the interactive wizard drives.
 */
// ── CLI mode (with args) ───────────────────────────────────────────────
export async function cliMode() {
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
