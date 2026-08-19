# depstorm

A CLI tool that periodically audits, fixes, and verifies npm/pnpm/yarn projects for security vulnerabilities.

> **⚠️ Read [Security model](#security-model) before pointing depstorm at a directory.**
> Auditing a project runs its package manager, and verifying a fix runs its build
> script. Only run depstorm against code you trust.

## Features

- **Project Discovery** — Scans directories to find all JS/TS projects by `package.json`, including monorepo workspace members
- **Package Manager Detection** — Auto-detects npm, pnpm, or yarn via lockfiles
- **Audit & Parse** — Runs `npm audit` / `pnpm audit` / `yarn audit` and normalizes the JSON output
- **Auto-Fix** — Applies safe fixes with configurable severity thresholds, then **re-audits to confirm what actually changed**
- **Build Verification** — Runs the project's build script after fixes; reverts if it fails
- **Git Integration** — Creates branches and commits only the manifest and lockfile
- **Cron Scheduling** — Run audits on a schedule (e.g. every Monday at 9am)
- **Reporting** — Console summary + JSON and HTML reports
- **Dry Run** — See exactly what would happen without changing anything

## Quick Start

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Initialize a config file
node dist/index.js init

# Scan for projects
node dist/index.js scan --root /path/to/your/projects

# See what a run would do — changes nothing
node dist/index.js run --root /path/to/your/projects --dry-run

# Run the full pipeline
node dist/index.js run --root /path/to/your/projects

# Schedule recurring runs
node dist/index.js schedule --cron "0 9 * * 1" --root /path/to/your/projects
```

Running `depstorm` with no arguments starts an interactive wizard.

## Commands

### `run`

Run the audit → fix → verify pipeline.

```bash
depstorm run [options]
```

| Option                     | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `-r, --root <paths...>`    | Root directories to scan                                       |
| `-p, --project <paths...>` | Specific project paths                                         |
| `-c, --config <path>`      | Path to config file                                            |
| `-s, --severity <level>`   | Minimum severity: `info\|low\|moderate\|high\|critical`        |
| `-d, --depth <number>`     | Max scan depth (levels below each root)                        |
| `-b, --branch <name>`      | Source branch to pull from                                     |
| `--dry-run`                | Report what would happen without changing anything             |
| `--no-fix`                 | Skip auto-fix                                                  |
| `--no-build`               | Skip build verification                                        |
| `--no-git`                 | Skip **all** git operations (branch, commit, push and merge)   |
| `--push`                   | Push branches to origin                                        |
| `--skip-push`              | Never push, even if the config enables it                      |
| `--merge`                  | Merge fix branches into the source branch                      |
| `--skip-merge`             | Never merge, even if the config enables it                     |
| `--auto-stash`             | Stash a dirty working tree without asking                      |
| `--allow-install-scripts`  | Let dependency lifecycle scripts run during install            |
| `--fail-on <level>`        | Exit non-zero if vulnerabilities at or above this level remain |
| `--report <path>`          | Report output path (`.json`/`.html` are appended for you)      |

**Exit codes** — `0` clean · `1` an audit or fix failed · `2` `--fail-on` threshold breached.
This makes `depstorm run --fail-on high` usable as a CI gate.

### `schedule`

Run the pipeline on a cron schedule. Projects are re-discovered on every run.

```bash
depstorm schedule --cron "0 9 * * 1"
```

### `scan`

Discover projects without running audits.

```bash
depstorm scan --root ./my-projects
```

### `push` / `merge`

Push or merge existing fix branches.

```bash
depstorm push  --fix-branch audit-fix/2026-08-02
depstorm merge --fix-branch audit-fix/2026-08-02 --branch main [--push] [--yes]
```

`merge` is **local only** unless you pass `--push`. Both commands prompt for
confirmation; without a TTY they abort unless given `--yes`.

## Configuration

Create a `.depstorm.json` in your working directory:

```json
{
  "roots": ["."],
  "severityThreshold": "high",
  "autoFix": true,
  "verifyBuild": true,
  "revertOnFailure": true,
  "gitBranch": true,
  "gitCommit": true,
  "gitPush": false,
  "gitMerge": false,
  "autoStash": false,
  "allowInstallScripts": false,
  "sonarCheck": true,
  "dryRun": false,
  "scanDepth": 3,
  "excludeDirs": ["node_modules", ".git", "dist", "build", ".next", ".nuxt"],
  "schedule": "0 9 * * 1",
  "reportPath": "./audit-reports/report"
}
```

Only JSON and YAML config files are supported (`.depstorm.json`, `.depstormrc.yaml`, …).
Executable config is deliberately not loaded — see [Security model](#security-model).

Invalid values are rejected with an error rather than silently ignored, so a
typo like `"severityThreshold": "HIGH"` fails loudly instead of quietly
disabling fixes.

### Git flags

The flags build on each other; depstorm normalizes impossible combinations and
warns when it does.

| Setting     | Effect                                                       |
| ----------- | ------------------------------------------------------------ |
| `gitCommit` | Commit the manifest and lockfile after a verified fix         |
| `gitBranch` | Create an `audit-fix/<date>` branch first (implies commit)    |
| `gitPush`   | Push the branch to origin (implies commit)                    |
| `gitMerge`  | Merge the fix branch into `sourceBranch` (implies branch)     |

`gitMerge` only ever merges a branch depstorm created, and only pushes the
result when `gitPush` is also enabled.

## Pipeline Workflow

```
Discover projects
  → Detect package manager (npm/pnpm/yarn)
  → Run audit (JSON output)
  → Parse vulnerabilities
      → Audit failed? report it as UNKNOWN, never as clean
  → Decide whether a fix is possible (severity threshold, fixability, package manager)
      → Not fixable? stop here — no branches, no stashing
  → Back up package.json + lockfile
  → Check the working tree is clean (prompt to stash; skip if unattended)
  → Pull the source branch, create audit-fix/<date>
  → Apply audit fix, reinstall with --ignore-scripts
  → Re-audit to confirm what was actually fixed
  → Run build
      → Passes → commit package.json + lockfile only
          → gitPush  → push the fix branch
          → gitMerge → merge into the source branch (push only if gitPush)
      → Fails → restore package.json + lockfile, reinstall, report as reverted
  → Return to the original branch, restore the stash
  → Generate report (console + JSON + HTML)
```

## Security model

depstorm automates dependency changes, so it is worth being explicit about what
it executes and what it can write to.

**It runs code from the projects you point it at.**
`npm audit fix` and `npm install` execute dependency lifecycle scripts, and
build verification runs the project's own `build` script. Depstorm installs with
`--ignore-scripts` by default; `--allow-install-scripts` turns that off. Build
verification always runs project code — use `--no-build` for untrusted trees.
**Do not point depstorm at directories containing code you have not reviewed.**

**It does not load executable config.** Config discovery walks up from the
current directory, so supporting `depstorm.config.js` would mean an untrusted
repository could execute code just by being a parent directory. Only JSON and
YAML are read.

**It is conservative with your working tree.** Depstorm never runs
`git clean` and never reverts files it did not change — a failed fix restores
only `package.json` and the lockfile. A dirty working tree is stashed only with
your consent; unattended runs skip such projects unless `autoStash` is enabled.
Any stash it creates is tracked by commit SHA and popped by identity, so your
own stashes are never disturbed.

**It commits narrowly.** Only the manifest and lockfile are staged, so unrelated
work in progress cannot ride along into a fix commit.

**It does not push without being told to.** Merging is local unless `gitPush`
is enabled. Auto-merging into a shared branch means unreviewed dependency
versions reach that branch and whatever CI runs on it — prefer pushing the fix
branch and opening a pull request.

**Reports contain sensitive material.** JSON and HTML reports include absolute
paths, your project inventory, and build output that may echo environment
values. They are written with owner-only permissions; keep `audit-reports/`
out of version control.

## Development

```bash
pnpm install
pnpm run typecheck   # type-checks src/ and test/
pnpm test            # node:test via tsx — no test framework dependency
pnpm run test:watch
pnpm run build
```

### Tests

The suite covers the parts of depstorm that can damage a repository or
misreport a result:

| File                    | Covers                                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| `test/git.test.ts`      | Stash ownership, scoped reverts, scoped staging, merge/push separation |
| `test/config.test.ts`   | Config validation, report-path resolution, git-flag normalization      |
| `test/discover.test.ts` | Workspace discovery, depth semantics, exclusions, deduplication        |
| `test/audit.test.ts`    | npm/pnpm/yarn output parsing, audit-failure surfacing                  |
| `test/fix.test.ts`      | Fix eligibility rules, backup and restore of touched files             |
| `test/report.test.ts`   | Reverted-run accounting, `--fail-on` logic, HTML escaping              |

The git tests run against throwaway repositories created under the OS temp
directory, with local `user.name`, `user.email` and `core.autocrlf` so results
don't depend on your global git config. Several assert the *absence* of the old
destructive behaviour — for example that an untracked file survives a revert
that `git clean -fd` would have deleted.

## Known limitations

- **Yarn cannot be auto-fixed.** Yarn 1 has no non-interactive `audit fix` and
  Yarn Berry's audit interface differs. Yarn projects are audited and reported;
  fixes must be applied manually.
- **The severity threshold is a trigger, not a filter.** It decides *whether*
  to run `audit fix`; the package manager then fixes everything it can,
  including lower-severity advisories.
- **Workspace members are not audited individually.** A package with no
  lockfile of its own resolves through its workspace root, so depstorm audits
  the root and reports the member as covered rather than running an audit that
  could only fail.
