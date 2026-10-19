"use client";

import { Check, UserRound } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Skeleton } from "@/components/ui";
import { dayLabel } from "@/lib/date-input";
import { OPTION_COLOR_CLASSES } from "@/lib/fields";
import { formatRequestLabel } from "@/lib/request-numbers";
import { tagClass } from "@/lib/tags";
import type { TaskSeed } from "@/lib/task-seed";
import { PANE_FIELDS, PANE_LABEL } from "./pane-styles";
import { CloseButton, ExpandButton, PANE_HEADER, PaneShell } from "./task-pane-frame";

// The pane the moment a task is clicked (Oct 19 notes: opening a task must feel instant): the same
// frame and field grid as the full pane, filled from what the clicked row already showed — name, request
// number, completion, assignee, dates, project and section, tags, pinned fields — read-only, with
// placeholders for the description, subtasks, and comments until the full detail arrives (usually
// already cached from hovering the row). Nothing here can be edited, so no draft is ever lost.
export function TaskPanePreview({ seed }: { seed: TaskSeed }) {
  const year = new Date().getFullYear();
  const label = formatRequestLabel(seed.requestLabel);
  const dates =
    seed.startOn && seed.dueOn
      ? `${dayLabel(seed.startOn, year)} – ${dayLabel(seed.dueOn, year)}`
      : seed.dueOn
        ? dayLabel(seed.dueOn, year)
        : null;

  return (
    <PaneShell label={`Task: ${seed.title}`} paneState="preview" taskId={seed.id}>
      <div className={PANE_HEADER}>
        <span
          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium opacity-60 ${
            seed.completed ? "border-green-600 bg-green-600 text-white" : "border-zinc-300 bg-white text-zinc-700"
          }`}
        >
          <Check className="size-4" strokeWidth={2.5} aria-hidden />
          {seed.completed ? "Completed" : seed.kind === "milestone" ? "Mark milestone complete" : "Mark complete"}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <ExpandButton />
          <CloseButton />
        </div>
      </div>
      <div role="status" className="min-h-0 flex-1 overflow-y-auto px-gutter py-4">
        <span className="sr-only">Loading the rest of the task…</span>
        {seed.parentTitle ? <p className="mb-1 truncate text-xs text-zinc-500">{seed.parentTitle}</p> : null}
        {label ? <p className="mb-1 text-sm font-medium text-zinc-500">{label}</p> : null}
        <p
          className={`-mx-2 rounded-md border border-transparent px-2 py-1 text-2xl font-semibold leading-tight tracking-tight ${
            seed.completed ? "text-zinc-500" : "text-zinc-900"
          }`}
        >
          {seed.title}
        </p>

        <dl className={`mt-3 ${PANE_FIELDS}`}>
          <dt className={PANE_LABEL}>{seed.kind === "approval" ? "Approver" : "Assignee"}</dt>
          <dd className="flex min-h-8 min-w-0 items-center gap-2 px-1">
            {seed.assignee ? (
              <>
                <Avatar name={seed.assignee.name} />
                <span className="truncate text-zinc-800">{seed.assignee.name}</span>
              </>
            ) : seed.assignee === null ? (
              <>
                <span className="inline-flex size-6 items-center justify-center rounded-full border border-dashed border-zinc-300 text-zinc-400">
                  <UserRound className="size-3.5" aria-hidden />
                </span>
                <span className="text-zinc-500">No assignee</span>
              </>
            ) : (
              <Skeleton className="h-3 w-24" />
            )}
          </dd>

          <dt className={PANE_LABEL}>Due date</dt>
          <dd className="flex min-h-8 min-w-0 items-center px-1">
            {dates ? <span className="text-zinc-800">{dates}</span> : seed.dueOn === null ? <span className="text-zinc-500">No due date</span> : <Skeleton className="h-3 w-20" />}
          </dd>

          <dt className={PANE_LABEL}>Projects</dt>
          <dd className="flex min-h-8 min-w-0 items-center gap-1.5 px-1">
            {seed.projectName ? (
              <>
                <span className="truncate text-zinc-800">{seed.projectName}</span>
                {seed.sectionName ? <span className="truncate text-zinc-500">· {seed.sectionName}</span> : null}
              </>
            ) : (
              <Skeleton className="h-3 w-32" />
            )}
          </dd>

          {seed.tags && seed.tags.length ? (
            <>
              <dt className={PANE_LABEL}>Tags</dt>
              <dd className="flex min-h-8 min-w-0 flex-wrap items-center gap-1 px-1">
                {seed.tags.map((tag) => (
                  <span key={tag.id} className={`inline-flex h-5 max-w-40 items-center rounded px-1.5 text-2xs font-medium ${tagClass(tag.color)}`}>
                    <span className="truncate">{tag.name}</span>
                  </span>
                ))}
              </dd>
            </>
          ) : null}

          {(seed.fields ?? []).map((field) => (
            <div key={field.id} className="contents">
              <dt className={PANE_LABEL}>{field.name}</dt>
              <dd className="flex min-h-8 min-w-0 items-center px-1">
                {field.color ? (
                  <span className={`inline-block max-w-full truncate rounded-full px-2 py-px text-xs font-medium ${OPTION_COLOR_CLASSES[field.color]}`}>
                    {field.value}
                  </span>
                ) : (
                  <span className="truncate text-zinc-800">{field.value}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>

        <Skeleton className="mt-6 h-3.5 w-24" />
        <Skeleton className="mt-2 h-16 w-full rounded-md" />
        {seed.subtaskCount ? (
          <p className="mt-6 text-sm font-semibold text-zinc-900">
            Subtasks <span className="font-normal text-zinc-500">{seed.subtaskDoneCount ?? 0}/{seed.subtaskCount}</span>
          </p>
        ) : null}
        <p className="mt-6 text-sm font-semibold text-zinc-900">
          Comments{seed.commentCount ? <span className="font-normal text-zinc-500"> {seed.commentCount}</span> : null}
        </p>
        <Skeleton className="mt-2 h-10 w-full rounded-md" />
      </div>
    </PaneShell>
  );
}
