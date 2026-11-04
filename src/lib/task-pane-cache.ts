// The task pane's prefetch limiter (Oct 19 notes). The pane's cache itself is an entry of the client data
// cache since Nov 4 notes, batch 28 (src/lib/query/task-pane.ts).

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
