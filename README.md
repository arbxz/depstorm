# depstorm

A CLI tool that periodically audits, fixes, and verifies npm/pnpm/yarn projects for security vulnerabilities.

> **⚠️ Read [Security model](#security-model) before pointing depstorm at a directory.**
> Auditing a project runs its package manager, and verifying a fix runs its build
> script. Only run depstorm against code you trust.

## Features

- **Project Discovery** — Scans directories to find all JS/TS projects by `package.json`, including monorepo workspace members
- **Package Manager Detection** — Auto-detects npm, pnpm, or yarn via lockfiles
- **Audit & Parse** — Runs `npm audit` / `pnpm audit` / `yarn audit` / `yarn npm audit` (Berry) and normalizes the output
- **Honest fixability** — Separates fixes `audit fix` will apply from ones needing a **semver-major upgrade**, which it reports rather than attempts
- **Auto-Fix** — Applies safe fixes with configurable severity thresholds, then **re-audits to confirm what actually changed**
- **Build Verification** — Runs `build`, `typecheck`, `test` or `tsc --noEmit` after fixes; reverts if it fails
- **Git Integration** — Branches and commits per **repository**, staging only manifests and lockfiles
- **Ignore list** — Record consciously accepted advisories, with a mandatory reason and an optional expiry
- **Cron Scheduling** — Run audits on a schedule, with overlapping runs prevented
- **Reporting** — Console summary + JSON and HTML reports, with linked advisories and a suggested next command
- **Dry Run** — See exactly what would happen without changing anything
- **Interrupt-safe** — Ctrl+C unwinds the branch, stash and backups instead of abandoning them

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
| `--fail-on-quality <level>`| Exit non-zero if code quality issues at or above this level remain |
| `--ignore <packages...>`   | Suppress advisories for these packages, this run only          |
| `--concurrency <number>`   | Repositories to process at once (only when git operations are off) |
| `--report <path>`          | Report output path (`.json`/`.html` are appended for you)      |
| `--no-report`              | Do not write report files, even if the config asks for them     |
| `-y, --yes`                | Answer prompts with their defaults and never block              |
| `--no-prompt`              | Never prompt; use whatever the config already says              |

**Exit codes**

| Code | Meaning |
| ---- | ------- |
| `0`  | Clean |
| `1`  | Operational failure — an audit or fix failed, a revert could not be completed, or stashed work could not be restored |
| `2`  | Policy failure — `--fail-on` or `--fail-on-quality` threshold breached |

This makes `depstorm run --fail-on high` usable as a CI gate.

### `schedule`

Run the pipeline on a cron schedule. Projects are re-discovered on every run,
and a tick arriving while the previous run is still going is skipped rather
than started alongside it.

```bash
depstorm schedule --cron "0 9 * * 1" --run-now --timezone Europe/Paris
```

| Option               | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `--cron <expression>`| Cron expression                                       |
| `--run-now`          | Run once immediately, then keep to the schedule        |
| `--timezone <name>`  | IANA timezone the expression is interpreted in         |

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
  "reportPath": "./audit-reports/report",
  "concurrency": 1,
  "timeouts": { "audit": 180, "install": 600, "build": 300, "sonar": 300 },
  "ignore": []
}
```

`timeouts` are in seconds. `concurrency` is only honoured when nothing writes
to git — see [Concurrency](#concurrency).

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

Git work is done **per repository, not per project**. Several discovered
projects can live in one repository — `repo/{api,web}/`, or a monorepo root
with its workspace members — and that repository is stashed, branched and
committed once, with every project's manifest and lockfile in the same commit.

### Ignoring advisories

Some advisories are consciously accepted: a dev-only transitive, or one with
no patch yet. Recording that beats turning the gate off.

```json
{
  "ignore": [
    {
      "package": "brace-expansion",
      "reason": "dev-only transitive, not reachable at runtime",
      "expires": "2026-12-31"
    },
    { "advisory": "GHSA-xxxx-xxxx-xxxx", "reason": "no patch published yet" }
  ]
}
```

Match on `package`, on `advisory` (a GHSA id, a CVE id, or a registry's
numeric id — read from the advisory URL), or on both. Two rules keep the list
honest:

- **`reason` is required.** A config with an undocumented suppression is
  rejected, not quietly accepted.
- **`expires` is inclusive and optional.** Past it, the rule stops suppressing
  and the advisory reappears — and the config load says which rules lapsed, so
  it does not happen silently.

Suppressed advisories are excluded from every count and from `--fail-on`, but
they are still listed in both reports. A suppression nobody can see is
indistinguishable from a bug.

`--ignore <packages...>` covers one-off runs.

### Concurrency

`--concurrency <n>` processes several repositories at once. It applies only
when nothing writes to git — branching and stashing move `HEAD`, and
interleaved "stash these changes?" prompts would be unanswerable. Combine it
with `--dry-run` or `--no-git`; asking for it alongside git operations is
refused out loud rather than ignored.

## Pipeline Workflow

```
Discover projects
  → Detect package manager (npm/pnpm/yarn, yarn 1 vs Berry)
  → Find each project's git repository (may be an ancestor directory)
  → Group projects by repository — a repository is one unit of git work

For each repository:
  → For each project: run audit, parse, apply ignore rules
      → Audit failed? report it as UNKNOWN, never as clean
      → Optionally run SonarJS code quality checks
  → Decide which projects can be fixed
      (severity threshold, fixability, package manager, breaking-only fixes)
      → None? stop here — no branches, no stashing
  → Check the working tree is clean (prompt to stash; skip if unattended)
  → Pull the source branch, create audit-fix/<date>          ← once per repository
  → For each fixable project:
      → Back up package.json + lockfile
      → Apply audit fix, reinstall with --ignore-scripts
      → Re-audit to confirm what was actually fixed
      → Verify: build → typecheck → test → tsc --noEmit
          → Fails → restore that project only, reinstall, report as reverted
  → Commit every surviving project's manifest and lockfile   ← one commit
      → gitPush  → push the fix branch
      → gitMerge → merge into the source branch (push only if gitPush)
  → Return to the original branch, restore the stash
      → Conflicted pop? report it and fail the run

Generate report (console + JSON + HTML)
```

Ctrl+C at any point runs the same unwind the normal path does — branch, stash
and backups — and prints recovery commands for anything it could not finish.

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

**It commits narrowly.** Only manifests and lockfiles are staged, and only for
the projects that actually produced a verified fix, so unrelated work in
progress cannot ride along into a fix commit.

**It cleans up when interrupted.** Ctrl+C runs the same unwind the normal path
does — remove backups, return to the original branch, pop the stash — bounded
by a short time budget so an interrupt always exits. Whatever it could not
finish is printed with the branch name, stash label and recovery commands. A
second Ctrl+C exits immediately.

**It reports a half-restored tree as a failure.** If popping your stash
conflicts, the working tree contains conflict markers. depstorm says so, keeps
the stash, and exits non-zero rather than reporting a successful run.

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

| File                     | Covers                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| `test/git.test.ts`       | Stash ownership, scoped reverts, scoped staging, merge/push separation |
| `test/config.test.ts`    | Config validation, report paths, git-flag normalization, timeouts      |
| `test/discover.test.ts`  | Workspace discovery, git-root detection, depth semantics, grouping     |
| `test/audit.test.ts`     | npm/pnpm/yarn/Berry parsing, breaking-fix accounting, audit failures   |
| `test/fix.test.ts`       | Fix eligibility rules, backup and restore of touched files             |
| `test/report.test.ts`    | Reverted-run accounting, `--fail-on`, HTML escaping and linking        |
| `test/ignore.test.ts`    | Advisory matching, expiry, recounting, ignore-rule validation          |
| `test/pipeline.test.ts`  | Repository-relative staging paths                                      |
| `test/cleanup.test.ts`   | Interrupt unwind ordering, failure isolation, the time budget          |
| `test/scheduler.test.ts` | Overlap prevention, cadence descriptions                               |
| `test/sonar.test.ts`     | Rule severity classification                                           |
| `test/overrides.test.ts` | Override drift detection, scoped-name parsing                          |
| `test/semaphore.test.ts` | Concurrency limits, result ordering, slot release on failure           |

The git tests run against throwaway repositories created under the OS temp
directory, with local `user.name`, `user.email` and `core.autocrlf` so results
don't depend on your global git config. Several assert the *absence* of the old
destructive behaviour — for example that an untracked file survives a revert
that `git clean -fd` would have deleted.

## Known limitations

- **Yarn cannot be auto-fixed.** Yarn 1 has no non-interactive `audit fix`,
  and Yarn Berry has none either. Both are now audited accurately — Berry via
  `yarn npm audit` — but fixes must be applied manually.
- **Breaking fixes are reported, not applied.** An advisory whose only remedy
  is a semver-major upgrade is counted separately and named in the report with
  the command to run. depstorm will not bump a major for you.
- **The severity threshold is a trigger, not a filter.** It decides *whether*
  to run `audit fix`; the package manager then fixes everything it can,
  including lower-severity advisories.
- **Workspace members are not audited individually.** A package with no
  lockfile of its own resolves through its workspace root, so depstorm audits
  the root and reports the member as covered rather than running an audit that
  could only fail.
- **Override drift is reported, not pruned.** `pnpm audit --fix` appends an
  override entry every run and never removes superseded ones. depstorm names
  the packages that have stacked up; pruning them correctly needs semver range
  subsumption and a wrong answer breaks the lockfile, so that stays manual.
