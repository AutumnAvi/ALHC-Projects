"use client";

import { useState } from "react";
import { useShellMemberId } from "@/components/shell/shell-context";
import type { MyTask } from "@/lib/data";
import { requestLiveRefresh, useLiveRefresher, useLiveTopic } from "@/lib/live";
import {
  applyMyTaskPatches,
  mergePatches,
  myTaskLivePatches,
  pruneMyTaskPatches,
  userTopic,
  type MyTaskPatch,
} from "@/lib/live-patch";

// Nov 4 notes, batch 26 (M3): My tasks and Home's Today follow the person's Broadcast topic. Tasks assigned
// to them that someone else renames, completes, reopens, or re-dates change in place (a completion moves
// the task to the completed list); a task given to someone else or trashed goes; a task newly assigned to
// them asks the server for the page. Patches last until the server's copy agrees.
export function useLiveMyTasks(open: MyTask[], completed: MyTask[]): { open: MyTask[]; completed: MyTask[] } {
  const memberId = useShellMemberId();
  const [patches, setPatches] = useState<Map<string, MyTaskPatch>>(() => new Map());
  const [source, setSource] = useState({ open, completed });
  // A new server copy: drop the patches it already shows.
  if (source.open !== open || source.completed !== completed) {
    setSource({ open, completed });
    const pruned = pruneMyTaskPatches(open, completed, patches);
    if (pruned.size !== patches.size) setPatches(pruned);
  }
  useLiveRefresher();
  useLiveTopic(
    memberId ? userTopic(memberId) : null,
    (message) => {
      if (!memberId) return;
      const known = new Set([...open, ...completed].map((t) => t.id));
      const { patches: incoming, refresh } = myTaskLivePatches(message, memberId, known);
      if (incoming.length > 0) setPatches((current) => mergePatches(current, incoming));
      if (refresh) requestLiveRefresh("skip");
    },
    (status, rejoined) => {
      if (status === "live" && rejoined) requestLiveRefresh("skip");
    },
  );
  return applyMyTaskPatches(open, completed, patches);
}
