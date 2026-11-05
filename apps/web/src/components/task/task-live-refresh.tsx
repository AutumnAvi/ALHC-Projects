"use client";

import { useLiveRefresh } from "@/lib/live";
import { taskTopic, type LiveTable } from "@alhc/core/live-patch";

const APPROVAL_TABLES: readonly LiveTable[] = ["approval_requests", "review_checks", "task_attachments"];

// Nov 4 notes, batch 26 (M3): the approver's review page (/approve/<task>) renders again when the round
// changes elsewhere — another approver decides, the assignee withdraws or sends a new round, a file is
// added — through the task's Broadcast topic (only the task's readers can join it).
export function TaskLiveRefresh({ taskId }: { taskId: string }) {
  useLiveRefresh(taskTopic(taskId), APPROVAL_TABLES);
  return null;
}
