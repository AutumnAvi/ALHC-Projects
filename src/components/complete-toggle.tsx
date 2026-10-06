"use client";

import { Check, ThumbsUp } from "lucide-react";
import type { TaskKind } from "@/lib/task-kinds";

// The completion control for a task row. Milestones get a diamond, approval tasks a thumbs-up (their
// assignee decides in the pane; the database refuses ticking an open approval task complete).
export function CompleteToggle({
  completed,
  onToggle,
  label,
  size = "md",
  disabled = false,
  kind = "task",
}: {
  completed: boolean;
  onToggle: () => void;
  label: string;
  size?: "sm" | "md";
  disabled?: boolean;
  kind?: TaskKind;
}) {
  const dimensions = size === "sm" ? "size-4" : "size-[18px]";
  const idle = kind === "approval" ? "border-zinc-300 text-zinc-400" : "border-zinc-300 text-transparent";
  const hover = disabled ? "" : kind === "milestone" ? "group-hover/toggle:border-accent-500 group-hover/toggle:text-accent-500" : "hover:border-accent-500 hover:text-accent-500";
  const colors = completed ? "border-accent-600 bg-accent-600 text-white" : `${idle} ${hover}`;
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

// Row toggle label that names the kind for screen readers.
export function kindToggleLabel(kind: TaskKind, title: string, completed: boolean) {
  const noun = kind === "milestone" ? "milestone " : kind === "approval" ? "approval " : "";
  return completed ? `Mark ${noun}“${title}” incomplete` : `Mark ${noun}“${title}” complete`;
}
