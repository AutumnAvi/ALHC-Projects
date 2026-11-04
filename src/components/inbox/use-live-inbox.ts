"use client";

import { useState } from "react";
import type { InboxItem } from "@/lib/data";
import { requestLiveRefresh, useLiveRefresher, useLiveTopic } from "@/lib/live";
import { applyInboxPatches, inboxLivePatches, mergePatches, pruneInboxPatches, userTopic, type InboxPatch } from "@/lib/live-patch";

// Nov 4 notes, batch 26 (M3): the Inbox follows the person's Broadcast topic. Items read, archived, or
// bookmarked elsewhere (another tab, the pane, an email link) change in place; a new notification asks the
// server for the page (its wording, actor, and task come from there).
export function useLiveInboxItems(items: InboxItem[], memberId: string): InboxItem[] {
  const [patches, setPatches] = useState<Map<string, InboxPatch>>(() => new Map());
  const [source, setSource] = useState(items);
  if (source !== items) {
    setSource(items);
    const pruned = pruneInboxPatches(items, patches);
    if (pruned.size !== patches.size) setPatches(pruned);
  }
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
  return applyInboxPatches(items, patches);
}
