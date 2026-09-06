import fs from "node:fs/promises";
import path from "node:path";
import consola from "consola";
import type { PackageManager, ProjectInfo } from "./types.js";

/**
 * Whether a fix quietly raised the Node version the project needs.
 *
 * Build verification runs on whatever Node depstorm happens to be using, so it
 * cannot see this class of breakage at all: a dependency bump pulls in a
 * package requiring a newer Node, the local toolchain already has it, the
 * build passes — and the deploy fails on a host that picked something older.
 *
 * nuxt-soundboard hit exactly this. A fix pulled in postcss-merge-longhand,
 * which calls Set.prototype.difference and declares
 * `engines: { node: "^22.11.0 || ^24.11.0 || >=26.0" }`. The project declared
 * no engines of its own, so Vercel chose its default Node and the build died
 * on "trustedFunctions.difference is not a function" — long after the commit
 * that caused it had been merged.
 *
 * The lockfile already records every dependency's engines, so this costs no
 * extra I/O and no registry calls.
 */

export interface NodeFloor {
  /** Lowest Node version the constraint admits, as [major, minor] */
  major: number;
  minor: number;
}

export interface EngineRequirement extends NodeFloor {
  /** The package that demands it, for the message */
  source: string;
  /** The raw range, so the user can check our reading of it */
  range: string;
}

/**
 * The lowest Node version a range admits.
 *
 * A range like "^22.11.0 || ^24.11.0 || >=26.0" is satisfied by 22.11, so the
 * floor is the *smallest* alternative, not the largest — reading it the other
 * way round would report a requirement the package does not actually make.
 */
export function lowestNodeFloor(range: string): NodeFloor | null {
  const alternatives = range.split("||");
  let lowest: NodeFloor | null = null;

  for (const alt of alternatives) {
    const m = /(\d+)(?:\.(\d+))?/.exec(alt);
    if (!m) continue;
    const candidate = { major: Number(m[1]), minor: Number(m[2] ?? 0) };
    if (
      !lowest ||
      candidate.major < lowest.major ||
      (candidate.major === lowest.major && candidate.minor < lowest.minor)
    ) {
      lowest = candidate;
    }
  }
  return lowest;
}

function higher(a: NodeFloor, b: NodeFloor): boolean {
  return a.major > b.major || (a.major === b.major && a.minor > b.minor);
}

export function formatFloor(floor: NodeFloor): string {
  return `${String(floor.major)}.${String(floor.minor)}`;
}

/** Matches `    engines: {node: '>=22.11'}` in a pnpm lockfile. */
const PNPM_ENGINES = /^\s+engines:\s*\{[^}]*\bnode:\s*'?([^',}]+)'?/;
/** Matches the `  vite@7.3.6:` entry a pnpm engines line belongs to. */
const PNPM_KEY = /^ {2}'?(\S+?)'?:\s*$/;

function fromPnpmLock(raw: string): EngineRequirement[] {
  const found: EngineRequirement[] = [];
  let current = "a dependency";

  for (const line of raw.split("\n")) {
    const key = PNPM_KEY.exec(line);
    if (key) {
      current = key[1];
      continue;
    }
    const engines = PNPM_ENGINES.exec(line);
    if (!engines) continue;

    const floor = lowestNodeFloor(engines[1]);
    if (floor) found.push({ ...floor, source: current, range: engines[1] });
  }
  return found;
}

function fromNpmLock(raw: string): EngineRequirement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const packages = (parsed as { packages?: unknown } | null)?.packages;
  if (packages === null || typeof packages !== "object") return [];

  const found: EngineRequirement[] = [];
  for (const [key, value] of Object.entries(
    packages as Record<string, unknown>,
  )) {
    if (key === "") continue;
    const node = (value as { engines?: { node?: unknown } }).engines?.node;
    if (typeof node !== "string") continue;

    const floor = lowestNodeFloor(node);
    if (floor) {
      const marker = key.lastIndexOf("node_modules/");
      const name = marker === -1 ? key : key.slice(marker + 13);
      found.push({ ...floor, source: name, range: node });
    }
  }
  return found;
}

/** Every Node floor the resolved tree declares. */
export function parseEngineRequirements(
  raw: string,
  packageManager: PackageManager,
): EngineRequirement[] {
  if (packageManager === "npm") return fromNpmLock(raw);
  if (packageManager === "pnpm") return fromPnpmLock(raw);
  return [];
}

/** The steepest Node requirement in the tree, or null if nothing declares one. */
export function strictestRequirement(
  requirements: EngineRequirement[],
): EngineRequirement | null {
  let strictest: EngineRequirement | null = null;
  for (const req of requirements) {
    if (!strictest || higher(req, strictest)) strictest = req;
  }
  return strictest;
}

/**
 * What the project itself says it runs on.
 *
 * `engines.node` is what a host reads; .nvmrc and .node-version are what a
 * developer's shell reads. Any of the three is enough to make the requirement
 * explicit rather than inherited.
 */
export async function declaredNode(
  projectPath: string,
): Promise<{ source: string; floor: NodeFloor } | null> {
  try {
    const raw = await fs.readFile(
      path.join(projectPath, "package.json"),
      "utf-8",
    );
    const pkg = JSON.parse(raw) as { engines?: { node?: unknown } };
    const node = pkg.engines?.node;
    if (typeof node === "string") {
      const floor = lowestNodeFloor(node);
      if (floor) return { source: `engines.node "${node}"`, floor };
    }
  } catch {
    // Fall through to the dotfiles.
  }

  for (const file of [".nvmrc", ".node-version"]) {
    try {
      const raw = (await fs.readFile(path.join(projectPath, file), "utf-8")).trim();
      const floor = lowestNodeFloor(raw);
      if (floor) return { source: `${file} "${raw}"`, floor };
    } catch {
      continue;
    }
  }

  return null;
}

export interface EngineCheck {
  /** The steepest requirement found in the tree */
  required: EngineRequirement;
  /** What the project declares, when it declares anything */
  declared: { source: string; floor: NodeFloor } | null;
  /** True when the project declares nothing, or declares something too low */
  unsatisfied: boolean;
}

/**
 * Compare what the tree needs against what the project promises, and say so.
 *
 * Reports rather than blocks: the fix itself is sound, and the remedy is a one
 * line `engines` field the user has to choose. Refusing the security fix over
 * it would be the wrong trade.
 */
export async function checkNodeEngines(
  project: ProjectInfo,
  lockRaw: string,
): Promise<EngineCheck | null> {
  const required = strictestRequirement(
    parseEngineRequirements(lockRaw, project.packageManager),
  );
  if (!required) return null;

  const declared = await declaredNode(project.path);
  const unsatisfied = !declared || higher(required, declared.floor);

  if (unsatisfied) {
    const need = formatFloor(required);
    consola.warn(
      declared
        ? `${project.name}: This tree now needs Node >= ${need} (${required.source} declares "${required.range}"), but the project declares ${declared.source}. A host honouring that will fail to build.`
        : `${project.name}: This tree now needs Node >= ${need} (${required.source} declares "${required.range}"), but the project declares no engines.node, .nvmrc or .node-version — so a deploy host will pick its own Node and may pick an older one. Add "engines": { "node": ">=${need}" } to package.json.`,
    );
  }

  return { required, declared, unsatisfied };
}
