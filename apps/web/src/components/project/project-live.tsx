"use client";

import { applyLiveTaskChanges, shownProjectTasks } from "@/components/project/use-project-tasks";
import { requestLiveRefresh, useLiveRefresher, useLiveTopic } from "@/lib/live";
import { projectLiveChanges, projectTopic } from "@alhc/core/live-patch";

// Nov 4 notes, batch 26 (M3): a project's List / Board / Calendar / Timeline follow other people's changes
// through the project's Broadcast topic (only the project's readers can join it). Renames, completions,
// dates, assignees, section moves, field values, tags, trashed and removed tasks are patched in place
// (use-project-tasks' overlay: since Nov 4 notes, batch 28, the project's entry in the client data
// cache, so it outlives a switch between the project's views); only a task the view doesn't show yet (added, restored, newly matching the
// view) or a subtask's count asks the server for the page again. The person's own edits are covered by
// their write's refresh ("skip"). After a lost connection the page refreshes once (changes may have been
// missed meanwhile).
export function ProjectLiveUpdates({ projectId }: { projectId: string }) {
  useLiveRefresher();
  useLiveTopic(
    projectTopic(projectId),
    (message) => {
      const { changes, refresh } = projectLiveChanges(message, projectId, shownProjectTasks(projectId));
      applyLiveTaskChanges(projectId, changes);
      if (refresh) requestLiveRefresh("skip");
    },
    (status, rejoined) => {
      if (status === "live" && rejoined) requestLiveRefresh("skip");
    },
  );
  return null;
}
