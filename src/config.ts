import { cosmiconfig } from "cosmiconfig";
import { DEFAULT_CONFIG, type WizardConfig } from "./types.js";
import consola from "consola";
import path from "node:path";

const MODULE_NAME = "depstorm";

const explorer = cosmiconfig(MODULE_NAME, {
  searchPlaces: [
    `.${MODULE_NAME}.json`,
    `.${MODULE_NAME}.yaml`,
    `.${MODULE_NAME}.yml`,
    `.${MODULE_NAME}rc`,
    `.${MODULE_NAME}rc.json`,
    `.${MODULE_NAME}rc.yaml`,
    `${MODULE_NAME}.config.js`,
    `${MODULE_NAME}.config.ts`,
    `${MODULE_NAME}.config.mjs`,
  ],
});

export async function loadConfig(configPath?: string): Promise<WizardConfig> {
  try {
    const result = configPath
      ? await explorer.load(configPath)
      : await explorer.search();

    if (result && !result.isEmpty) {
      consola.info(`Loaded config from ${result.filepath}`);
      return mergeConfig(result.config as Partial<WizardConfig>);
    }
  } catch (err) {
    consola.warn(`Failed to load config: ${err}`);
  }

  consola.info("Using default configuration");
  return { ...DEFAULT_CONFIG };
}

function mergeConfig(overrides: Partial<WizardConfig>): WizardConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    excludeDirs: overrides.excludeDirs ?? DEFAULT_CONFIG.excludeDirs,
  };
}

export function resolveRoots(config: WizardConfig, cwd: string): string[] {
  return config.roots.map((root) =>
    path.isAbsolute(root) ? root : path.resolve(cwd, root),
  );
}
