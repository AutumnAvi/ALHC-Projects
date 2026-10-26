"use client";

import { useState } from "react";
import {
  Check,
  CircleCheck,
  Copy,
  Diamond,
  GitBranch,
  LayoutTemplate,
  MailCheck,
  MailX,
  Link2,
  ListPlus,
  MoreHorizontal,
  Paperclip,
  Printer,
  Repeat,
  Send,
  ShieldCheck,
  ThumbsUp,
  Trash2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { MenuItem, Popover } from "@/components/popover";
import { useNotify, useServerAction } from "@/components/toast";
import { deleteTask, setReplyThreadClosed, setTaskKind } from "@/lib/actions";
import type { TaskDetail } from "@/lib/data";
import { describeRecurrence } from "@/lib/recurrence";
import { TASK_KINDS, TASK_KIND_LABELS, type TaskKind } from "@/lib/task-kinds";
import { DuplicateTaskDialog } from "./duplicate-task-dialog";
import { SendReviewDialog } from "./send-review-dialog";
import { RunRuleDialog } from "./run-rule-dialog";
import { SaveTaskTemplateDialog } from "./save-task-template";
import { ConvertTaskDialog, canConvert } from "./task-convert";
import { OPEN_REPEATS_EVENT } from "./task-dates";
import { displayTaskTitle } from "@/lib/request-numbers";

const KIND_ICONS: Record<TaskKind, LucideIcon> = { task: CircleCheck, milestone: Diamond, approval: ThumbsUp };
const HEADING = "px-2 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-zinc-500";

// Prints only the task: html[data-print-task] makes the print stylesheet hide everything else.
export function printTask() {
  const root = document.documentElement;
  root.dataset.printTask = "";
  const done = () => {
    delete root.dataset.printTask;
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
}

// The pane's "…" (Asana parity, batch 3): what used to crowd the top of the pane — Repeats, the task
// type, approvals — plus convert, save as template, duplicate, run a rule, copy link, print, and delete.
// Viewers and Commenters get the read-only items.
export function TaskMoreMenu({
  task,
  canEdit,
  canAddSubtask,
  onRequestApproval,
  onAddSubtask,
  onAttach,
  onCopyLink,
  onDeleted,
}: {
  task: TaskDetail;
  canEdit: boolean;
  canAddSubtask: boolean;
  onRequestApproval: () => void;
  onAddSubtask: () => void;
  onAttach: () => void;
  onCopyLink: () => void;
  onDeleted: () => void;
}) {
  const [, run] = useServerAction();
  const notify = useNotify();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<"duplicate" | "convert" | "template" | "rule" | "review" | null>(null);
  const home = task.memberships.find((m) => m.isHome) ?? task.memberships[0];
  const editableProjects = task.memberships.filter((m) => task.editableProjectIds.includes(m.projectId));

  async function changeKind(kind: TaskKind) {
    if (kind === task.kind) return;
    if (
      kind === "milestone" &&
      task.startOn &&
      !(await confirm({
        title: "Clear the start date?",
        message: "A milestone has only a due date.",
        confirmLabel: "Clear start date",
        tone: "danger",
      }))
    ) {
      return;
    }
    run(() => setTaskKind(task.id, kind));
  }

  // Close or reopen the request's reply thread, with Undo on the toast.
  function setThreadClosed(closed: boolean) {
    run(async () => {
      const result = await setReplyThreadClosed(task.id, closed);
      if (!result.error) {
        notify(
          closed
            ? "Reply thread closed. The submitter’s replies won’t be posted."
            : "Reply thread reopened. The submitter’s replies come back as comments.",
          { label: "Undo", onClick: () => run(() => setReplyThreadClosed(task.id, !closed)) },
        );
      }
      return result;
    });
  }

  async function remove() {
    const ok = await confirm({
      title: task.isSubtask ? `Delete subtask “${task.title}”?` : `Delete “${task.title}”?`,
      message: task.isSubtask
        ? "It moves to the Trash with its own subtasks, where Editors can restore it."
        : "It moves to the Trash of each of its projects (with its subtasks), where Editors can restore it.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    run(async () => {
      const result = await deleteTask(task.id);
      if (!result.error) onDeleted();
      return result;
    });
  }

  const item = (Icon: LucideIcon, label: string, onClick: () => void, close: () => void) => (
    <MenuItem
      onClick={() => {
        close();
        onClick();
      }}
    >
      <Icon className="size-4 text-zinc-500" aria-hidden /> {label}
    </MenuItem>
  );

  return (
    <>
      <Popover
        label="More actions"
        tooltip="More actions"
        align="end"
        panelClassName="w-64 p-1.5"
        buttonClassName="btn-icon"
        button={<MoreHorizontal className="size-4" aria-hidden />}
      >
        {(close) => (
          <>
            {canEdit ? (
              <>
                {item(
                  Repeat,
                  task.recurrence ? `Repeats: ${describeRecurrence(task.recurrence)}` : "Set to repeat…",
                  () => window.dispatchEvent(new Event(OPEN_REPEATS_EVENT)),
                  close,
                )}
                {item(ShieldCheck, "Request approval…", onRequestApproval, close)}
                {/* Oct 26 notes (batch 3): files out for review by a client (or anyone) by email. */}
                {item(Send, "Send review check…", () => setDialog("review"), close)}
                {canAddSubtask ? item(ListPlus, "Add subtask", onAddSubtask, close) : null}
                {item(Paperclip, "Attach files…", onAttach, close)}
                <div role="separator" className="my-1 border-t border-zinc-100" />
                <p className={HEADING} id="task-type-heading">
                  Task type
                </p>
                <div role="group" aria-labelledby="task-type-heading">
                  {TASK_KINDS.map((kind) => {
                    const Icon = KIND_ICONS[kind];
                    return (
                      <MenuItem
                        key={kind}
                        onClick={() => {
                          close();
                          changeKind(kind);
                        }}
                      >
                        <Icon className="size-4 text-zinc-500" aria-hidden />
                        <span className="flex-1">{TASK_KIND_LABELS[kind]}</span>
                        {kind === task.kind ? <Check className="size-4 text-accent-600" aria-label="Current type" /> : null}
                      </MenuItem>
                    );
                  })}
                </div>
                <div role="separator" className="my-1 border-t border-zinc-100" />
                {canConvert(task) ? item(GitBranch, task.isSubtask ? "Convert to a task…" : "Convert to a subtask…", () => setDialog("convert"), close) : null}
                {home && editableProjects.length ? item(LayoutTemplate, "Save as task template…", () => setDialog("template"), close) : null}
                {item(Copy, task.isSubtask ? "Duplicate subtask…" : "Duplicate task…", () => setDialog("duplicate"), close)}
                {/* "Run manually" rules (Automations V2) run on top-level tasks of their project only. */}
                {!task.isSubtask && task.memberships.length ? item(Workflow, "Run a rule…", () => setDialog("rule"), close) : null}
                {task.replyThread
                  ? task.replyThread.closed
                    ? item(MailCheck, "Reopen reply thread", () => setThreadClosed(false), close)
                    : item(MailX, "Close reply thread", () => setThreadClosed(true), close)
                  : null}
              </>
            ) : null}
            {item(Link2, "Copy task link", onCopyLink, close)}
            {item(Printer, "Print", printTask, close)}
            {canEdit ? (
              <>
                <div role="separator" className="my-1 border-t border-zinc-100" />
                <MenuItem
                  danger
                  onClick={() => {
                    close();
                    remove();
                  }}
                >
                  <Trash2 className="size-4" aria-hidden /> {task.isSubtask ? "Delete subtask" : "Delete task"}
                </MenuItem>
              </>
            ) : null}
          </>
        )}
      </Popover>
      {dialog === "duplicate" ? (
        <DuplicateTaskDialog taskId={task.id} title={task.title} isSubtask={task.isSubtask} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "convert" ? <ConvertTaskDialog task={task} onClose={() => setDialog(null)} /> : null}
      {dialog === "rule" ? <RunRuleDialog taskId={task.id} onClose={() => setDialog(null)} /> : null}
      {dialog === "review" ? <SendReviewDialog task={task} onClose={() => setDialog(null)} /> : null}
      {dialog === "template" && home ? (
        <SaveTaskTemplateDialog
          taskId={task.id}
          title={displayTaskTitle(task.title, task.requestLabel, { show: false })}
          hasAssignee={Boolean(task.assigneeId)}
          projects={editableProjects.map((m) => ({ id: m.projectId, name: m.projectName }))}
          defaultProjectId={editableProjects.find((m) => m.isHome)?.projectId ?? editableProjects[0].projectId}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
