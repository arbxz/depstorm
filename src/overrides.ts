import consola from "consola";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectInfo } from "./types.js";

/**
 * Health check for the override block a package manager writes when it fixes
 * a transitive advisory.
 *
 * `pnpm audit --fix` appends a new override every run and never prunes the
 * ones a later entry supersedes. The depstorm repository accumulated four
 * `brace-expansion` entries and three `js-yaml` entries this way, each a
 * slightly wider range than the last. Nothing breaks, but the manifest grows
 * without bound and the real constraint becomes impossible to read.
 *
 * Pruning correctly needs semver range subsumption and can produce a lockfile
 * that no longer resolves, so this deliberately only reports. Deciding what
 * to remove stays with the person who can check the result.
 */

/** An override key looks like "brace-expansion@>=4.0.0 <5.0.9" or "lodash". */
export function overridePackageName(key: string): string {
  // A leading @ is a scope, not a separator: "@scope/pkg@>=1" splits at the
  // second @, not the first.
  const at = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  return at === -1 ? key : key.slice(0, at);
}

export interface OverrideDuplicate {
  package: string;
  keys: string[];
}

/** Packages named by more than one override entry. */
export function findDuplicateOverrides(
  overrides: Record<string, unknown> | undefined,
): OverrideDuplicate[] {
  if (!overrides) return [];

  const byPackage = new Map<string, string[]>();
  for (const key of Object.keys(overrides)) {
    const name = overridePackageName(key);
    const existing = byPackage.get(name);
    if (existing) existing.push(key);
    else byPackage.set(name, [key]);
  }

  return [...byPackage.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([pkg, keys]) => ({ package: pkg, keys }));
}

/** Read the override block a project's manifest declares, for either manager. */
export function readOverrides(
  pkg: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const pnpm = pkg.pnpm as { overrides?: unknown } | undefined;
  const candidates = [pnpm?.overrides, pkg.overrides, pkg.resolutions];

  for (const candidate of candidates) {
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      return candidate as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Warn when a project's overrides have accumulated duplicates.
 *
 * Runs after a fix, which is the moment a new entry was just appended and the
 * moment the person reading the output is already thinking about dependencies.
 */
export async function reportOverrideDrift(
  project: ProjectInfo,
): Promise<OverrideDuplicate[]> {
  let pkg: Record<string, unknown>;
  try {
    const raw = await fs.readFile(
      path.join(project.path, "package.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    pkg = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const duplicates = findDuplicateOverrides(readOverrides(pkg));
  if (duplicates.length === 0) return duplicates;

  consola.warn(
    `${project.name}: ${duplicates.length} package(s) have stacked-up override entries — "${project.packageManager} audit --fix" appends and never prunes:\n${duplicates
      .map((d) => `  ${d.package}: ${d.keys.length} entries\n${d.keys.map((k) => `    - ${k}`).join("\n")}`)
      .join("\n")}\nOnly the narrowest entry usually still matters. Review and remove the superseded ones by hand.`,
  );

  return duplicates;
}

/**
 * The upper bound a package manager omits when it writes a fix override.
 *
 * `pnpm audit --fix` records the remedy for an advisory as an open-ended
 * minimum — `">=7.3.5"`. That satisfies the advisory but places no ceiling on
 * the resolution, so pnpm is free to take the newest release of any later
 * major. In shadowscript-studios-react it took vite 8.2.2 for an advisory
 * whose fix shipped in 7.3.5, and vite 8 broke @tanstack/router-plugin — a
 * clean audit whose build no longer ran.
 *
 * Bounding each remedy to the major it was published in keeps the security
 * fix and leaves the major upgrade where it belongs: a deliberate decision,
 * reported as "needs a semver-major upgrade" rather than smuggled in by a
 * transitive override.
 */

/** First concrete version in a range string, e.g. ">=7.3.5" -> "7.3.5". */
function firstVersion(range: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  return m ? m[0] : null;
}

/**
 * The exclusive ceiling for the major a version belongs to.
 *
 * Pre-1.0 packages break on the minor, not the major, so 0.x is capped at the
 * next minor — treating "0.5.3" as safe up to "1.0.0" would be exactly the
 * unreviewed breaking change this is here to prevent.
 */
export function majorCeiling(version: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major === 0 ? `0.${String(minor + 1)}.0` : `${String(major + 1)}.0.0`;
}

/**
 * Add a major ceiling to an open-ended override value.
 *
 * Returns the value unchanged when it already constrains the upper end, when
 * it is not a lower-bound range (an exact pin, a caret or a tilde already
 * carry their own ceiling), or when no version can be read out of it.
 */
export function boundOverrideValue(value: string): string {
  const trimmed = value.trim();

  // Already bounded above, or carries its own implicit ceiling.
  if (trimmed.includes("<")) return value;
  if (/^[\^~=]/.exec(trimmed)) return value;
  if (!trimmed.startsWith(">")) return value;
  // A disjunction means several ranges; bounding only the first would silently
  // change which releases the others admit.
  if (trimmed.includes("||")) return value;

  const version = firstVersion(trimmed);
  if (!version) return value;

  const ceiling = majorCeiling(version);
  if (!ceiling) return value;

  return `${trimmed} <${ceiling}`;
}

/** Every open-ended entry in an override block, bounded to its own major. */
export function boundOverrides(
  overrides: Record<string, unknown>,
): { bounded: Record<string, unknown>; changed: string[] } {
  const bounded: Record<string, unknown> = {};
  const changed: string[] = [];

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string") {
      bounded[key] = value;
      continue;
    }
    const next = boundOverrideValue(value);
    bounded[key] = next;
    if (next !== value) changed.push(`${key}: "${value}" -> "${next}"`);
  }

  return { bounded, changed };
}

/** Where a manifest keeps its override block, in the order readOverrides looks. */
type OverrideSlot = { container: Record<string, unknown>; key: string };

function findOverrideSlot(
  pkg: Record<string, unknown>,
): OverrideSlot | null {
  const pnpm = pkg.pnpm as Record<string, unknown> | undefined;
  const candidates: OverrideSlot[] = [
    ...(pnpm && typeof pnpm === "object" && !Array.isArray(pnpm)
      ? [{ container: pnpm, key: "overrides" }]
      : []),
    { container: pkg, key: "overrides" },
    { container: pkg, key: "resolutions" },
  ];

  for (const slot of candidates) {
    const value = slot.container[slot.key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return slot;
    }
  }
  return null;
}

/**
 * The manifest's own indentation, so rewriting it does not reformat the file.
 *
 * A whole-file reindent turns a two-line security fix into a diff nobody can
 * review, and in a repository using tabs it fights the formatter on every
 * subsequent commit.
 */
export function detectIndent(raw: string): string | number {
  const m = /\n([ \t]+)"/.exec(raw);
  if (!m) return 2;
  const indent = m[1];
  return indent.startsWith("\t") ? "\t" : indent.length;
}

/**
 * Bound every open-ended override a fix just wrote, in place.
 *
 * Called between `audit fix` and the reinstall, so the ceilings are already
 * in the manifest when the lockfile is resolved — bounding afterwards would
 * mean the lockfile still pinned the major the override was meant to exclude.
 *
 * Returns the descriptions of what it tightened, empty when nothing needed it.
 */
export async function boundProjectOverrides(
  project: ProjectInfo,
): Promise<string[]> {
  const manifest = path.join(project.path, "package.json");

  let raw: string;
  try {
    raw = await fs.readFile(manifest, "utf-8");
  } catch {
    return [];
  }

  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    pkg = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const slot = findOverrideSlot(pkg);
  if (!slot) return [];

  const current = slot.container[slot.key] as Record<string, unknown>;
  const { bounded, changed } = boundOverrides(current);
  if (changed.length === 0) return [];

  slot.container[slot.key] = bounded;

  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  await fs.writeFile(
    manifest,
    JSON.stringify(pkg, null, detectIndent(raw)) + trailingNewline,
  );

  consola.info(
    `${project.name}: Bounded ${String(changed.length)} override(s) to their current major, so the fix cannot pull in a breaking release:\n${changed
      .map((c) => `    ${c}`)
      .join("\n")}`,
  );

  return changed;
}
