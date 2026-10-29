"use client";

import { ApprovalToggle, CompleteToggle, kindToggleLabel } from "@/components/complete-toggle";
import { rowCompleteMode } from "@/lib/approval-complete";
import type { ApprovalTaskStatus, TaskKind } from "@/lib/task-kinds";
import type { TaskSeed } from "@/lib/task-seed";
import { useApprovalAction } from "./approval-action";
import { BlockedToggle } from "./blockers-popover";

export type RowCompleteTask = {
  id: string;
  title: string;
  kind: TaskKind;
  completedAt: string | null;
  approvalStatus?: ApprovalTaskStatus | null;
  approvalIsApprover?: boolean;
  approvalWaitingOnMe?: boolean;
};

// The completion control of a List / Board / My tasks / Home / subtask row (Oct 29 notes, batch 7,
// item 52). An approval task the viewer doesn't approve gets "Ready for approval" (opens the pane's send
// flow), "Waiting for approval" while a round is pending, or "Approve" when their own decision is open;
// otherwise a blocked task's lock (item 43) or the ordinary checkbox.
//   readOnly      the viewer can't edit the task (Viewer / Commenter): a status mark — except Approve (the
//                 data only says a round waits on the viewer when they can decide it, Commenter+:
//                 task_approval_state / project_task_cards), and Ready for approval when assignedToMe
//   assignedToMe  the task is assigned to the viewer AND they can comment on it (Commenter+): the assignee
//                 sends it (approval_can_act). Pass false for a Viewer assignee, who gets the mark
//   blocked       open blockers (0 = none)
export function RowCompleteControl({
  task,
  completed,
  readOnly = false,
  assignedToMe = false,
  blocked = 0,
  size = "md",
  seed,
  onToggle,
}: {
  task: RowCompleteTask;
  completed: boolean;
  readOnly?: boolean;
  assignedToMe?: boolean;
  blocked?: number;
  size?: "sm" | "md";
  seed?: () => TaskSeed | null | undefined;
  onToggle: () => void;
}) {
  const approvalAction = useApprovalAction();
  const mode = rowCompleteMode(task, completed);
  const approvalControl =
    mode === "approve" || (mode === "ready" && (!readOnly || assignedToMe)) || (mode === "waiting" && !readOnly);
  if (mode !== "complete" && approvalControl) {
    return (
      <ApprovalToggle
        mode={mode}
        title={task.title}
        size={size}
        onAction={() => approvalAction(task.id, mode === "approve" ? "decide" : "send", seed?.())}
      />
    );
  }
  if (blocked > 0 && !completed) {
    return <BlockedToggle taskId={task.id} title={task.title} count={blocked} size={size} />;
  }
  return (
    <CompleteToggle
      size={size}
      kind={task.kind}
      completed={completed}
      readOnly={readOnly || mode !== "complete"}
      onToggle={onToggle}
      label={kindToggleLabel(task.kind, task.title, completed)}
    />
  );
}
