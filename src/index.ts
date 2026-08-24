#!/usr/bin/env node

import consola from "consola";
import { installSignalHandlers } from "./cleanup.js";
import { cliMode } from "./cli.js";
import { EXIT_OPERATIONAL_FAILURE } from "./exit-code.js";
import { interactiveMode } from "./wizard.js";

// Registered before any work starts so an interrupt during the very first
// project still unwinds the branch, stash and backups it created.
installSignalHandlers();

// Arguments select the flag-driven CLI; bare `depstorm` opens the wizard.
const run = process.argv.length > 2 ? cliMode : interactiveMode;

run().catch((err: unknown) => {
  consola.error(err instanceof Error ? err.message : String(err));
  process.exitCode = EXIT_OPERATIONAL_FAILURE;
});
