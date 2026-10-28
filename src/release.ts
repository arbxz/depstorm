import consola from "consola";
import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { redactGitError } from "./git.js";
import { detectIndent } from "./overrides.js";
import { compareVersions, parseRelease } from "./settle.js";
import type { ProjectInfo } from "./types.js";

/**
 * Cutting a release after a fix lands on a release branch.
 *
 * A repository that ships versioned builds — a Tauri app whose installed
 * copies update themselves from GitHub releases, a package with tags — does
 * not get its fixes to anyone from a bare push to main. Installed copies only
 * see a new version. So once a fix is merged and pushed to a release branch,
 * the patch version is bumped in every file that carries it, committed as
 * "Release X.Y.Z", tagged and pushed; a tag-triggered workflow then builds and
 * publishes, and without one the GitHub CLI creates the release page.
 *
 * A repository counts as having a release system only on evidence: semver
 * tags, or a workflow triggered by pushing one. A version field alone is not
 * evidence — every package.json has one, and most sit at 0.0.0 forever.
 */

export const DEFAULT_RELEASE_BRANCHES = ["main", "master"];

/** One file that carries the project's version, and how to rewrite it. */
export interface VersionFile {
  /** Path relative to the repository root, with forward slashes */
  file: string;
  version: string;
  write: (raw: string, next: string) => string;
}

export interface ReleaseSystem {
  version: string;
  files: VersionFile[];
  /** "v" when the existing tags are "v1.2.3", "" when they are "1.2.3" */
  tagPrefix: string;
  /** Path of a workflow that publishes when a tag is pushed, if any */
  tagWorkflow?: string;
}

/** The next patch release. Null for anything that is not a plain release. */
export function nextPatch(version: string): string | null {
  const v = parseRelease(version);
  return v ? `${String(v[0])}.${String(v[1])}.${String(v[2] + 1)}` : null;
}

/**
 * Rewrite a JSON file's top-level "version" in place.
 *
 * Only the line at the file's own indentation is touched, so a nested
 * "version" — a dependency's, a schema's — is never mistaken for it, and the
 * rest of the file keeps its formatting byte for byte.
 */
export function setJsonVersion(raw: string, next: string): string {
  const indent = detectIndent(raw);
  const unit = typeof indent === "number" ? " ".repeat(indent) : indent;
  const line = new RegExp(`^(${unit}"version"\\s*:\\s*")[^"]*(")`, "m");
  return raw.replace(line, `$1${next}$2`);
}

export function readJsonVersion(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** The `[package]` table's name and version, when the version is literal. */
export function readCargoPackage(
  raw: string,
): { name: string; version: string } | null {
  const table = /^\[package\][^\S\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(raw);
  if (!table) return null;
  const name = /^name\s*=\s*"([^"]+)"/m.exec(table[1]);
  const version = /^version\s*=\s*"([^"]+)"/m.exec(table[1]);
  return name && version ? { name: name[1], version: version[1] } : null;
}

export function setCargoVersion(raw: string, next: string): string {
  return raw.replace(
    /(^\[package\][\s\S]*?^version\s*=\s*")[^"]*(")/m,
    `$1${next}$2`,
  );
}

/** Rewrite the lockfile entry for the crate itself, and only that one. */
export function setCargoLockVersion(
  raw: string,
  crate: string,
  next: string,
): string {
  const escaped = crate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw.replace(
    new RegExp(`(^name = "${escaped}"\\r?\\nversion = ")[^"]*(")`, "m"),
    `$1${next}$2`,
  );
}

/** Whether a workflow file runs on a pushed tag. */
export function isTagTriggered(workflow: string): boolean {
  const on = /^on:\s*\n([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(workflow);
  return on !== null && /^\s+push:[\s\S]*?^\s+tags:/m.test(on[1]);
}

/** Tags that name a release: "v1.2.3" or "1.2.3", sorted newest first. */
export function releaseTags(tags: string[]): string[] {
  return tags
    .filter((t) => parseRelease(t.replace(/^v/, "")) !== null)
    .sort((a, b) => {
      const va = parseRelease(a.replace(/^v/, ""));
      const vb = parseRelease(b.replace(/^v/, ""));
      return va && vb ? compareVersions(vb, va) : 0;
    });
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

async function findTagWorkflow(root: string): Promise<string | undefined> {
  const dir = path.join(root, ".github", "workflows");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries.sort()) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const raw = await readIfExists(path.join(dir, entry));
    if (raw && isTagTriggered(raw)) return `.github/workflows/${entry}`;
  }
  return undefined;
}

/**
 * Work out whether, and how, a repository releases.
 *
 * Returns null when there is no evidence of a release system, and throws when
 * there is one but its version files disagree: bumping one of several
 * disagreeing versions is how an updater ends up never seeing a release.
 */
export async function detectReleaseSystem(
  root: string,
  tags: string[],
): Promise<ReleaseSystem | null> {
  const files: VersionFile[] = [];

  const pkg = await readIfExists(path.join(root, "package.json"));
  const pkgVersion = pkg === null ? null : readJsonVersion(pkg);
  if (pkgVersion) {
    files.push({ file: "package.json", version: pkgVersion, write: setJsonVersion });
  }

  for (const dir of ["", "src-tauri/"]) {
    const tauri = await readIfExists(path.join(root, `${dir}tauri.conf.json`));
    const tauriVersion = tauri === null ? null : readJsonVersion(tauri);
    // Tauri also accepts a path to package.json here, which needs no bump.
    if (tauriVersion && parseRelease(tauriVersion)) {
      files.push({
        file: `${dir}tauri.conf.json`,
        version: tauriVersion,
        write: setJsonVersion,
      });
    }

    const cargo = await readIfExists(path.join(root, `${dir}Cargo.toml`));
    const crate = cargo === null ? null : readCargoPackage(cargo);
    if (crate) {
      files.push({
        file: `${dir}Cargo.toml`,
        version: crate.version,
        write: setCargoVersion,
      });
      const lock = await readIfExists(path.join(root, `${dir}Cargo.lock`));
      if (lock !== null) {
        files.push({
          file: `${dir}Cargo.lock`,
          version: crate.version,
          write: (raw, next) => setCargoLockVersion(raw, crate.name, next),
        });
      }
    }
  }

  const releases = releaseTags(tags);
  const tagWorkflow = await findTagWorkflow(root);
  if (files.length === 0 || (releases.length === 0 && !tagWorkflow)) return null;

  const versions = [...new Set(files.map((f) => f.version))];
  if (versions.length > 1) {
    throw new Error(
      `version files disagree (${files.map((f) => `${f.file} ${f.version}`).join(", ")}) — align them by hand before releasing`,
    );
  }

  return {
    version: versions[0],
    files,
    tagPrefix: releases.length > 0 && !releases[0].startsWith("v") ? "" : "v",
    tagWorkflow,
  };
}

export interface ReleaseOutcome {
  version: string;
  tag: string;
  /** Who publishes the release page */
  publishedBy: "workflow" | "gh" | "nobody";
}

async function hasGh(): Promise<boolean> {
  const result = await execa("gh", ["--version"], { reject: false });
  return result.exitCode === 0;
}

export interface ReleasePlan {
  system: ReleaseSystem;
  from: string;
  to: string;
  tag: string;
}

/**
 * Decide whether the branch the repository is on should be released, without
 * changing anything.
 *
 * Refuses unless the branch is exactly what origin has — a release must be of
 * commits that are already public, never of local work that rides along with
 * the tag — and when the newest version tag is already its head.
 */
export async function planRelease(
  repo: ProjectInfo,
  branch: string,
): Promise<ReleasePlan | { skip: string }> {
  const git = simpleGit(repo.path);

  if (!(await git.status()).isClean()) {
    return { skip: "the working tree has uncommitted changes" };
  }

  if (!(await git.getRemotes()).some((r) => r.name === "origin")) {
    return { skip: "no origin remote to release to" };
  }

  await git.fetch(["origin", branch, "--tags"]);
  const ahead = await git.raw(["rev-list", "--count", `origin/${branch}..${branch}`]);
  const behind = await git.raw(["rev-list", "--count", `${branch}..origin/${branch}`]);
  if (ahead.trim() !== "0" || behind.trim() !== "0") {
    return { skip: `${branch} is not in sync with origin/${branch}` };
  }

  const tags = (await git.tags()).all;
  const system = await detectReleaseSystem(repo.path, tags);
  if (!system) {
    return { skip: "no release system (no version tags or tag-triggered workflow)" };
  }

  const lastTag = `${system.tagPrefix}${system.version}`;
  if (tags.includes(lastTag)) {
    const since = await git.raw(["rev-list", "--count", `${lastTag}..${branch}`]);
    if (since.trim() === "0") {
      return { skip: `${lastTag} is already the head of ${branch} — nothing to release` };
    }
  }

  const next = nextPatch(system.version);
  if (!next) return { skip: `"${system.version}" is not a plain release version` };
  const tag = `${system.tagPrefix}${next}`;
  if (tags.includes(tag)) return { skip: `tag ${tag} already exists` };

  return { system, from: system.version, to: next, tag };
}

/**
 * Bump, commit, tag and push a release of the branch the repository is on.
 *
 * Returns null, having changed nothing, when planRelease finds a reason not
 * to release, and undoes its own work when a step fails part-way.
 */
export async function releaseRepository(
  repo: ProjectInfo,
  branch: string,
  notes: string,
): Promise<ReleaseOutcome | null> {
  const git = simpleGit(repo.path);
  // How far a release got, so a failure can be undone to exactly that point.
  const wrote: string[] = [];
  let committed = false;
  let tagged: string | undefined;
  let pushed = false;

  try {
    const plan = await planRelease(repo, branch);
    if ("skip" in plan) {
      consola.info(`${repo.name}: Not releasing — ${plan.skip}`);
      return null;
    }
    const { system, to: next, tag } = plan;

    for (const file of system.files) {
      const full = path.join(repo.path, ...file.file.split("/"));
      const raw = await fs.readFile(full, "utf-8");
      const updated = file.write(raw, next);
      if (updated === raw) {
        throw new Error(`could not find the version in ${file.file}`);
      }
      await fs.writeFile(full, updated);
      wrote.push(file.file);
    }

    await git.add(wrote);
    await git.commit(`Release ${next}\n\n${notes}`);
    committed = true;
    await git.addAnnotatedTag(tag, `${repo.name} ${next}`);
    tagged = tag;
    await git.push("origin", branch);
    pushed = true;
    await git.push("origin", tag);
    consola.success(`${repo.name}: Released ${tag} (${system.version} -> ${next})`);

    if (system.tagWorkflow) {
      consola.info(`${repo.name}: ${system.tagWorkflow} publishes the release from the tag`);
      return { version: next, tag, publishedBy: "workflow" };
    }

    if (await hasGh()) {
      const created = await execa(
        "gh",
        ["release", "create", tag, "--verify-tag", "--generate-notes", "--title", `${repo.name} ${next}`],
        { cwd: repo.path, reject: false },
      );
      if (created.exitCode === 0) return { version: next, tag, publishedBy: "gh" };
      consola.warn(`${repo.name}: gh release create failed: ${created.stderr.slice(0, 300)}`);
    }

    consola.warn(
      `${repo.name}: Tagged ${tag}, but nothing publishes a release page for it — create one on GitHub, or install the GitHub CLI`,
    );
    return { version: next, tag, publishedBy: "nobody" };
  } catch (err) {
    consola.error(`${repo.name}: Release failed: ${redactGitError(err)}`);
    await undoRelease(repo, { wrote, committed, tagged, pushed });
    return null;
  }
}

/**
 * Put the repository back after a release that failed part-way.
 *
 * Once the release commit is on origin it is public and stays; only the local
 * tag that failed to follow it is left for a retry. Before that, the commit,
 * the tag and the edited version files are all depstorm's own and are removed.
 * `reset --keep` refuses rather than discards if anything else changed.
 */
async function undoRelease(
  repo: ProjectInfo,
  state: { wrote: string[]; committed: boolean; tagged?: string; pushed: boolean },
): Promise<void> {
  const git = simpleGit(repo.path);
  try {
    if (state.pushed) {
      consola.warn(
        `${repo.name}: The release commit reached origin but its tag did not — push it with: git push origin ${state.tagged ?? "<tag>"}`,
      );
      return;
    }
    if (state.tagged) await git.tag(["-d", state.tagged]);
    if (state.committed) {
      await git.reset(["--keep", "HEAD~1"]);
      consola.info(`${repo.name}: Removed the unpushed release commit`);
      return;
    }
    if (state.wrote.length > 0) {
      // From HEAD, not the index: a failed commit leaves the bump staged.
      await git.checkout(["HEAD", "--", ...state.wrote]);
      consola.info(`${repo.name}: Restored ${state.wrote.join(", ")}`);
    }
  } catch (err) {
    consola.error(
      `${repo.name}: Could not undo the failed release — check the version files and tags by hand: ${redactGitError(err)}`,
    );
  }
}
