"use client";

import { useRealtimeRefresh } from "@/lib/realtime";

// Nov 3 notes (batch 19, video bug 23.5): a project's List / Board / Calendar / Timeline update when
// someone else (or another tab) renames, adds, moves, or completes a task — Realtime on the project's
// tasks (those whose internal pointer is this project, subtasks included) and its task memberships
// (sections, order, tasks added from other projects). Realtime applies each table's read policy, so only
// readers hear anything. The person's own edits are covered by their write's refresh ("skip"), so an edit
// doesn't render the List twice. A database without this batch's migration doesn't publish these tables:
// the channel gives up after a few errors and the page works as before.
export function ProjectLiveUpdates({ projectId }: { projectId: string }) {
  useRealtimeRefresh(
    `project-${projectId}`,
    [
      { table: "tasks", filter: `home_project_id=eq.${projectId}` },
      { table: "task_projects", filter: `project_id=eq.${projectId}` },
    ],
    { duringWrites: "skip", maxErrors: 3 },
  );
  return null;
}
