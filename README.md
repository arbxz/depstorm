# depstorm

A CLI tool that periodically audits, fixes, and verifies npm/pnpm/yarn projects for security vulnerabilities.

## Features

- **Project Discovery** — Scans directories to find all JS/TS projects by `package.json`
- **Package Manager Detection** — Auto-detects npm, pnpm, or yarn via lockfiles
- **Audit & Parse** — Runs `npm audit` / `pnpm audit` and normalizes the JSON output
- **Auto-Fix** — Applies safe fixes with configurable severity thresholds
- **Build Verification** — Runs the project's build script after fixes; reverts if it fails
- **Git Integration** — Creates branches, commits fixes automatically
- **Cron Scheduling** — Run audits on a schedule (e.g. every Monday at 9am)
- **Reporting** — Console summary + JSON and HTML reports

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

# Run the full pipeline
node dist/index.js run --root /path/to/your/projects

# Schedule recurring runs
node dist/index.js schedule --cron "0 9 * * 1" --root /path/to/your/projects
```

## Commands

### `run` (default)

Run the audit → fix → verify pipeline.

```bash
depstorm run [options]
```

| Option                     | Description                                             |
| -------------------------- | ------------------------------------------------------- |
| `-r, --root <paths...>`    | Root directories to scan                                |
| `-p, --project <paths...>` | Specific project paths                                  |
| `-c, --config <path>`      | Path to config file                                     |
| `-s, --severity <level>`   | Minimum severity: `info\|low\|moderate\|high\|critical` |
| `--no-fix`                 | Skip auto-fix                                           |
| `--no-build`               | Skip build verification                                 |
| `--no-git`                 | Skip git branch/commit                                  |
| `--report <path>`          | Output report file path                                 |
| `-d, --depth <number>`     | Max scan depth                                          |

### `schedule`

Run the pipeline on a cron schedule.

```bash
depstorm schedule --cron "0 9 * * 1"
```

### `scan`

Discover projects without running audits.

```bash
depstorm scan --root ./my-projects
```

### `init`

Create a default `.depstorm.json` config file.

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
  "scanDepth": 3,
  "excludeDirs": ["node_modules", ".git", "dist", "build", ".next", ".nuxt"],
  "schedule": "0 9 * * 1",
  "reportPath": "./audit-reports/report"
}
```

## Pipeline Workflow

```
Discover projects
  → Detect package manager (npm/pnpm/yarn)
  → Backup lockfile
  → Run audit (JSON output)
  → Parse vulnerabilities
  → If fixable & meets severity threshold:
      → Apply audit fix
      → Run build
        → If build passes → commit changes
        → If build fails → revert to backup
  → Generate report (console + JSON + HTML)
```
