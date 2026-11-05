// Nov 2 notes (batch 15, 111): completions made in this browser, so a task blocked by one of them can be
// completed at once instead of waiting for the server's refresh (and a cached task pane) to catch up.
// Browser-only state; the database still decides (tasks_12_guard_dependencies refuses a completion
// while a blocker is really open). Entries last a minute — long enough for every view to reload.

type Entry = { completed: boolean; at: number };

export const COMPLETION_TTL_MS = 60_000;

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

export function noteCompletion(taskId: string, completed: boolean, now = Date.now()) {
  entries.set(taskId, { completed, at: now });
  changed();
}

// A refused completion takes its note back (only if nothing newer replaced it).
export function forgetCompletion(taskId: string, completed: boolean) {
  const entry = entries.get(taskId);
  if (entry && entry.completed === completed) {
    entries.delete(taskId);
    changed();
  }
}

// true / false: completed / reopened here in the last minute; undefined: nothing known.
export function recentCompletion(taskId: string, now = Date.now()): boolean | undefined {
  const entry = entries.get(taskId);
  if (!entry) return undefined;
  if (now - entry.at > COMPLETION_TTL_MS) {
    entries.delete(taskId);
    return undefined;
  }
  return entry.completed;
}

export function subscribeCompletions(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function completionsVersion() {
  return version;
}

// How many of a task's visible open blockers are still open, given what was completed here. Blockers
// the server counts but the viewer can't see (blockedBy beyond blockerIds) stay counted.
export function openBlockerCount(task: { blockedBy: number; blockerIds?: readonly string[] | null }, now = Date.now()): number {
  const ids = task.blockerIds ?? [];
  const done = ids.filter((id) => recentCompletion(id, now) === true).length;
  return Math.max(0, task.blockedBy - done);
}

// Wraps a completion action: notes it at once, and takes the note back when the server refuses.
export function trackCompletion<R extends { error?: string } | void>(
  taskId: string,
  completed: boolean,
  action: () => Promise<R>,
): () => Promise<R> {
  return async () => {
    noteCompletion(taskId, completed);
    const result = await action();
    if (result && result.error) forgetCompletion(taskId, completed);
    return result;
  };
}

export function resetCompletionsForTests() {
  entries.clear();
  changed();
}
