"use client";

import { Check, Clock, Send, ThumbsUp } from "lucide-react";
import { completeModeRowLabel, completeModeTooltip, type CompleteMode } from "@/lib/approval-complete";
import type { TaskKind } from "@/lib/task-kinds";

// The completion control for a task row. Milestones get a diamond, approval tasks a thumbs-up (only their
// approvers complete them; everyone else gets ApprovalToggle below — Oct 29 notes, batch 7).
// readOnly (people who can't edit the task — Viewers, Commenters): the same shape as a plain status
// mark, not a button, with no hover and nothing to click (Oct 26 notes).
export function CompleteToggle({
  completed,
  onToggle,
  label,
  size = "md",
  disabled = false,
  readOnly = false,
  kind = "task",
}: {
  completed: boolean;
  onToggle?: () => void;
  label: string;
  size?: "sm" | "md";
  disabled?: boolean;
  readOnly?: boolean;
  kind?: TaskKind;
}) {
  const dimensions = size === "sm" ? "size-4" : "size-[18px]";
  const idle = kind === "approval" ? "border-zinc-300 text-zinc-400" : "border-zinc-300 text-transparent";
  // Asana's completion green: a green check on hover, a filled green circle once done.
  const hover = disabled || readOnly ? "" : kind === "milestone" ? "group-hover/toggle:border-green-600 group-hover/toggle:text-green-600" : "hover:border-green-600 hover:text-green-600";
  const colors = completed ? "border-green-600 bg-green-600 text-white" : `${idle} ${hover}`;
  if (readOnly) {
    const status = `${kind === "milestone" ? "Milestone" : kind === "approval" ? "Approval" : "Task"} ${completed ? "completed" : "not completed"}`;
    return (
      <span
        role="img"
        aria-label={status}
        data-complete-readonly=""
        className={`${dimensions} inline-flex shrink-0 items-center justify-center`}
      >
        {kind === "milestone" ? (
          <span className={`inline-flex size-[72%] rotate-45 items-center justify-center rounded-[2px] border ${colors}`}>
            <Check className="size-[85%] -rotate-45" strokeWidth={3} aria-hidden />
          </span>
        ) : (
          <span className={`inline-flex size-full items-center justify-center rounded-full border ${colors}`}>
            {kind === "approval" ? (
              <ThumbsUp className="size-[62%]" strokeWidth={2.5} aria-hidden />
            ) : (
              <Check className="size-[70%]" strokeWidth={3} aria-hidden />
            )}
          </span>
        )}
      </span>
    );
  }
  if (kind === "milestone") {
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={completed}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        title="Milestone"
        className={`${dimensions} group/toggle inline-flex shrink-0 items-center justify-center disabled:cursor-default`}
      >
        <span className={`inline-flex size-[72%] rotate-45 items-center justify-center rounded-[2px] border transition ${colors}`}>
          <Check className="size-[85%] -rotate-45" strokeWidth={3} />
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={completed}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      title={kind === "approval" ? "Approval" : undefined}
      className={`${dimensions} inline-flex shrink-0 items-center justify-center rounded-full border transition ${colors} disabled:cursor-default`}
    >
      {kind === "approval" ? (
        <ThumbsUp className="size-[62%]" strokeWidth={2.5} />
      ) : (
        <Check className="size-[70%]" strokeWidth={3} />
      )}
    </button>
  );
}

// An approval task's row control for a viewer who can't simply tick it (completeModeOf(), Oct 29 notes,
// batch 7, item 52): "Ready for approval" (opens the task's send flow), "Waiting for approval" (a round is
// pending: nothing to do, still focusable so the tooltip reads), or "Approve" (the viewer's own decision is
// open: opens it in the pane). Same size and place as CompleteToggle.
export function ApprovalToggle({
  mode,
  title,
  size = "md",
  onAction,
}: {
  mode: Exclude<CompleteMode, "complete">;
  title: string;
  size?: "sm" | "md";
  onAction?: () => void;
}) {
  const dimensions = size === "sm" ? "size-4" : "size-[18px]";
  const tone =
    mode === "ready"
      ? "border-dashed border-accent-400 text-accent-600 hover:border-solid hover:bg-accent-50"
      : mode === "approve"
        ? "border-green-600 text-green-700 hover:bg-green-50"
        : "cursor-default border-zinc-300 bg-zinc-50 text-zinc-400";
  const Icon = mode === "ready" ? Send : mode === "approve" ? ThumbsUp : Clock;
  return (
    <button
      type="button"
      aria-disabled={mode === "waiting" ? "true" : undefined}
      aria-label={completeModeRowLabel(mode, title)}
      data-tooltip={completeModeTooltip(mode)}
      data-approval-toggle={mode}
      onClick={(e) => {
        e.stopPropagation();
        if (mode !== "waiting") onAction?.();
      }}
      className={`${dimensions} inline-flex shrink-0 items-center justify-center rounded-full border transition ${tone}`}
    >
      <Icon className="size-[60%]" strokeWidth={2.5} aria-hidden />
    </button>
  );
}

// Row toggle label that names the kind for screen readers.
export function kindToggleLabel(kind: TaskKind, title: string, completed: boolean) {
  const noun = kind === "milestone" ? "milestone " : kind === "approval" ? "approval " : "";
  return completed ? `Mark ${noun}“${title}” incomplete` : `Mark ${noun}“${title}” complete`;
}
