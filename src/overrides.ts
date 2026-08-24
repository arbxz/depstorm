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
