// Nov 12 notes (batch 39, item 1): a change saved without a page refresh (screen-only writes) stays on
// screen until the screen's own copy changes — the task pane's refetch after the write, or a live
// message — instead of disappearing when the save's transition ends (React's useOptimistic falls back to
// the old value then). `base` is the value the screen showed when the change was saved: once the server's
// value is anything else, the server's copy has caught up (with this change, or a newer one) and wins.
export type Held<T> = { value: T; base: T };

export function heldValue<T>(server: T, held: Held<T> | null, same: (a: T, b: T) => boolean = Object.is): T {
  if (!held) return server;
  return same(server, held.base) ? held.value : server;
}

// Two id lists as sets (follower ids keep no order).
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}
