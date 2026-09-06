import { execa } from "execa";
import consola from "consola";
import { mapWithLimit } from "./semaphore.js";
import type { DepstormConfig, PackageManager, ProjectInfo } from "./types.js";

/**
 * A quarantine on freshly published versions.
 *
 * The npm supply-chain compromises of recent years share a shape: a
 * maintainer account is taken over, a malicious patch is published, and it is
 * pulled into thousands of builds within hours — then yanked once someone
 * notices. `audit fix` is exactly the mechanism that pulls it in, because a
 * brand-new patch release is precisely what it goes looking for.
 *
 * Waiting a few days before accepting a version does not make a package safe,
 * but it moves the build out of the window where these are caught. It costs
 * nothing but latency on a fix that is, by construction, not urgent: the
 * advisory being fixed is already public and already in the tree.
 */

/** How long a version must have existed before depstorm will install it. */
export const DEFAULT_MIN_RELEASE_AGE_DAYS = 3;

/** How many registry lookups to run at once. */
const REGISTRY_CONCURRENCY = 8;

const MS_PER_DAY = 86_400_000;

export interface PackageVersion {
  name: string;
  version: string;
}

export interface FreshPackage extends PackageVersion {
  /** ISO timestamp the registry reports for this version */
  publishedAt: string;
  /** How long the version has existed, in days, at the time of the check */
  ageDays: number;
}

/**
 * Every `name@version` a lockfile pins.
 *
 * Only the resolved tree is worth reading. A manifest range says what is
 * permitted; the lockfile says what would actually be installed, which is the
 * thing a compromised release has to get into.
 */
export function parseLockedVersions(
  raw: string,
  packageManager: PackageManager,
): PackageVersion[] {
  if (packageManager === "npm") return parseNpmLock(raw);
  if (packageManager === "pnpm") return parsePnpmLock(raw);
  return parseYarnLock(raw);
}

function parseNpmLock(raw: string): PackageVersion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];

  const packages = (parsed as { packages?: unknown }).packages;
  if (packages === null || typeof packages !== "object") return [];

  const found: PackageVersion[] = [];
  for (const [key, value] of Object.entries(
    packages as Record<string, unknown>,
  )) {
    // "" is the project itself, and it has no registry entry to check.
    if (key === "") continue;
    const marker = key.lastIndexOf("node_modules/");
    if (marker === -1) continue;
    const name = key.slice(marker + "node_modules/".length);
    const version = (value as { version?: unknown }).version;
    if (typeof version === "string" && name) found.push({ name, version });
  }
  return found;
}

/**
 * Read the `packages:` block of a pnpm lockfile.
 *
 * Deliberately not `snapshots:`, whose keys carry peer suffixes like
 * `vite@7.3.6(@types/node@22.0.0)` and would otherwise be read as versions no
 * registry has ever heard of.
 */
function parsePnpmLock(raw: string): PackageVersion[] {
  const found: PackageVersion[] = [];
  let inPackages = false;

  for (const line of raw.split("\n")) {
    // A non-indented line starts a new top-level block.
    if (/^[a-zA-Z]/.test(line)) {
      inPackages = line.startsWith("packages:");
      continue;
    }
    if (!inPackages) continue;

    const m = PNPM_ENTRY.exec(line);
    if (m) found.push({ name: m[1], version: m[2] });
  }
  return found;
}

/** Matches `  vite@7.3.6:` and `  '@babel/core@7.29.7':` */
const PNPM_ENTRY = new RegExp(
  "^ {2}'?((?:@[^/'\\s]+/)?[^@'\\s]+)@([^'\\s():]+)'?:\\s*$",
);

/** Matches the `  version "7.3.6"` line under a yarn.lock entry. */
const YARN_VERSION = /^ {2}version:? "?([^"\s]+)"?/;
/** Matches the `"vite@^7.0.0":` header line that opens a yarn.lock entry. */
const YARN_HEADER = /^"?((?:@[^/@"]+\/)?[^@"]+)@/;

function parseYarnLock(raw: string): PackageVersion[] {
  const found: PackageVersion[] = [];
  let name: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.startsWith(" ")) {
      const header = YARN_HEADER.exec(line);
      if (header) name = header[1];
      continue;
    }
    const version = YARN_VERSION.exec(line);
    if (version && name) found.push({ name, version: version[1] });
  }
  return found;
}

/** The `name@version` pairs present after a fix that were not there before. */
export function addedVersions(
  before: PackageVersion[],
  after: PackageVersion[],
): PackageVersion[] {
  const had = new Set(before.map((p) => `${p.name}@${p.version}`));
  const seen = new Set<string>();
  const added: PackageVersion[] = [];

  for (const pkg of after) {
    const key = `${pkg.name}@${pkg.version}`;
    if (had.has(key) || seen.has(key)) continue;
    seen.add(key);
    added.push(pkg);
  }
  return added;
}

/**
 * Publish timestamps for a package, keyed by version.
 *
 * Shelling out to `npm view` rather than calling the registry directly is
 * deliberate: it honours whatever .npmrc, private registry and auth the
 * project already uses, which a hardcoded registry.npmjs.org URL would not.
 */
export async function fetchPublishTimes(
  name: string,
  cwd: string,
  timeout: number,
): Promise<Record<string, string> | null> {
  const result = await execa("npm", ["view", name, "time", "--json"], {
    cwd,
    reject: false,
    timeout,
  });

  if (result.exitCode !== 0) return null;

  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

export function ageInDays(publishedAt: string, now: number): number | null {
  const at = Date.parse(publishedAt);
  if (Number.isNaN(at)) return null;
  return (now - at) / MS_PER_DAY;
}

export interface CooldownResult {
  /** Versions younger than the threshold */
  tooFresh: FreshPackage[];
  /** Packages whose publish date could not be established */
  unknown: string[];
  /** How many distinct versions were checked */
  checked: number;
}

/**
 * Find the newly added versions that are younger than the cooldown.
 *
 * A lookup that fails is reported but does not block. An unreachable registry
 * is a far more common cause than a compromised package, and refusing every
 * fix on a flaky network would only teach people to turn the check off.
 */
export async function findTooFresh(
  added: PackageVersion[],
  options: { cwd: string; minAgeDays: number; timeout: number; now?: number },
): Promise<CooldownResult> {
  const now = options.now ?? Date.now();
  const byName = new Map<string, string[]>();

  for (const { name, version } of added) {
    const versions = byName.get(name);
    if (versions) versions.push(version);
    else byName.set(name, [version]);
  }

  const tooFresh: FreshPackage[] = [];
  const unknown: string[] = [];

  await mapWithLimit(
    [...byName.entries()],
    REGISTRY_CONCURRENCY,
    async ([name, versions]) => {
      const times = await fetchPublishTimes(name, options.cwd, options.timeout);
      if (!times) {
        unknown.push(name);
        return;
      }

      for (const version of versions) {
        const publishedAt = times[version];
        if (typeof publishedAt !== "string") {
          unknown.push(`${name}@${version}`);
          continue;
        }
        const ageDays = ageInDays(publishedAt, now);
        if (ageDays === null) {
          unknown.push(`${name}@${version}`);
          continue;
        }
        if (ageDays < options.minAgeDays) {
          tooFresh.push({ name, version, publishedAt, ageDays });
        }
      }
    },
  );

  tooFresh.sort((a, b) => a.ageDays - b.ageDays);
  return { tooFresh, unknown, checked: added.length };
}

/** Human-readable age, so "0.3 days" reads as the few hours it actually is. */
export function describeAge(ageDays: number): string {
  if (ageDays < 1) {
    const hours = Math.max(0, Math.round(ageDays * 24));
    return `${String(hours)}h old`;
  }
  return `${ageDays.toFixed(1)}d old`;
}

/**
 * Check what a fix newly pinned, and report anything still in quarantine.
 *
 * An empty `tooFresh` means the fix is clear to keep.
 */
export async function checkReleaseCooldown(
  project: ProjectInfo,
  beforeLock: string,
  afterLock: string,
  config: DepstormConfig,
): Promise<CooldownResult> {
  const minAgeDays = config.minReleaseAgeDays ?? DEFAULT_MIN_RELEASE_AGE_DAYS;

  const added = addedVersions(
    parseLockedVersions(beforeLock, project.packageManager),
    parseLockedVersions(afterLock, project.packageManager),
  );

  if (added.length === 0) return { tooFresh: [], unknown: [], checked: 0 };

  consola.info(
    `${project.name}: Checking the publish date of ${String(added.length)} newly pinned version(s)…`,
  );

  const result = await findTooFresh(added, {
    cwd: project.path,
    minAgeDays,
    // Reuse the audit budget: both are registry round-trips.
    timeout: (config.timeouts?.audit ?? 180) * 1000,
  });

  if (result.unknown.length > 0) {
    consola.warn(
      `${project.name}: Could not establish a publish date for ${String(result.unknown.length)} package(s) — not blocking on them: ${result.unknown.slice(0, 5).join(", ")}${result.unknown.length > 5 ? ", …" : ""}`,
    );
  }

  return result;
}
