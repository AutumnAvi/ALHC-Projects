// Optimistic comments (Comments and reply by email): a comment shows in the activity feed the moment it's
// sent, as a pending row, and is swapped for the server's row once that arrives — same React key, so the
// row doesn't flicker or move. Failures remove the pending row (the composer gets the text back). Pure:
// no React, no "use client", so the unit tests use it directly; the store is pending-comments-store.ts.

export type PendingEmail = { direction: "sent"; address: string; subject: string };

export type PendingComment = {
  tempId: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
  email: PendingEmail | null;
  // The server's id once the action answered (the refreshed task may arrive before or after that).
  serverId: string | null;
  // Server comment ids the pane had when this was sent: a new row with the same author and text that
  // isn't one of them is this comment, even before serverId is known.
  knownIds: string[];
};

type ServerComment = { id: string; authorId: string | null; body: string };

// Which server comment (if any) a pending comment became. `claimed` holds ids already matched to an
// earlier pending comment, so two identical comments sent in a row each get their own.
export function matchPending<T extends ServerComment>(
  pending: PendingComment,
  server: T[],
  claimed: Set<string>,
): T | null {
  if (pending.serverId) return server.find((c) => c.id === pending.serverId) ?? null;
  const known = new Set(pending.knownIds);
  return (
    server.find(
      (c) => !claimed.has(c.id) && !known.has(c.id) && c.authorId === pending.authorId && c.body === pending.body.trim(),
    ) ?? null
  );
}

export type MergedComments<T> = {
  // Server comments with their React key (a pending comment's tempId once it has arrived).
  keys: Map<string, string>;
  // Pending comments the server doesn't have yet, oldest first: drawn after everything else.
  waiting: PendingComment[];
  // Pending comments the server has now (safe to forget; their key lives on in `keys`).
  arrived: { tempId: string; serverId: string }[];
  server: T[];
};

export function mergePendingComments<T extends ServerComment>(
  server: T[],
  pending: PendingComment[],
  rememberedKeys: ReadonlyMap<string, string> = new Map(),
): MergedComments<T> {
  const keys = new Map(rememberedKeys);
  const claimed = new Set<string>();
  const waiting: PendingComment[] = [];
  const arrived: { tempId: string; serverId: string }[] = [];
  for (const p of [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const match = matchPending(p, server, claimed);
    if (match) {
      claimed.add(match.id);
      keys.set(match.id, p.tempId);
      arrived.push({ tempId: p.tempId, serverId: match.id });
    } else {
      waiting.push(p);
    }
  }
  return { keys, waiting, arrived, server };
}
