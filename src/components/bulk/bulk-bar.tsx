"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  CalendarDays,
  Check,
  FolderPlus,
  ListChecks,
  MoveRight,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { useNotify } from "@/components/toast";
import { bulkEditTasks } from "@/lib/actions";
import { MAX_BULK_TASKS, bulkVerb, taskCount, type BulkOperation, type BulkResult } from "@/lib/bulk";
import type { Section } from "@/lib/data";
import { OPTION_COLOR_CLASSES, type FieldDef } from "@/lib/fields";
import type { Json } from "@/lib/supabase/database.types";

export type BulkPerson = { id: string; name: string };
export type BulkContext = {
  viewerId: string;
  people: BulkPerson[];
  // Projects the viewer can add tasks to (Editor+), for "Add to project".
  projects: { id: string; name: string }[];
  // List only: sections and fields of the project the list belongs to.
  project?: { id: string; sections: Section[]; fields: FieldDef[] };
};

type Summary = { operation: BulkOperation; total: number; result: BulkResult };

// Runs bulk_update_tasks for the selection (bar buttons and shortcuts). A clean run shows a toast;
// a partial one opens a summary naming every skipped task and why.
export function useBulkEdit() {
  const notify = useNotify();
  const [pending, startTransition] = useTransition();
  const [summary, setSummary] = useState<Summary | null>(null);

  function apply(taskIds: string[], operation: BulkOperation, optimistic?: () => void) {
    if (taskIds.length === 0) return;
    if (taskIds.length > MAX_BULK_TASKS) {
      notify(`Select at most ${MAX_BULK_TASKS} tasks at a time`);
      return;
    }
    startTransition(async () => {
      optimistic?.();
      const response = await bulkEditTasks(taskIds, operation);
      if (response.error) {
        notify(response.error);
        return;
      }
      const result = response.result;
      if (!result) return;
      if (result.skipped.length > 0) setSummary({ operation, total: taskIds.length, result });
      else if (result.updated.length === 0) notify(`No changes: ${taskCount(result.unchanged.length)} already set`);
      else notify(`${bulkVerb(operation.action)} ${taskCount(result.updated.length)}`);
    });
  }

  return { pending, apply, summary, closeSummary: () => setSummary(null) };
}

export type BulkEdit = ReturnType<typeof useBulkEdit>;

const BAR_BUTTON = "btn-ghost h-7 gap-1.5 px-2 text-zinc-200 hover:bg-zinc-700 hover:text-white";

export function BulkBar({
  selected,
  completedCount,
  context,
  bulk,
  onClear,
}: {
  selected: string[];
  completedCount: number;
  context: BulkContext;
  bulk: BulkEdit;
  onClear: () => void;
}) {
  const count = selected.length;
  const run = (operation: BulkOperation) => bulk.apply(selected, operation);
  const project = context.project;
  const fields = project?.fields.filter((f) => !f.boundToSections) ?? [];
  const otherProjects = context.projects.filter((p) => p.id !== project?.id);

  return (
    <>
      {bulk.summary ? <BulkSummary summary={bulk.summary} onClose={bulk.closeSummary} /> : null}
      {count > 0 ? (
        <div
          role="toolbar"
          aria-label={`Bulk actions for ${taskCount(count)}`}
          className="fixed bottom-4 left-1/2 z-20 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-0.5 rounded-xl bg-zinc-900 px-2 py-1.5 text-sm text-white shadow-xl md:ml-30"
          aria-busy={bulk.pending}
        >
          <span className="px-2 font-medium tabular-nums" aria-live="polite">
            {count > MAX_BULK_TASKS ? `${count} selected (max ${MAX_BULK_TASKS})` : `${count} selected`}
          </span>
          <span aria-hidden className="mx-1 h-5 w-px bg-zinc-700" />
          {completedCount < count ? (
            <button type="button" className={BAR_BUTTON} onClick={() => run({ action: "complete" })}>
              <Check className="size-4" aria-hidden />
              Complete
            </button>
          ) : null}
          {completedCount > 0 ? (
            <button type="button" className={BAR_BUTTON} onClick={() => run({ action: "reopen" })}>
              <RotateCcw className="size-4" aria-hidden />
              Reopen
            </button>
          ) : null}

          <Popover
            label="Assign selected tasks"
            side="top"
            buttonClassName={BAR_BUTTON}
            button={
              <>
                <UserRound className="size-4" aria-hidden />
                Assign
              </>
            }
          >
            {(close) => (
              <PersonPicker
                people={context.people}
                viewerId={context.viewerId}
                onPick={(assigneeId) => {
                  close();
                  run({ action: "assign", assignee_id: assigneeId });
                }}
              />
            )}
          </Popover>

          <Popover
            label="Set the due date of selected tasks"
            side="top"
            buttonClassName={BAR_BUTTON}
            panelClassName="w-64"
            button={
              <>
                <CalendarDays className="size-4" aria-hidden />
                Due date
              </>
            }
          >
            {(close) => (
              <DuePicker
                onPick={(dueOn) => {
                  close();
                  run({ action: "set_due", due_on: dueOn });
                }}
              />
            )}
          </Popover>

          {project ? (
            <Popover
              label="Move selected tasks to a section"
              side="top"
            buttonClassName={BAR_BUTTON}
              panelClassName="w-60"
              button={
                <>
                  <MoveRight className="size-4" aria-hidden />
                  Move
                </>
              }
            >
              {(close) => (
                <div className="flex flex-col">
                  <p className="px-2 pb-1 text-xs font-medium text-zinc-500">Move to section</p>
                  {[{ id: null, name: "No section" }, ...project.sections].map((section) => (
                    <MenuItem
                      key={section.id ?? "none"}
                      onClick={() => {
                        close();
                        run({ action: "move_section", project_id: project.id, section_id: section.id });
                      }}
                    >
                      <span className={section.id ? "truncate" : "truncate text-zinc-500"}>{section.name}</span>
                    </MenuItem>
                  ))}
                </div>
              )}
            </Popover>
          ) : null}

          <Popover
            label="Add selected tasks to another project"
            side="top"
            buttonClassName={BAR_BUTTON}
            panelClassName="w-64"
            button={
              <>
                <FolderPlus className="size-4" aria-hidden />
                Add to project
              </>
            }
          >
            {(close) =>
              otherProjects.length === 0 ? (
                <p className="text-xs text-zinc-500">
                  You aren’t an Editor of any other project. Ask a project’s owner or admin to invite you.
                </p>
              ) : (
                <div className="flex flex-col">
                  <p className="px-2 pb-1 text-xs font-medium text-zinc-500">
                    Also show the tasks in (they keep their current projects)
                  </p>
                  {otherProjects.map((p) => (
                    <MenuItem
                      key={p.id}
                      onClick={() => {
                        close();
                        run({ action: "add_to_project", project_id: p.id });
                      }}
                    >
                      <span className="truncate">{p.name}</span>
                    </MenuItem>
                  ))}
                </div>
              )
            }
          </Popover>

          {project ? (
            <Popover
              label="Set a field on selected tasks"
              side="top"
            buttonClassName={BAR_BUTTON}
              button={
                <>
                  <SlidersHorizontal className="size-4" aria-hidden />
                  Field
                </>
              }
            >
              {(close) =>
                fields.length === 0 ? (
                  <p className="text-xs text-zinc-500">
                    This project has no custom fields to set. Add one under the Fields tab. (A Status field that
                    follows the sections is changed with Move.)
                  </p>
                ) : (
                  <FieldPicker
                    fields={fields}
                    people={context.people}
                    onPick={(fieldId, value) => {
                      close();
                      run({ action: "set_field", field_id: fieldId, value });
                    }}
                  />
                )
              }
            </Popover>
          ) : null}

          <button
            type="button"
            className={`${BAR_BUTTON} hover:bg-red-600`}
            onClick={() => {
              if (window.confirm(`Move ${taskCount(count)} to the Trash? Editors can restore them from Settings → Trash.`)) {
                run({ action: "delete" });
              }
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            Delete
          </button>
          <span aria-hidden className="mx-1 h-5 w-px bg-zinc-700" />
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear selection (Esc)"
            title="Clear selection (Esc)"
            className="btn-icon text-zinc-300 hover:bg-zinc-700 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}
    </>
  );
}

function PersonPicker({
  people,
  viewerId,
  onPick,
}: {
  people: BulkPerson[];
  viewerId: string;
  onPick: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = people.filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 50);
  return (
    <div className="flex flex-col gap-1">
      <MenuItem onClick={() => onPick(viewerId)}>
        <UserRound className="size-4 text-zinc-400" aria-hidden />
        Assign to me
      </MenuItem>
      <MenuItem onClick={() => onPick(null)}>
        <X className="size-4 text-zinc-400" aria-hidden />
        Unassign
      </MenuItem>
      <label className="sr-only" htmlFor="bulk-assignee-search">
        Find a person
      </label>
      <input
        id="bulk-assignee-search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a person"
        className="control my-1 w-full"
      />
      <div className="flex max-h-56 flex-col overflow-y-auto">
        {matches.length === 0 ? <p className="px-2 py-1.5 text-xs text-zinc-500">No one matches.</p> : null}
        {matches.map((p) => (
          <MenuItem key={p.id} onClick={() => onPick(p.id)}>
            <span className="truncate">{p.name}</span>
          </MenuItem>
        ))}
      </div>
      <p className="px-2 text-2xs text-zinc-400">People without access to a task are skipped for that task.</p>
    </div>
  );
}

function DuePicker({ onPick }: { onPick: (dueOn: string | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) onPick(value);
      }}
    >
      <label htmlFor="bulk-due" className="text-xs font-medium text-zinc-500">
        Due date
      </label>
      <input
        id="bulk-due"
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="control w-full"
        autoFocus
      />
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={!value}>
          Set due date
        </button>
        <button type="button" className="btn-secondary" onClick={() => onPick(null)}>
          Clear
        </button>
      </div>
    </form>
  );
}

function FieldPicker({
  fields,
  people,
  onPick,
}: {
  fields: FieldDef[];
  people: BulkPerson[];
  onPick: (fieldId: string, value: Json) => void;
}) {
  const [fieldId, setFieldId] = useState(fields[0]?.id ?? "");
  const field = fields.find((f) => f.id === fieldId);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="bulk-field" className="text-xs font-medium text-zinc-500">
        Field
      </label>
      <select id="bulk-field" value={fieldId} onChange={(e) => setFieldId(e.target.value)} className="control w-full">
        {fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {field ? <FieldValueInput key={field.id} field={field} people={people} onPick={(v) => onPick(field.id, v)} /> : null}
    </div>
  );
}

// Sets the same value on every selected task (multi-select and people replace the whole list).
function FieldValueInput({
  field,
  people,
  onPick,
}: {
  field: FieldDef;
  people: BulkPerson[];
  onPick: (value: Json) => void;
}) {
  const [text, setText] = useState("");
  const [many, setMany] = useState<string[]>([]);
  const clear = (
    <button type="button" className="btn-secondary" onClick={() => onPick(null)}>
      Clear value
    </button>
  );

  if (field.fieldType === "single_select") {
    return (
      <div className="flex flex-col gap-1">
        {field.options.length === 0 ? <p className="text-xs text-zinc-500">No options yet — add them under Fields.</p> : null}
        {field.options.map((o) => (
          <MenuItem key={o.id} onClick={() => onPick(o.id)}>
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${OPTION_COLOR_CLASSES[o.color]}`}>{o.name}</span>
          </MenuItem>
        ))}
        <div className="pt-1">{clear}</div>
      </div>
    );
  }

  if (field.fieldType === "boolean") {
    return (
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" onClick={() => onPick(true)}>
          Checked
        </button>
        <button type="button" className="btn-secondary" onClick={() => onPick(false)}>
          Unchecked
        </button>
      </div>
    );
  }

  if (field.fieldType === "multi_select" || field.fieldType === "people") {
    const choices =
      field.fieldType === "people"
        ? people.map((p) => ({ id: p.id, name: p.name, className: "bg-zinc-100 text-zinc-700" }))
        : field.options.map((o) => ({ id: o.id, name: o.name, className: OPTION_COLOR_CLASSES[o.color] }));
    return (
      <div className="flex flex-col gap-2">
        <div role="group" aria-label={field.name} className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
          {choices.map((c) => {
            const on = many.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => setMany(on ? many.filter((x) => x !== c.id) : [...many, c.id])}
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  on ? c.className : "border border-dashed border-zinc-300 text-zinc-500 hover:border-zinc-400"
                }`}
              >
                {c.name}
              </button>
            );
          })}
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-primary" disabled={many.length === 0} onClick={() => onPick(many)}>
            Set
          </button>
          {clear}
        </div>
      </div>
    );
  }

  const type = field.fieldType === "number" ? "number" : field.fieldType === "date" ? "date" : "text";
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const raw = text.trim();
        if (!raw) return;
        if (type === "number") {
          const n = Number(raw);
          if (Number.isFinite(n)) onPick(n);
          return;
        }
        onPick(raw);
      }}
    >
      <label className="sr-only" htmlFor="bulk-field-value">
        {field.name} value
      </label>
      <input
        id="bulk-field-value"
        type={type}
        step={type === "number" ? "any" : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="control w-full"
      />
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={!text.trim()}>
          Set
        </button>
        {clear}
      </div>
    </form>
  );
}

function BulkSummary({ summary, onClose }: { summary: Summary; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { result, operation, total } = summary;
  const done = result.updated.length + result.unchanged.length;
  return (
    <div
      role="alertdialog"
      aria-labelledby="bulk-summary-title"
      aria-describedby="bulk-summary-body"
      className="fixed bottom-20 left-1/2 z-40 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-xl md:ml-30"
    >
      <div className="flex items-start gap-3">
        <ListChecks className="mt-0.5 size-5 shrink-0 text-accent-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="bulk-summary-title" className="font-semibold text-zinc-900">
            {bulkVerb(operation.action)} {done} of {taskCount(total)}
          </h2>
          <div id="bulk-summary-body">
            <p className="mt-0.5 text-zinc-600">
              {result.skipped.length === 1 ? "1 task was skipped:" : `${result.skipped.length} tasks were skipped:`}
            </p>
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {result.skipped.map((s) => (
                <li key={s.taskId} className="rounded-md bg-zinc-50 px-2 py-1.5">
                  <span className="font-medium text-zinc-900">{s.title ?? "A task you can’t see"}</span>
                  <span className="text-zinc-500"> — {s.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <button ref={closeRef} type="button" onClick={onClose} className="btn-secondary shrink-0">
          OK
        </button>
      </div>
    </div>
  );
}
