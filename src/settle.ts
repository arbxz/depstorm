import consola from "consola";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ageInDays,
  describeAge,
  fetchPublishTimes,
  parseLockedVersions,
  type FreshPackage,
} from "./cooldown.js";
import { detectIndent, majorCeiling } from "./overrides.js";
import type { DepstormConfig, ProjectInfo } from "./types.js";

/**
 * A fallback for a fix held by the release cooldown.
 *
 * The version a fix pins is usually not the advisory's package but something
 * the resolver re-resolved along the way: gnom's vite fix was held for a day
 * because pnpm took postcss 8.5.32, published 1.9 days earlier, when 8.5.31 was
 * ten days old and satisfied everything. And when it *is* the advisory's
 * package, the patched release is rarely the newest one — follow-redirects
 * advised ">=1.16.1" while the fix pinned 1.16.2 and was held for it.
 *
 * So rather than holding the whole fix, each too-fresh version is swapped for
 * the newest release on the same line that has cleared the cooldown. The swap
 * goes through a temporary override, which is then removed again: the
 * lockfile keeps the older resolution because it still satisfies every range,
 * and the manifest is left with no trace of the workaround.
 *
 * The resolver does not check a forced version against its dependents' ranges,
 * so the build verification and re-audit that follow a fix are what confirm the
 * older version works and still fixes the advisory.
 */

type Version = [number, number, number];

/** A plain release version, or null for a prerelease or anything unparseable. */
export function parseRelease(version: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Whether two versions sit on the same compatible line: the same major, or for
 * 0.x the same minor, which is where pre-1.0 packages put their breaking
 * changes. Same rule as the ceilings in overrides.ts.
 */
export function sameLine(a: string, b: string): boolean {
  const ca = majorCeiling(a);
  return ca !== null && ca === majorCeiling(b);
}

/**
 * The newest release older than `fresh`, on its line, that has existed for at
 * least `minAgeDays`. Null when there is none.
 */
export function pickSettledVersion(
  times: Record<string, string>,
  fresh: string,
  minAgeDays: number,
  now: number,
): { version: string; ageDays: number } | null {
  const freshParsed = parseRelease(fresh);
  if (!freshParsed) return null;

  let best: { version: string; parsed: Version; ageDays: number } | null = null;

  for (const [version, publishedAt] of Object.entries(times)) {
    const parsed = parseRelease(version);
    if (!parsed || compareVersions(parsed, freshParsed) >= 0) continue;
    if (!sameLine(version, fresh)) continue;

    const ageDays = ageInDays(publishedAt, now);
    if (ageDays === null || ageDays < minAgeDays) continue;

    if (!best || compareVersions(parsed, best.parsed) > 0) {
      best = { version, parsed, ageDays };
    }
  }

  return best ? { version: best.version, ageDays: best.ageDays } : null;
}

/**
 * Whether a bare-name override for `name` would only reach the one line the
 * fresh version is on. Forcing every copy of a package that the tree also holds
 * at another major would rewrite dependencies the fix never touched.
 */
export function overrideIsContained(
  locked: { name: string; version: string }[],
  name: string,
  fresh: string,
): boolean {
  return locked
    .filter((p) => p.name === name)
    .every((p) => sameLine(p.version, fresh));
}

/** The override block a temporary pin goes into, created when absent. */
function overrideBlock(
  pkg: Record<string, unknown>,
  project: ProjectInfo,
): Record<string, unknown> | null {
  const ensureObject = (
    container: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> | null => {
    const value = container[key];
    if (value === undefined) {
      const created: Record<string, unknown> = {};
      container[key] = created;
      return created;
    }
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  };

  if (project.packageManager === "pnpm") {
    const pnpm = ensureObject(pkg, "pnpm");
    return pnpm ? ensureObject(pnpm, "overrides") : null;
  }
  if (project.packageManager === "npm") return ensureObject(pkg, "overrides");
  return null;
}

export interface SettleOptions {
  config: DepstormConfig;
  /** The lockfile as the fix left it, before any settling */
  lockAfterFix: string;
  /** Reinstall from the manifest on disk; true on success */
  install: () => Promise<boolean>;
  now?: number;
}

/**
 * Swap each too-fresh version for the newest settled one on its line.
 *
 * Returns a description of every swap on success. Returns null, having put the
 * manifest back as it found it, when any version has no settled alternative,
 * would need an override that reaches other majors, or the install fails — the
 * caller then holds the fix exactly as it would have without this.
 */
export async function settleOnOlderReleases(
  project: ProjectInfo,
  fresh: FreshPackage[],
  options: SettleOptions,
): Promise<string[] | null> {
  const minAgeDays = options.config.minReleaseAgeDays ?? 0;
  const now = options.now ?? Date.now();
  const manifest = path.join(project.path, "package.json");

  let raw: string;
  let pkg: Record<string, unknown>;
  try {
    raw = await fs.readFile(manifest, "utf-8");
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const block = overrideBlock(pkg, project);
  if (!block) return null;

  const locked = parseLockedVersions(options.lockAfterFix, project.packageManager);
  const swaps: { name: string; from: string; to: string; ageDays: number }[] = [];

  for (const { name, version } of fresh) {
    // An override the project already declares for this exact name is its own
    // decision; replacing it, even briefly, could resolve against the wrong one.
    if (name in block) return null;
    if (!overrideIsContained(locked, name, version)) return null;
    // Two fresh versions of one package on one line cannot share a bare pin.
    if (swaps.some((s) => s.name === name)) return null;

    const times = await fetchPublishTimes(
      name,
      project.path,
      (options.config.timeouts?.audit ?? 180) * 1000,
    );
    const pick = times && pickSettledVersion(times, version, minAgeDays, now);
    if (!pick) return null;
    swaps.push({ name, from: version, to: pick.version, ageDays: pick.ageDays });
  }

  if (swaps.length === 0) return null;

  for (const swap of swaps) block[swap.name] = swap.to;

  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  await fs.writeFile(
    manifest,
    JSON.stringify(pkg, null, detectIndent(raw)) + trailingNewline,
  );

  const described = swaps.map(
    (s) => `${s.name} ${s.from} -> ${s.to} (${describeAge(s.ageDays)})`,
  );
  consola.info(
    `${project.name}: Trying settled releases instead of the held ones:\n${described.map((d) => `    ${d}`).join("\n")}`,
  );

  const pinned = await options.install();
  // The pin has done its job once the lockfile holds the older version; the
  // manifest goes back to exactly what the fix wrote.
  await fs.writeFile(manifest, raw);
  if (!pinned || !(await options.install())) {
    consola.warn(
      `${project.name}: Could not install the settled releases — holding the fix instead`,
    );
    return null;
  }

  return described;
}
