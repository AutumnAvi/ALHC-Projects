"use client";

import { useEffect, useRef } from "react";
import { useNotify } from "@/components/toast";
import { rowCompleteMode, shortcutApprovalAction } from "@alhc/core/approval-complete";
import type { TaskSeed } from "@/lib/task-seed";
import type { RowCompleteTask } from "./row-complete-control";
import { useOpenTask } from "./task-link";

// Oct 29 notes, batch 7 (item 52): a row's "Ready for approval" / "Approve" control opens the task's pane
// and starts that step there (the approval banner's send flow, or its decision). The banner may not be
// mounted yet (the pane draws the row's preview while the task loads), so the request waits here for a
// short while and the banner takes it when it mounts; an open banner hears it through the event.

// "setup" (Nov 1 notes, batch 9a): open the guided approval setup of an approval task (Finish setup).
// "convert" (Nov 18 notes, batch 44, item 3): make the task an approval through its setup — the pane opens
// the setup on a plain task (added from a List / Board row as Approval), and the task becomes an approval
// only when the setup is done. A template's approval task opens it too, and leaving the setup early makes
// that task a plain task.
export type ApprovalAction = "send" | "decide" | "setup" | "convert";

const APPROVAL_ACTION_EVENT = "alhc:approval-action";
// A request the pane didn't pick up by then (another task was opened meanwhile) is forgotten.
const FRESH_MS = 20_000;

let pending: { taskId: string; action: ApprovalAction; at: number } | null = null;

export function requestApprovalAction(taskId: string, action: ApprovalAction) {
  pending = { taskId, action, at: Date.now() };
  window.dispatchEvent(new Event(APPROVAL_ACTION_EVENT));
}

function takeApprovalAction(taskId: string, accepts: (action: ApprovalAction) => boolean): ApprovalAction | null {
  if (!pending || pending.taskId !== taskId) return null;
  const { action, at } = pending;
  if (Date.now() - at > FRESH_MS) {
    pending = null;
    return null;
  }
  // A request another listener of this task handles (the pane vs. its approval section) stays waiting.
  if (!accepts(action)) return null;
  pending = null;
  return action;
}

// The approval section (and the pane, for "convert" on a plain task): runs `onAction` for a request about
// its task (now, or whenever one comes) that `accepts` takes.
export function useApprovalActionListener(
  taskId: string,
  onAction: (action: ApprovalAction) => void,
  accepts: (action: ApprovalAction) => boolean = () => true,
) {
  const handler = useRef({ onAction, accepts });
  useEffect(() => {
    handler.current = { onAction, accepts };
  });
  useEffect(() => {
    const check = () => {
      const action = takeApprovalAction(taskId, (a) => handler.current.accepts(a));
      if (action) handler.current.onAction(action);
    };
    check();
    window.addEventListener(APPROVAL_ACTION_EVENT, check);
    return () => window.removeEventListener(APPROVAL_ACTION_EVENT, check);
  }, [taskId]);
}

// Rows (List, Board, My tasks, Home, subtasks) and shortcuts: open the task (if it isn't already) and
// start its approval step in the pane.
export function useApprovalAction() {
  const openTask = useOpenTask();
  return (taskId: string, action: ApprovalAction, seed?: TaskSeed | null) => {
    openTask(taskId, seed ?? undefined);
    requestApprovalAction(taskId, action);
  };
}

// ⌘/Ctrl+Enter on one row: an approval task the viewer doesn't approve opens its approval step (or says
// it's waiting) instead of completing. Returns true when it handled the task; several selected tasks go
// through bulk Complete, whose summary names the ones only their approvers can complete.
export function useApprovalShortcut() {
  const approvalAction = useApprovalAction();
  const notify = useNotify();
  return (task: RowCompleteTask, seed?: TaskSeed | null): boolean => {
    const action = shortcutApprovalAction(rowCompleteMode(task));
    if (!action) return false;
    if (action === "waiting") notify(`“${task.title}” is waiting for approval`);
    else if (action === "approved") notify(`“${task.title}” was approved. Only its approvers can complete it.`);
    else approvalAction(task.id, action, seed);
    return true;
  };
}
