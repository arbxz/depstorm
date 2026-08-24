import consola from "consola";

/**
 * Interrupt-safe cleanup for work that is mid-flight.
 *
 * A depstorm run holds real, recoverable state while it works: the user's
 * changes in a stash, the original branch to return to, and backup copies of
 * the manifest and lockfile. All of that is unwound in a `finally` block —
 * which Ctrl+C never reaches. An interrupted run therefore used to leave the
 * repository on a fix branch with a stash outstanding and depstorm's own
 * artifacts on disk, and said nothing about how to get back.
 *
 * Handlers registered here run on SIGINT/SIGTERM before the process exits.
 */

export interface PendingCleanup {
  /** Shown to the user if the cleanup cannot be completed in time */
  describe: () => string;
  run: () => Promise<void>;
}

const pending = new Set<PendingCleanup>();

/** How long every outstanding cleanup gets, in total, before we give up. */
const CLEANUP_BUDGET_MS = 15_000;

/** Exit code for "terminated by SIGINT", by convention 128 + 2. */
const EXIT_INTERRUPTED = 130;

export function registerCleanup(entry: PendingCleanup): PendingCleanup {
  pending.add(entry);
  return entry;
}

export function unregisterCleanup(entry: PendingCleanup): void {
  pending.delete(entry);
}

/** @internal exported for tests */
export function pendingCount(): number {
  return pending.size;
}

/** @internal exported for tests */
export function clearPending(): void {
  pending.clear();
}

/**
 * Run every outstanding cleanup, bounded by a total time budget.
 *
 * Returns whatever could not be finished, so the caller can tell the user
 * exactly what state their repositories were left in.
 */
export async function runPendingCleanups(
  budgetMs = CLEANUP_BUDGET_MS,
): Promise<string[]> {
  const entries = [...pending];
  pending.clear();
  if (entries.length === 0) return [];

  const unfinished = new Set(entries);

  const work = (async () => {
    for (const entry of entries) {
      try {
        await entry.run();
      } catch (err) {
        consola.error(
          `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      unfinished.delete(entry);
    }
  })();

  // Deliberately not unref'd: while this race is being awaited the timer is
  // the only thing keeping the loop alive if a cleanup hangs forever, and
  // letting the loop drain there strands the caller mid-await.
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });

  await Promise.race([work, budget]);
  if (timer) clearTimeout(timer);

  return [...unfinished].map((entry) => entry.describe());
}

let installed = false;

/**
 * Wire SIGINT/SIGTERM to the cleanup registry.
 *
 * A second signal exits immediately: someone pressing Ctrl+C twice wants out
 * now, and holding them hostage to a cleanup they are actively cancelling
 * would be its own kind of rude.
 */
export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;

  let handling = false;

  const onSignal = (signal: NodeJS.Signals) => {
    if (handling) {
      consola.warn("Interrupted again — exiting without finishing cleanup.");
      process.exit(EXIT_INTERRUPTED);
    }
    handling = true;

    void (async () => {
      const outstanding = pendingCount();
      if (outstanding === 0) {
        process.exit(EXIT_INTERRUPTED);
      }

      consola.warn(
        `\n${signal} received — restoring ${outstanding} project(s) before exiting. Press Ctrl+C again to skip.`,
      );

      const unfinished = await runPendingCleanups();

      if (unfinished.length > 0) {
        consola.error(
          `Could not finish restoring ${unfinished.length} project(s):\n${unfinished
            .map((text) => `  - ${text}`)
            .join("\n")}`,
        );
      } else {
        consola.success("Restored. Exiting.");
      }

      process.exit(EXIT_INTERRUPTED);
    })();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}
