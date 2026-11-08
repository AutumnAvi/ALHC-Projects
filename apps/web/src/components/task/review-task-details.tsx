"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { reviewDetailFields, reviewDetailProjectLabel, type ReviewDetailField, type ReviewTaskDetails } from "@alhc/core/approver-review";
import { OPTION_COLOR_CLASSES } from "@alhc/core/fields";
import { TEXT_TOOLTIP_LENGTH, textPreview } from "@alhc/core/long-text";
import { titleAssetsFor } from "@alhc/core/title-assets";
import { Avatar } from "@/components/avatar";
import { isChoiceField, PILL } from "@/components/project/field-chips";
import { MentionText } from "@/components/task/comment-parts";
import { TaskTitleText, usePeopleDirectory } from "@/components/task/title-text";
import { formatDueDate, isOverdue, useToday } from "@/lib/dates";

// Nov 8 note 167: a read-only strip on the approval review page, above the files. The same facts the
// task pane shows — name (with its chips), project, assignee, due date, the fields that have a value,
// and the description drawn the way the pane draws it — and nothing else. Comments are not a prop.
// Open by default so the description is there; collapsing it leaves one line so the files stay the page.
export function ReviewTaskDetails({ details }: { details: ReviewTaskDetails }) {
  const directory = usePeopleDirectory();
  const nameOf = (id: string) => directory.find((p) => p.id === id)?.name ?? null;
  const assignee = details.assigneeId ? nameOf(details.assigneeId) : null;
  const { shown, hidden } = reviewDetailFields(details, nameOf);
  const assets = useMemo(
    () => titleAssetsFor(details.notes, details.files),
    [details.notes, details.files],
  );
  const today = useToday();
  const year = today ? Number(today.slice(0, 4)) : new Date().getFullYear();
  const due = details.dueOn ? formatDueDate(details.dueOn, year) : "No due date";
  const overdue = isOverdue(details.dueOn, today, details.completed);
  const project = reviewDetailProjectLabel(details.projects.map((p) => p.name));
  const assigneeLabel = details.assigneeId ? (assignee ?? "Assigned") : "No assignee";

  return (
    <details open className="group/details rounded-lg border border-zinc-200 bg-white" data-review-details="">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-left [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-zinc-400 transition-transform group-open/details:rotate-90" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="text-xs font-medium text-zinc-500">Task details</span>
          <span className="mt-0.5 block truncate text-sm text-zinc-700 group-open/details:hidden">
            {details.title}
            <span className="text-zinc-400"> · </span>
            {project}
            <span className="text-zinc-400"> · </span>
            {assigneeLabel}
            <span className="text-zinc-400"> · </span>
            <span className={overdue ? "text-red-600" : undefined}>{due}</span>
          </span>
        </span>
        <span className="shrink-0 text-xs text-zinc-500 group-open/details:hidden">Show details</span>
        <span className="hidden shrink-0 text-xs text-zinc-500 group-open/details:inline">Hide details</span>
      </summary>
      <div className="space-y-3 border-t border-zinc-100 px-4 py-3">
        <h2 className="text-base font-semibold leading-snug text-zinc-900">
          <TaskTitleText title={details.title} assets={assets} />
        </h2>
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-zinc-500">Project</dt>
          <dd className="min-w-0" data-review-project="">
            {details.projects.length === 0 ? (
              <span className="text-zinc-800">Private</span>
            ) : (
              <span className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
                {details.projects.map((p) => (
                  <Link key={p.id} href={`/projects/${p.id}`} className="truncate text-zinc-800 hover:underline">
                    {p.name}
                  </Link>
                ))}
              </span>
            )}
          </dd>
          <dt className="text-zinc-500">Assignee</dt>
          <dd className="flex min-w-0 items-center gap-1.5 text-zinc-800" data-review-assignee="">
            {assignee ? <Avatar name={assignee} profileId={details.assigneeId} size="sm" /> : null}
            <span className="truncate">{assigneeLabel}</span>
          </dd>
          <dt className="text-zinc-500">Due date</dt>
          <dd className={overdue ? "text-red-600" : "text-zinc-800"} data-review-due="">
            {due}
            {overdue ? <span className="sr-only">, overdue</span> : null}
          </dd>
          {shown.map((field) => (
            <FieldLine key={field.id} field={field} year={year} />
          ))}
        </dl>
        {hidden > 0 ? (
          <p className="text-xs text-zinc-500" data-review-fields-more="">
            {hidden} more {hidden === 1 ? "field" : "fields"} on the task
          </p>
        ) : null}
        <div>
          <h3 className="text-xs font-medium text-zinc-500">Description</h3>
          {details.notes ? (
            <div
              className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-zinc-800"
              data-review-description=""
            >
              <MentionText body={details.notes} people={[]} refs={details.refs} />
            </div>
          ) : (
            <p className="mt-1 text-sm text-zinc-500" data-review-description="">
              No description.
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

function FieldLine({ field, year }: { field: ReviewDetailField; year: number }) {
  return (
    <>
      <dt className="truncate text-zinc-500" title={field.name}>
        {field.name}
      </dt>
      <dd className="min-w-0">
        <FieldValue field={field} year={year} />
      </dd>
    </>
  );
}

function FieldValue({ field, year }: { field: ReviewDetailField; year: number }) {
  if (isChoiceField(field)) {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1" data-review-field={field.name}>
        {field.chips.map((chip, i) => (
          <span key={`${chip.label}-${i}`} className={`${PILL} ${OPTION_COLOR_CLASSES[chip.color]}`}>
            {chip.label}
          </span>
        ))}
      </span>
    );
  }
  const text = field.chips
    .map((chip) => (field.fieldType === "date" && /^\d{4}-\d{2}-\d{2}$/.test(chip.label) ? formatDueDate(chip.label, year) : chip.label))
    .join(", ");
  const line = text.replace(/\s+/g, " ").trim();
  return (
    <span
      className="block truncate text-zinc-800"
      data-review-field={field.name}
      data-tooltip={line.length > 80 ? textPreview(line, TEXT_TOOLTIP_LENGTH) : undefined}
      data-tooltip-truncated={line.length > 80 ? "" : undefined}
    >
      {textPreview(line, 80)}
    </span>
  );
}
