"use client";

import { useEffect, useMemo, useOptimistic, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import { displayName } from "@/components/avatar";
import { MenuItem, Popover } from "@/components/popover";
import { PILL } from "@/components/project/field-chips";
import { Assignee, EmptyCellHint } from "@/components/project/task-meta";
import { DateRangePicker, SingleDatePicker } from "@/components/task/date-picker";
import { PeopleList, PersonPicker } from "@/components/task/person-picker";
import { useNotify } from "@/components/toast";
import { loadSubtaskRows, setTaskRowExpanded, type ActionResult } from "@/lib/actions";
import type { Profile, SubtaskItem } from "@/lib/data";
import { dayLabel } from "@/lib/date-input";
import { LongTextEditor } from "@/components/long-text-editor";
import { NumberInput } from "@/components/number-input";
import {
  OPTION_COLOR_CLASSES,
  formatNumberValue,
  notANumberNote,
  numberPrefixOf,
  readNumberBox,
  type FieldDef,
  type FieldOption,
} from "@/lib/fields";
import { textValueLabel } from "@/lib/long-text";
import { MAX_SUBTASK_DEPTH, subtasksByParent } from "@/lib/subtasks";
import type { Json } from "@/lib/supabase/database.types";

// Oct 27 notes (batch 6): List and My tasks rows edit in place (item 46), open their subtasks under them
// (item 41), and lock the completion control of a blocked task (item 43). This file holds the shared
// pieces: the inline cells (assignee, dates, every custom field type, a choice such as the section), the
// expand arrow, the subtask-tree store behind expanded rows, and the pure rules both views use.

// ---------------------------------------------------------------------------------------------
// Blocked tasks (item 43)
// ---------------------------------------------------------------------------------------------

export type Blockable = { id: string; title: string; completedAt: string | null; blockedBy?: number | null };

// Open blockers that hold up completing the task (0 once it's done, or when the row doesn't know).
export function blockedCount(task: Pick<Blockable, "completedAt" | "blockedBy">): number {
  return !task.completedAt && typeof task.blockedBy === "number" && task.blockedBy > 0 ? task.blockedBy : 0;
}

// ⌘/Ctrl+Enter on rows: blocked tasks are left out (they can't be completed) instead of failing.
export function splitBlocked<T extends Blockable>(tasks: T[]): { allowed: T[]; blocked: T[] } {
  const allowed: T[] = [];
  const blocked: T[] = [];
  for (const task of tasks) (blockedCount(task) > 0 ? blocked : allowed).push(task);
  return { allowed, blocked };
}

// The toast for the blocked tasks a shortcut skipped: “Spring flyer” is blocked by 2 tasks.
export function blockedSkipMessage(blocked: Blockable[]): string | null {
  if (blocked.length === 0) return null;
  const first = blocked[0];
  const count = blockedCount(first);
  const line = `“${first.title}” is blocked by ${count} ${count === 1 ? "task" : "tasks"}`;
  const more = blocked.length - 1;
  return more > 0 ? `${line}; ${more} more blocked ${more === 1 ? "task was" : "tasks were"} left open` : line;
}

// ---------------------------------------------------------------------------------------------
// Expanded rows and their subtask trees (item 41)
// ---------------------------------------------------------------------------------------------

// What a row edit changes on a subtask (or a My tasks row) before the server answers.
export type RowPatch = Partial<Pick<SubtaskItem, "title" | "completedAt" | "assigneeId" | "startOn" | "dueOn">>;

// The top-level task each loaded subtask hangs under (the trees are loaded per top-level task).
export function subtaskRootIds(items: Pick<SubtaskItem, "id" | "parentId">[]): Set<string> {
  const parentOf = new Map(items.map((item) => [item.id, item.parentId] as const));
  const roots = new Set<string>();
  for (const item of items) roots.add(rootOf(item.parentId, parentOf));
  return roots;
}

function rootOf(id: string, parentOf: Map<string, string>) {
  let current = id;
  // Subtasks nest at most MAX_SUBTASK_DEPTH levels; the bound also guards against a bad cycle.
  for (let i = 0; i <= MAX_SUBTASK_DEPTH + 1 && parentOf.has(current); i++) current = parentOf.get(current)!;
  return current;
}

// The loaded subtasks of each requested root (an empty list when it has none).
export function groupSubtasksByRoot(items: SubtaskItem[], roots: string[]): Map<string, SubtaskItem[]> {
  const parentOf = new Map(items.map((item) => [item.id, item.parentId] as const));
  const out = new Map<string, SubtaskItem[]>(roots.map((root) => [root, []]));
  for (const item of items) out.get(rootOf(item.parentId, parentOf))?.push(item);
  return out;
}

// The server's trees, then the ones loaded in the browser for rows the server didn't load (the server's
// copy of a tree wins: it is the newer one after a refresh).
export function mergeSubtaskTrees(
  server: SubtaskItem[],
  client: Record<string, { items: SubtaskItem[] }>,
  serverRoots: ReadonlySet<string>,
): SubtaskItem[] {
  const seen = new Set(server.map((item) => item.id));
  const out = [...server];
  for (const [root, tree] of Object.entries(client)) {
    if (serverRoots.has(root)) continue;
    for (const item of tree.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

export function applyRowPatches<T extends { id: string }>(items: T[], patches: Record<string, RowPatch>): T[] {
  if (Object.keys(patches).length === 0) return items;
  return items.map((item) => (patches[item.id] ? { ...item, ...patches[item.id] } : item));
}

// Whether a row is open: with the view's "Show subtasks" on every row is (unless closed for this
// visit), else the rows this person opened (kept per person).
export function rowExpanded(
  id: string,
  state: { showAll: boolean; expanded: ReadonlySet<string>; collapsed: ReadonlySet<string> },
): boolean {
  return state.showAll ? !state.collapsed.has(id) : state.expanded.has(id);
}

export type FlatSubtaskRow = {
  item: SubtaskItem;
  // 1 = a direct subtask of the row's task.
  depth: number;
  parentTitle: string;
  hasChildren: boolean;
  expanded: boolean;
};

// The subtask rows under an open row, in order: each subtask, then (when it is open too) its own subtasks
// one level deeper, down to the nesting limit.
export function flattenSubtaskRows(
  parentId: string,
  parentTitle: string,
  childrenOf: Map<string, SubtaskItem[]>,
  isExpanded: (id: string) => boolean,
  depth = 1,
): FlatSubtaskRow[] {
  const rows: FlatSubtaskRow[] = [];
  for (const item of childrenOf.get(parentId) ?? []) {
    const hasChildren = (childrenOf.get(item.id)?.length ?? 0) > 0 || item.subtaskCount > 0;
    const expanded = hasChildren && depth < MAX_SUBTASK_DEPTH && isExpanded(item.id);
    rows.push({ item, depth, parentTitle, hasChildren: hasChildren && depth < MAX_SUBTASK_DEPTH, expanded });
    if (expanded) rows.push(...flattenSubtaskRows(item.id, item.title, childrenOf, isExpanded, depth + 1));
  }
  return rows;
}

// Trees to fetch: open rows whose tree neither the server sent nor the browser loaded since the last
// server render (a refresh may have changed them).
export function rootsToLoad({
  rows,
  isExpanded,
  serverRoots,
  client,
  version,
}: {
  rows: { id: string; rootId: string }[];
  isExpanded: (id: string) => boolean;
  serverRoots: ReadonlySet<string>;
  client: Record<string, { version: number }>;
  version: number;
}): string[] {
  const want = new Set<string>();
  for (const row of rows) {
    if (!isExpanded(row.id) || serverRoots.has(row.rootId)) continue;
    if ((client[row.rootId]?.version ?? -1) < version) want.add(row.rootId);
  }
  return [...want].sort();
}

// The new dates of a row edit, or null when nothing changes. A milestone has no start date, and a start
// after the due date takes the due date with it (as the pane's picker does).
export function mergeDateEdit(
  current: { startOn: string | null; dueOn: string | null },
  edit: DateEdit,
  milestone = false,
): { startOn: string | null; dueOn: string | null } | null {
  const startOn = milestone ? null : edit.startOn === undefined ? current.startOn : edit.startOn;
  let dueOn = edit.dueOn === undefined ? current.dueOn : edit.dueOn;
  if (startOn && dueOn && startOn > dueOn) dueOn = startOn;
  if (startOn === current.startOn && dueOn === current.dueOn) return null;
  return { startOn, dueOn };
}

type ClientTree = { items: SubtaskItem[]; version: number };
const NO_SUBTASKS: SubtaskItem[] = [];
const NO_IDS: string[] = [];

function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function withoutIds(patches: Record<string, RowPatch>, ids: Iterable<string>): Record<string, RowPatch> {
  let next: Record<string, RowPatch> | null = null;
  for (const id of ids) {
    if (!(id in patches)) continue;
    next ??= { ...patches };
    delete next[id];
  }
  return next ?? patches;
}

const mergePatch = (current: Record<string, RowPatch>, change: { id: string; patch: RowPatch }) => ({
  ...current,
  [change.id]: { ...current[change.id], ...change.patch },
});

// The subtasks under List / My tasks rows: which rows are open (kept per person through
// setTaskRowExpanded, no refresh), the trees the server rendered plus the ones loaded here when a row
// opens (loadSubtaskRows), and the row edits made to them (shown at once; kept until fresh data arrives).
export function useSubtaskTrees({
  initialExpanded = NO_IDS,
  serverSubtasks,
  projectId = null,
  rows,
  showAll = false,
}: {
  initialExpanded?: string[];
  // The trees the server loaded (every listed row's with Show subtasks, else the open rows').
  serverSubtasks: SubtaskItem[] | null | undefined;
  // Subtask numbers as this project numbers them.
  projectId?: string | null;
  // Rows on screen that have subtasks, with the top-level task their tree is loaded by.
  rows: { id: string; rootId: string }[];
  showAll?: boolean;
}) {
  const notify = useNotify();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initialExpanded));
  // With Show subtasks on: rows closed for this visit (not saved; the view's setting opens them).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [client, setClient] = useState<Record<string, ClientTree>>({});
  const [kept, setKept] = useState<Record<string, RowPatch>>({});
  const [patches, addPatch] = useOptimistic(kept, mergePatch);
  const server = serverSubtasks ?? NO_SUBTASKS;
  // A new server render: its trees replace earlier edits of those subtasks, and trees loaded here before
  // it are fetched again (they may have changed).
  const [seen, setSeen] = useState({ server, version: 0 });
  if (seen.server !== server) {
    setSeen({ server, version: seen.version + 1 });
    setKept((current) => withoutIds(current, server.map((item) => item.id)));
  }
  const version = seen.version;

  const serverRoots = useMemo(() => subtaskRootIds(server), [server]);
  const childrenOf = useMemo(
    () => subtasksByParent(applyRowPatches(mergeSubtaskTrees(server, client, serverRoots), patches)),
    [server, client, serverRoots, patches],
  );
  const isExpanded = (id: string) => rowExpanded(id, { showAll, expanded, collapsed });
  const missingKey = rootsToLoad({ rows, isExpanded, serverRoots, client, version }).join(",");

  // Open rows whose tree isn't here yet: one read for all of them.
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    const roots = missingKey ? missingKey.split(",").filter((root) => !inFlight.current.has(root)) : [];
    if (roots.length === 0) return;
    for (const root of roots) inFlight.current.add(root);
    void loadSubtaskRows(roots, projectId)
      .catch(() => ({ error: "Couldn’t load the subtasks", data: undefined }))
      .then((result) => {
        for (const root of roots) inFlight.current.delete(root);
        if (result.error) notify(result.error);
        const byRoot = groupSubtasksByRoot(result.data ?? [], roots);
        setClient((current) => {
          const next = { ...current };
          // A failed read keeps what was shown (and isn't retried until the next server render).
          for (const root of roots) {
            next[root] = { items: result.error ? (current[root]?.items ?? []) : (byRoot.get(root) ?? []), version };
          }
          return next;
        });
        if (!result.error) setKept((current) => withoutIds(current, (result.data ?? []).map((item) => item.id)));
      });
  }, [missingKey, projectId, notify, version]);

  return {
    childrenOf,
    isExpanded,
    // Open, but its tree hasn't arrived yet.
    isLoading: (rootId: string) => !serverRoots.has(rootId) && !(rootId in client),
    toggle(id: string) {
      if (showAll) {
        setCollapsed((current) => toggled(current, id));
        return;
      }
      const open = !expanded.has(id);
      setExpanded((current) => toggled(current, id));
      void setTaskRowExpanded(id, open).then((result) => {
        if (result.error) notify(result.error);
      });
    },
    // Inside a transition: the edit shows at once.
    show(id: string, patch: RowPatch) {
      addPatch({ id, patch });
    },
    // After the server accepted it: kept until fresh data for that subtask arrives.
    keep(id: string, patch: RowPatch) {
      setKept((current) => mergePatch(current, { id, patch }));
    },
    keptPatch(id: string): RowPatch | undefined {
      return kept[id];
    },
    restore(id: string, previous: RowPatch | undefined) {
      setKept((current) => {
        const next = { ...current };
        if (previous) next[id] = previous;
        else delete next[id];
        return next;
      });
    },
  };
}

export type SubtaskTrees = ReturnType<typeof useSubtaskTrees>;

// ---------------------------------------------------------------------------------------------
// The expand arrow (item 41)
// ---------------------------------------------------------------------------------------------

// Before the completion control: an arrow that opens the row's subtasks, or the same room left empty so
// every row's name lines up.
export function ExpandToggle({
  expandable,
  expanded,
  title,
  onToggle,
  className = "",
}: {
  expandable: boolean;
  expanded: boolean;
  title: string;
  onToggle: () => void;
  className?: string;
}) {
  if (!expandable) return <span aria-hidden className={`w-4 shrink-0 ${className}`} />;
  return (
    <button
      type="button"
      draggable={false}
      data-expand-toggle=""
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} subtasks of “${title}”`}
      data-tooltip={expanded ? "Hide subtasks" : "Show subtasks"}
      onClick={onToggle}
      className={`inline-flex size-4 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800 ${className}`}
    >
      <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden />
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Inline cells (item 46)
// ---------------------------------------------------------------------------------------------

// A cell's button: the whole cell is the target; the value reads as it does in a read-only row.
export const CELL_BUTTON =
  "-mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left hover:bg-zinc-200/50 aria-expanded:bg-zinc-100 aria-expanded:ring-1 aria-expanded:ring-accent-400 focus-visible:outline-2 focus-visible:outline-accent-500";

export type DateEdit = { startOn?: string | null; dueOn?: string | null };

// The assignee (or approver) as the row shows it; Editors click to pick someone or clear it.
export function InlineAssigneeCell({
  taskTitle,
  assignee,
  people,
  canEdit,
  approver = false,
  showName = true,
  onChange,
}: {
  taskTitle: string;
  assignee: Profile | undefined;
  people: Profile[];
  canEdit: boolean;
  approver?: boolean;
  showName?: boolean;
  onChange: (assigneeId: string | null) => void;
}) {
  const shown = assignee ? <Assignee profile={assignee} showName={showName} /> : <EmptyCellHint kind="person" hidden={!canEdit} />;
  if (!canEdit) return shown;
  const role = approver ? "Approver" : "Assignee";
  const choices = assignee && !people.some((p) => p.id === assignee.id) ? [assignee, ...people] : people;
  return (
    <PersonPicker
      label={`${role} of “${taskTitle}”: ${assignee ? displayName(assignee) : "nobody"}. Change`}
      people={choices}
      value={assignee?.id ?? null}
      onPick={(profileId) => onChange(profileId)}
      onClear={() => onChange(null)}
      clearLabel={approver ? "Remove approver" : "Remove assignee"}
      emptyNote="Only people in this project can be assigned."
      buttonClassName={showName ? CELL_BUTTON : "inline-flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-zinc-200/60 aria-expanded:bg-zinc-100"}
      button={shown}
    />
  );
}

// A due date (start and due in one picker, like the pane), a start date, or a due date alone (rows that
// don't know the start date). The parent saves through useDependencyShift (dependents may move too) and
// closes the picker before its prompt opens.
export function InlineDateCell({
  taskTitle,
  column,
  startOn = null,
  dueOn,
  milestone = false,
  canEdit,
  display,
  onChange,
}: {
  taskTitle: string;
  column: "due" | "start" | "due-only";
  startOn?: string | null;
  dueOn: string | null;
  milestone?: boolean;
  canEdit: boolean;
  display: ReactNode;
  onChange: (edit: DateEdit, close: () => void) => void;
}) {
  if (!canEdit || (column === "start" && milestone)) return <>{display}</>;
  const what = column === "start" ? "Start date" : "Due date";
  const current = column === "start" ? startOn : dueOn;
  const currentText = current ? dayLabel(current, Number(current.slice(0, 4))) : "none";
  return (
    <Popover
      label={`${what} of “${taskTitle}”: ${currentText}. Change`}
      panelClassName="w-[19rem] p-0"
      buttonClassName={CELL_BUTTON}
      button={display}
    >
      {(close) =>
        column === "due" ? (
          <DateRangePicker
            value={{ start: milestone ? null : startOn, due: dueOn }}
            allowStart={!milestone}
            onChange={(next, shouldClose) => {
              if (shouldClose) close();
              onChange({ startOn: milestone ? null : next.start, dueOn: next.due }, close);
            }}
          />
        ) : column === "start" ? (
          <SingleDatePicker
            label="Start date"
            value={startOn}
            onChange={(day) => {
              close();
              onChange({ startOn: day, dueOn: day && dueOn && dueOn < day ? day : dueOn }, close);
            }}
          />
        ) : (
          <SingleDatePicker
            label="Due date"
            value={dueOn}
            onChange={(day) => {
              close();
              onChange({ dueOn: day }, close);
            }}
          />
        )
      }
    </Popover>
  );
}

// One choice from a list (a single-select field, the section-bound Status, the Section column): the
// colored pill list with the current one ticked, and a way to clear it.
export function InlineChoiceCell({
  label,
  value,
  options,
  clearLabel = "Clear",
  display,
  onChange,
}: {
  label: string;
  value: string | null;
  options: FieldOption[];
  clearLabel?: string;
  display: ReactNode;
  onChange: (next: string | null) => void;
}) {
  return (
    <Popover label={label} panelClassName="w-60 p-1.5" buttonClassName={CELL_BUTTON} button={display}>
      {(close) => (
        <>
          {options.length === 0 ? <p className="px-2 py-1.5 text-xs text-zinc-500">No options yet — add them under Fields.</p> : null}
          {options.map((option) => (
            <MenuItem
              key={option.id}
              onClick={() => {
                close();
                if (option.id !== value) onChange(option.id);
              }}
            >
              <span className={`${PILL} ${OPTION_COLOR_CLASSES[option.color]}`}>{option.name}</span>
              {option.id === value ? <Check className="ml-auto size-4 text-accent-600" aria-label="Selected" /> : null}
            </MenuItem>
          ))}
          {value ? (
            <>
              <hr className="my-1 border-zinc-100" />
              <MenuItem
                onClick={() => {
                  close();
                  onChange(null);
                }}
              >
                <span className="text-zinc-500">{clearLabel}</span>
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </Popover>
  );
}

// A custom field's value in a List cell, edited the way the pane edits it (task-fields.tsx): text in the
// pop-out editor (item 48), numbers in a box (Enter saves, Escape cancels), dates in the calendar, a
// checkbox, single and multiple choices as pills, people from a searchable list, and the section-bound
// Status as the section.
export function InlineFieldCell({
  field,
  value,
  sectionId,
  sections,
  people,
  taskTitle,
  canEdit,
  display,
  onChange,
  onSectionChange,
  onEditingChange,
}: {
  field: FieldDef;
  value: Json | undefined;
  sectionId: string | null;
  sections: { id: string; name: string }[];
  people: Profile[];
  taskTitle: string;
  canEdit: boolean;
  display: ReactNode;
  // JSON null clears the value. The text editor waits for the returned result (useServerAction's run):
  // a refused save keeps it open with what was typed.
  onChange: (next: Json) => void | Promise<ActionResult | void>;
  onSectionChange: (sectionId: string | null) => void;
  // A text box is open (the row stops being draggable so text can be selected).
  onEditingChange?: (editing: boolean) => void;
}) {
  const label = `${field.name} of “${taskTitle}”`;
  // Text (item 48): the pop-out editor, or the whole text to read for people who can't edit.
  if (field.fieldType === "text" && !field.boundToSections) {
    return (
      <InlineLongTextCell
        label={label}
        fieldName={field.name}
        taskTitle={taskTitle}
        value={value ?? null}
        canEdit={canEdit}
        locked={Boolean(field.locked)}
        display={display}
        onChange={onChange}
        onEditingChange={onEditingChange}
      />
    );
  }
  if (!canEdit) return <>{display}</>;
  if (field.boundToSections) {
    return (
      <InlineChoiceCell
        label={`${label}: ${sections.find((s) => s.id === sectionId)?.name ?? "No section"}. Change`}
        value={sectionId}
        options={sections.map((s) => ({ id: s.id, name: s.name, color: "zinc" as const }))}
        clearLabel="No section"
        display={display}
        onChange={onSectionChange}
      />
    );
  }
  switch (field.fieldType) {
    case "number":
      return (
        <InlineNumberCell
          label={label}
          fieldName={field.name}
          symbol={numberPrefixOf(field)}
          value={value ?? null}
          display={display}
          onChange={onChange}
          onEditingChange={onEditingChange}
        />
      );
    case "date": {
      const day = typeof value === "string" ? value : null;
      return (
        <Popover
          label={`${label}: ${day ? dayLabel(day, Number(day.slice(0, 4))) : "empty"}. Change`}
          panelClassName="w-[19rem] p-0"
          buttonClassName={CELL_BUTTON}
          button={display}
        >
          {(close) => (
            <SingleDatePicker
              label={field.name}
              value={day}
              onChange={(next) => {
                close();
                if (next !== day) onChange(next);
              }}
            />
          )}
        </Popover>
      );
    }
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.currentTarget.checked)}
          aria-label={label}
          className="size-4 rounded border-zinc-300 accent-accent-600"
        />
      );
    case "single_select": {
      const current = typeof value === "string" ? value : null;
      return (
        <InlineChoiceCell
          label={`${label}: ${field.options.find((o) => o.id === current)?.name ?? "empty"}. Change`}
          value={current}
          options={field.options}
          display={display}
          onChange={onChange}
        />
      );
    }
    case "multi_select": {
      const selected = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      return (
        <Popover label={`${label}. Change`} panelClassName="w-60 p-1.5" buttonClassName={CELL_BUTTON} button={display}>
          {(close) => (
            <div role="group" aria-label={field.name}>
              {field.options.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-zinc-500">No options yet — add them under Fields.</p>
              ) : null}
              {field.options.map((option) => {
                const on = selected.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onChange(on ? selected.filter((id) => id !== option.id) : [...selected, option.id])}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100"
                  >
                    <span className={`${PILL} ${OPTION_COLOR_CLASSES[option.color]}`}>{option.name}</span>
                    {on ? <Check className="ml-auto size-4 text-accent-600" aria-label="Selected" /> : null}
                  </button>
                );
              })}
              {selected.length ? (
                <>
                  <hr className="my-1 border-zinc-100" />
                  <MenuItem
                    onClick={() => {
                      close();
                      onChange(null);
                    }}
                  >
                    <span className="text-zinc-500">Clear</span>
                  </MenuItem>
                </>
              ) : null}
            </div>
          )}
        </Popover>
      );
    }
    case "people": {
      const selected = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      return (
        <Popover label={`${label}. Change`} panelClassName="w-72 p-0" buttonClassName={CELL_BUTTON} button={display}>
          {(close) => (
            <PeopleList
              label={field.name}
              people={people}
              selected={selected}
              emptyNote="Nobody can be picked here."
              onPick={(profileId) =>
                onChange(selected.includes(profileId) ? selected.filter((id) => id !== profileId) : [...selected, profileId])
              }
              footer={
                selected.length ? (
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      onChange(null);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-100"
                  >
                    <X className="size-4 text-zinc-400" aria-hidden />
                    Clear {field.name}
                  </button>
                ) : null
              }
            />
          )}
        </Popover>
      );
    }
  }
  return <>{display}</>;
}

// Number values: the cell turns into a box. Enter or leaving it saves, Escape cancels; Enter and Escape
// put the focus back on the cell. The field's symbol (item 49) sits inside the box.
function InlineNumberCell({
  label,
  fieldName,
  symbol = null,
  value,
  display,
  onChange,
  onEditingChange,
}: {
  label: string;
  fieldName: string;
  symbol?: string | null;
  value: Json;
  display: ReactNode;
  onChange: (next: Json) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const notify = useNotify();
  const [editing, setEditing] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  }, [editing]);

  const stop = () => {
    setEditing(false);
    onEditingChange?.(false);
  };
  const commit = (raw: string, badInput: boolean) => {
    stop();
    // Text that isn't a number (the box then reads "") keeps the saved value instead of clearing it.
    const entry = readNumberBox(raw, badInput);
    if (entry.kind === "keep") {
      notify(notANumberNote(fieldName, symbol));
      return;
    }
    const next = entry.kind === "clear" ? null : entry.value;
    if (next !== (typeof value === "number" ? value : null)) onChange(next);
  };

  if (editing) {
    const initial = typeof value === "number" ? String(value) : "";
    return (
      <NumberInput
        autoFocus
        defaultValue={initial}
        aria-label={label}
        draggable={false}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.currentTarget.value, e.currentTarget.validity.badInput)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            refocus.current = true;
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            refocus.current = true;
            e.currentTarget.value = initial;
            e.currentTarget.blur();
          }
        }}
        className="control h-7 min-w-0 flex-1"
        symbol={symbol}
        wrapperClassName="min-w-0 flex-1"
      />
    );
  }
  const shown = typeof value === "number" ? formatNumberValue(value, symbol) : "empty";
  return (
    <button
      ref={buttonRef}
      type="button"
      draggable={false}
      aria-label={`${label}: ${shown}. Change`}
      onClick={() => {
        setEditing(true);
        onEditingChange?.(true);
      }}
      className={CELL_BUTTON}
    >
      {display}
    </button>
  );
}

// Text values (item 48): the cell shows one line (the whole text on hover when it's cut off, from
// FieldValueChips); a click opens the pop-out editor — or, for people who can't edit, the whole text to
// read. An empty value has nothing to read, so below Editor it stays plain.
export function InlineLongTextCell({
  label,
  fieldName,
  taskTitle,
  value,
  canEdit,
  locked = false,
  display,
  onChange,
  onEditingChange,
}: {
  label: string;
  fieldName: string;
  taskTitle: string;
  value: Json;
  canEdit: boolean;
  // A locked field (item 51): the read-only view says why.
  locked?: boolean;
  display: ReactNode;
  onChange: (next: Json) => void | Promise<ActionResult | void>;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const text = typeof value === "string" ? value : "";
  if (!canEdit && !text) return <>{display}</>;
  return (
    <>
      <button
        type="button"
        draggable={false}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={textValueLabel(label, text, canEdit ? "Change" : "Show full text")}
        onClick={() => {
          setOpen(true);
          onEditingChange?.(true);
        }}
        className={CELL_BUTTON}
      >
        {display}
      </button>
      {open ? (
        <LongTextEditor
          fieldName={fieldName}
          taskTitle={taskTitle}
          value={value}
          readOnly={!canEdit}
          locked={locked}
          onSave={(next) => onChange(next)}
          onClose={() => {
            setOpen(false);
            onEditingChange?.(false);
          }}
        />
      ) : null}
    </>
  );
}
