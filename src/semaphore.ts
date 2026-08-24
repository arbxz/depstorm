/**
 * A counting semaphore for bounding concurrent work.
 *
 * Used for directory reads during discovery, where an unbounded fan-out over
 * a large tree exhausts file handles, and for running independent projects in
 * parallel.
 */
export class Semaphore {
  private waiters: Array<() => void> = [];

  constructor(private slots: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.slots++;
  }
}

/**
 * Run tasks with at most `limit` in flight, preserving result order.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit <= 1) {
    const results: R[] = [];
    for (const [index, item] of items.entries()) {
      results.push(await fn(item, index));
    }
    return results;
  }

  const semaphore = new Semaphore(limit);
  return Promise.all(
    items.map((item, index) => semaphore.run(() => fn(item, index))),
  );
}
