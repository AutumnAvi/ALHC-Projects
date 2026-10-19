// The task pane's client cache rules (Oct 19 notes), kept pure so they're unit-tested: newest copy wins
// (each copy carries the server time its reads started), the least recently used entries go first, a
// write anywhere marks everything stale (shown at once, refetched in the background), and prefetches run
// a few at a time.

export type PaneEntry<T> = {
  value: T;
  // Server clock when the reads behind this copy started.
  loadedAt: number;
  // Client clock when it arrived (for "fresh enough to skip a refetch").
  receivedAt: number;
  // A write happened since: still shown, but refetched on the next open.
  stale: boolean;
};

export class PaneCache<T> {
  private entries = new Map<string, PaneEntry<T>>();

  constructor(private readonly max: number) {}

  get(id: string): PaneEntry<T> | undefined {
    return this.entries.get(id);
  }

  // Keeps the copy only when it's at least as new as the one held. Returns whether it was stored.
  put(id: string, value: T, loadedAt: number, now: number): boolean {
    const current = this.entries.get(id);
    if (current && current.loadedAt > loadedAt) return false;
    this.entries.delete(id);
    this.entries.set(id, { value, loadedAt, receivedAt: now, stale: false });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  // Moves an entry to the most recently used end (opening a task).
  touch(id: string) {
    const current = this.entries.get(id);
    if (!current) return;
    this.entries.delete(id);
    this.entries.set(id, current);
  }

  markAllStale(): string[] {
    const ids: string[] = [];
    for (const [id, entry] of this.entries) {
      if (!entry.stale) {
        this.entries.set(id, { ...entry, stale: true });
        ids.push(id);
      }
    }
    return ids;
  }

  // Fresh = not stale and arrived less than maxAgeMs ago.
  isFresh(id: string, now: number, maxAgeMs: number): boolean {
    const entry = this.entries.get(id);
    return Boolean(entry && !entry.stale && now - entry.receivedAt < maxAgeMs);
  }

  get size() {
    return this.entries.size;
  }
}

// Runs at most `max` tasks at once; the rest wait in order. Returns the task's promise.
export function createLimiter(max: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (running >= max) return;
    const start = queue.shift();
    if (start) start();
  };
  return function limit<R>(task: () => Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      queue.push(() => {
        running += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            next();
          });
      });
      next();
    });
  };
}
