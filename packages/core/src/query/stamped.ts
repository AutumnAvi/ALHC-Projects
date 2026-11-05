// Nov 4 notes, batch 28 (M4): entries that keep the newest copy. Each copy carries the server time its reads
// started (`loadedAt`: a screen loader's or the pane route's clock, or the database clock of a live message
// patched into it), so a slower, older answer — or an old server render a revisit replays — never replaces
// a newer one. Screens are hydrated through here: their server render seeds the entry when it's newer, and
// the entry's copy is what they draw.

import type { QueryClient, QueryKey } from "@tanstack/query-core";

export type Stamped<T> = { value: T; loadedAt: number };

export function readStamped<T>(client: QueryClient, key: QueryKey): Stamped<T> | undefined {
  return client.getQueryData<Stamped<T>>(key);
}

// Stores the copy when it's at least as new as the one held. Returns whether it was stored. (setQueryData
// on an older copy would also mark the entry fresh, so the check comes first.)
export function writeNewest<T>(client: QueryClient, key: QueryKey, value: T, loadedAt: number): boolean {
  const current = readStamped<T>(client, key);
  if (current && current.loadedAt > loadedAt) return false;
  if (current && current.loadedAt === loadedAt && current.value === value) return false;
  client.setQueryData<Stamped<T>>(key, { value, loadedAt });
  return true;
}

// The newer of what's held and a server copy that just arrived (a screen's props).
export function newestOf<T>(held: Stamped<T> | undefined, incoming: Stamped<T>): Stamped<T> {
  return held && held.loadedAt > incoming.loadedAt ? held : incoming;
}

// Change the held copy in place (a live message): it then counts as read at `at`, so a fetch that read
// before the change can't put the old values back.
export function patchStamped<T>(
  client: QueryClient,
  key: QueryKey,
  patch: (value: T) => T,
  at: number,
): boolean {
  const current = readStamped<T>(client, key);
  if (!current) return false;
  const value = patch(current.value);
  if (value === current.value) return false;
  client.setQueryData<Stamped<T>>(key, { value, loadedAt: Math.max(current.loadedAt, at) });
  return true;
}
