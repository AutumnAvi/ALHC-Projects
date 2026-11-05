"use client";

import { useEffect, useMemo } from "react";
import type { InboxItem } from "@alhc/core/api/inbox/model";
import { requestLiveRefresh, useLiveRefresher, useLiveTopic } from "@/lib/live";
import { applyInboxPatches, inboxLivePatches, mergePatches, pruneInboxPatches, userTopic, type InboxPatch } from "@alhc/core/live-patch";
import { getQueryClient } from "@alhc/core/query/browser-client";
import { queryKeys } from "@alhc/core/query/keys";
import { useCacheEntry } from "@/lib/query/use-cache-entry";

// Nov 4 notes, batch 26 (M3): the Inbox follows the person's Broadcast topic. Items read, archived, or
// bookmarked elsewhere (another tab, the pane, an email link) change in place; a new notification asks the
// server for the page (its wording, actor, and task come from there).
//
// Nov 4 notes, batch 28 (M4): the patches live in the client data cache, shared by every tab of the Inbox,
// so one heard on Activity still shows on Bookmarks (and on a revisit drawn from the router's cache) until
// the server's copy agrees.
const PATCHES_ENTRY = { queryKey: queryKeys.inboxPatches() };
const NO_PATCHES: ReadonlyMap<string, InboxPatch> = new Map();

const MAX_PATCHES = 500;

function setPatches(update: (current: ReadonlyMap<string, InboxPatch>) => ReadonlyMap<string, InboxPatch>) {
  getQueryClient().setQueryData<ReadonlyMap<string, InboxPatch>>(queryKeys.inboxPatches(), (current) => {
    const next = update(current ?? NO_PATCHES);
    if (next.size <= MAX_PATCHES) return next;
    return new Map([...next].slice(-MAX_PATCHES));
  });
}

export function useLiveInboxItems(items: InboxItem[], memberId: string): InboxItem[] {
  const patches = useCacheEntry<ReadonlyMap<string, InboxPatch>>(PATCHES_ENTRY) ?? NO_PATCHES;
  // A new server copy: drop the patches it already shows (only for the items it has; another tab's stay).
  useEffect(() => {
    setPatches((current) => {
      const shown = new Set(items.map((i) => i.id));
      const pruned = pruneInboxPatches(items, current);
      for (const [id, patch] of current) if (!shown.has(id)) pruned.set(id, patch);
      return pruned.size === current.size ? current : pruned;
    });
  }, [items]);
  useLiveRefresher();
  useLiveTopic(
    userTopic(memberId),
    (message) => {
      const { patches: incoming, refresh } = inboxLivePatches(message, new Set(items.map((i) => i.id)));
      if (incoming.length > 0) setPatches((current) => mergePatches(current, incoming));
      if (refresh) requestLiveRefresh();
    },
    (status, rejoined) => {
      if (status === "live" && rejoined) requestLiveRefresh();
    },
  );
  return useMemo(() => applyInboxPatches(items, patches), [items, patches]);
}
