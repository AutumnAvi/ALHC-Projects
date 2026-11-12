"use client";

import { useEffect, useMemo } from "react";
import { useShellMemberId } from "@/components/shell/shell-context";
import { useTaskEdits } from "@/components/task/task-edits";
import type { MyTask } from "@alhc/core/api/my-tasks/model";
import { requestLiveRefresh, useLiveRefresher, useLiveTopic } from "@/lib/live";
import {
  applyMyTaskPatches,
  mergePatches,
  myTaskLivePatches,
  pruneMyTaskPatches,
  touchesHiddenMyTask,
  userTopic,
  type MyTaskPatch,
} from "@alhc/core/live-patch";
import { getQueryClient } from "@alhc/core/query/browser-client";
import { queryKeys } from "@alhc/core/query/keys";
import { newestOf, writeNewest, type Stamped } from "@alhc/core/query/stamped";
import { editsAsMyTaskPatches } from "@alhc/core/query/task-edits";
import { useCacheEntry } from "@/lib/query/use-cache-entry";

// Nov 4 notes, batch 26 (M3): My tasks and Home's Today follow the person's Broadcast topic. Tasks assigned
// to them that someone else renames, completes, reopens, or re-dates change in place (a completion moves
// the task to the completed list); a task given to someone else or trashed goes; a task newly assigned to
// them asks the server for the page. Patches last until the server's copy agrees.
//
// Nov 4 notes, batch 28 (M4): both live in the client data cache. My tasks and Home read the same bundle
// (my_task_bundle), so the newest copy either screen loaded is what both draw (a revisit drawn from the
// router's cache shows what Home loaded a moment ago, not the older render); the live patches are shared
// too, and the person's own edits from other screens (the pane) apply at once.
type Rows = { open: MyTask[]; completed: MyTask[] };

const ROWS_ENTRY = { queryKey: queryKeys.myTasks() };
const PATCHES_ENTRY = { queryKey: queryKeys.myTaskPatches() };
const NO_PATCHES: ReadonlyMap<string, MyTaskPatch> = new Map();

function setPatches(update: (current: ReadonlyMap<string, MyTaskPatch>) => ReadonlyMap<string, MyTaskPatch>) {
  getQueryClient().setQueryData<ReadonlyMap<string, MyTaskPatch>>(queryKeys.myTaskPatches(), (current) =>
    update(current ?? NO_PATCHES),
  );
}

// `loadedAt`: when the screen's reads started (server clock). Without it the props are drawn as they are.
// `hiddenIds` (batch 39, item 3): this screen holds only some of the person's open tasks (Home's Today
// card); these are the others. Its partial copy never replaces the shared one My tasks draws, and a
// change that may bring a hidden task into view asks the server for the page.
const NO_IDS: readonly string[] = [];

export function useLiveMyTasks(
  open: MyTask[],
  completed: MyTask[],
  loadedAt?: number,
  hiddenIds: readonly string[] = NO_IDS,
): Rows {
  const partial = hiddenIds.length > 0;
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const memberId = useShellMemberId();
  const held = useCacheEntry<Stamped<Rows>>(ROWS_ENTRY);
  const patches = useCacheEntry<ReadonlyMap<string, MyTaskPatch>>(PATCHES_ENTRY) ?? NO_PATCHES;
  const edits = useTaskEdits();

  const base = useMemo<Rows>(() => {
    if (loadedAt === undefined) return { open, completed };
    return newestOf(held, { value: { open, completed }, loadedAt }).value;
  }, [held, open, completed, loadedAt]);

  // Hydrate: this screen's server copy goes into the cache when it's the newest.
  useEffect(() => {
    if (loadedAt !== undefined && !partial) writeNewest<Rows>(getQueryClient(), queryKeys.myTasks(), { open, completed }, loadedAt);
  }, [open, completed, loadedAt, partial]);


  // A new copy: drop the patches it already shows.
  // (A partial copy keeps the patches of tasks it doesn't hold: My tasks draws those.)
  useEffect(() => {
    setPatches((current) => {
      const pruned = pruneMyTaskPatches(base.open, base.completed, current);
      if (pruned.size === current.size) return current;
      if (hidden.size === 0) return pruned;
      const kept = new Map(pruned);
      for (const [id, patch] of current) if (hidden.has(id)) kept.set(id, patch);
      return kept.size === current.size ? current : kept;
    });
  }, [base, hidden]);

  useLiveRefresher();
  useLiveTopic(
    memberId ? userTopic(memberId) : null,
    (message) => {
      if (!memberId) return;
      const known = new Set([...base.open, ...base.completed].map((t) => t.id));
      for (const id of hidden) known.add(id);
      const { patches: incoming, refresh } = myTaskLivePatches(message, memberId, known);
      if (incoming.length > 0) setPatches((current) => mergePatches(current, incoming));
      if (refresh || touchesHiddenMyTask(message, hidden)) requestLiveRefresh("skip");
    },
    (status, rejoined) => {
      if (status === "live" && rejoined) requestLiveRefresh("skip");
    },
  );

  return useMemo(() => {
    const own = edits.length ? editsAsMyTaskPatches(edits, memberId) : null;
    let all = patches;
    if (own && own.size > 0) {
      const merged = new Map(patches);
      for (const [id, patch] of own) merged.set(id, { ...merged.get(id), ...patch });
      all = merged;
    }
    return applyMyTaskPatches(base.open, base.completed, all);
  }, [base, patches, edits, memberId]);
}
