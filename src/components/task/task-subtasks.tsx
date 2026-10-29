"use client";

import { useOptimistic, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, CalendarDays, Check, ChevronRight, GitBranch, GripVertical, ListChecks, ListFilter, MoreHorizontal, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { CompleteToggle, kindToggleLabel } from "@/components/complete-toggle";
import { MenuItem, Popover } from "@/components/popover";
import { useServerAction } from "@/components/toast";
import { createSubtask, deleteSubtask, placeSubtask, updateSubtask, updateTask } from "@/lib/actions";
import { addDays, useToday } from "@/lib/dates";
import type { Profile, SubtaskItem, TaskDetail } from "@/lib/data";
import { formatRequestLabel } from "@/lib/request-numbers";
import { taskPermissions } from "@/lib/permissions";
import { hasRole } from "@/lib/roles";
import { MAX_SUBTASK_DEPTH, subtaskOrderBefore } from "@/lib/subtasks";
import { DateRangePicker } from "./date-picker";
import { useDependencyShift } from "./dependency-shift";
import { ConvertToMainTaskDialog, canConvertSubtaskRow } from "./task-convert";
import { PersonPicker } from "./person-picker";
import { useDateText } from "./task-dates";
import { PANE_HEADING } from "./pane-styles";
import { TaskLink } from "@/components/task/task-link";
import { seedFromSubtask } from "@/lib/task-seed";
import { useSubtaskPrefs } from "./subtask-prefs";
import { SUBTASK_SORTS, SUBTASK_SORT_LABELS, isOrganized, organizeSummary, organizeSubtasks, type SubtaskPrefs } from "@/lib/subtask-view";

type Change =
  | { type: "toggle"; id: string; completed: boolean }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; sortOrder: number }
  | { type: "patch"; id: string; patch: Partial<Pick<SubtaskItem, "assigneeId" | "startOn" | "dueOn">> };

function applyChange(current: SubtaskItem[], change: Change): SubtaskItem[] {
  if (change.type === "remove") return current.filter((s) => s.id !== change.id);
  const next = current.map((s) => {
    if (s.id !== change.id) return s;
    if (change.type === "toggle") return { ...s, completedAt: change.completed ? new Date().toISOString() : null };
    if (change.type === "move") return { ...s, sortOrder: change.sortOrder };
    return { ...s, ...change.patch };
  });
  return change.type === "move" ? next.sort((a, b) => a.sortOrder - b.sortOrder) : next;
}

const SUBTASK_DRAG = "application/x-alhc-subtask";
// Hover-only controls that stay visible on touch screens and while focused or open.
const REVEAL = "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100";

// Whether the pane shows the Subtasks section (Editors can always add the first one).
export function canAddSubtask(task: TaskDetail) {
  return taskPermissions(task).canEdit && task.ancestors.length < MAX_SUBTASK_DEPTH;
}

// The pane's Subtasks (Asana parity, batch 3): one line per subtask — complete, rename in place,
// assignee and dates in pickers, a menu to move or delete, and ">" to open it in its own pane (where it
// has its own subtasks, comments, fields, and so on). "+ Add subtask" below; the header's subtask
// button opens the same input (adding / onAddingChange).
export function TaskSubtasks({
  task,
  profiles,
  adding,
  onAddingChange,
  memberId,
}: {
  task: TaskDetail;
  profiles: Profile[];
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  // The signed-in person (the "Assigned to me" filter).
  memberId?: string;
}) {
  const [, run] = useServerAction();
  // What a subtask row knows, drawn at once when it's opened (no navigation; Oct 19 notes).
  // The task's first project the viewer can read (stable order; Oct 29 notes, 55b).
  const homeProject = task.memberships[0];
  const subtaskSeed = (subtask: SubtaskItem) => {
    const assignee = subtask.assigneeId ? profiles.find((p) => p.id === subtask.assigneeId) : undefined;
    return seedFromSubtask(
      subtask,
      { title: task.title, projectName: homeProject?.projectName ?? (task.isPrivate ? "Private" : null) },
      { personName: () => (assignee ? displayName(assignee) : null), canEdit: taskPermissions(task).canEdit },
    );
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const [allSubtasks, change] = useOptimistic(task.subtasks, applyChange);
  // Oct 27 notes (batch 5): Filter (Hide completed, Assigned to me) and Sort, remembered per person.
  const { prefs, setPrefs } = useSubtaskPrefs();
  const me = memberId ?? null;
  const nameOf = (profileId: string) => {
    const person = profiles.find((p) => p.id === profileId);
    return person ? displayName(person) : "";
  };
  const subtasks = organizeSubtasks(allSubtasks, prefs, me, nameOf);
  // Reordering by hand only makes sense in the manual order.
  const manualOrder = prefs.sort === "manual";
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  // Dates go through the same path as the task's own (Oct 27 notes, batch 6): dependents move as the
  // project's Settings → Dependencies says.
  const shift = useDependencyShift();
  // "Convert to main task…" from a row's "…" menu.
  const [converting, setConverting] = useState<SubtaskItem | null>(null);
  const canEdit = taskPermissions(task).canEdit;
  const done = allSubtasks.filter((s) => s.completedAt).length;
  const approvalBySubtask = new Map(task.approvals.filter((a) => a.subtaskId).map((a) => [a.subtaskId!, a] as const));
  // This task's own depth is its number of ancestors (0 = an ordinary task); subtasks sit one below.
  const atDepthLimit = task.ancestors.length >= MAX_SUBTASK_DEPTH;
  const assignableFor = (s: SubtaskItem) =>
    profiles.filter(
      (p) =>
        p.id === s.assigneeId ||
        (s.kind === "approval" ? hasRole(task.memberRoles[p.id], "commenter") : p.id in task.memberRoles),
    );

  if (allSubtasks.length === 0 && !(canEdit && !atDepthLimit)) return null;

  function move(subtask: SubtaskItem, beforeId: string | null) {
    if (beforeId === subtask.id) return;
    const sortOrder = subtaskOrderBefore(allSubtasks, beforeId, subtask.id);
    run(
      () => placeSubtask(subtask.id, beforeId),
      () => change({ type: "move", id: subtask.id, sortOrder }),
    );
  }

  function patch(subtask: SubtaskItem, value: Partial<Pick<SubtaskItem, "assigneeId">>) {
    run(
      () => updateTask(subtask.id, value),
      () => change({ type: "patch", id: subtask.id, patch: value }),
    );
  }

  // A subtask's dates: shown at once; tasks that depend on it move (later or earlier) like anywhere else.
  function changeDates(subtask: SubtaskItem, dates: { startOn: string | null; dueOn: string | null }) {
    const shown = new Set(allSubtasks.map((s) => s.id));
    shift.changeDates(subtask, dates, {
      onOptimistic: (moves) =>
        moves
          .filter((m) => shown.has(m.taskId))
          .forEach((m) => change({ type: "patch", id: m.taskId, patch: { startOn: m.startOn, dueOn: m.dueOn } })),
      projectId: task.memberships[0]?.projectId ?? null,
    });
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer.getData(SUBTASK_DRAG);
    const subtask = subtasks.find((s) => s.id === id);
    const beforeId = dropBefore ?? null;
    setDragging(null);
    setDropBefore(undefined);
    if (subtask) move(subtask, beforeId);
  }

  function add() {
    const input = inputRef.current;
    const title = input?.value.trim();
    if (!input || !title) return;
    input.value = "";
    run(() => createSubtask(task.id, title));
  }

  return (
    <section id="task-subtasks" className="mt-6" aria-labelledby={subtasks.length ? "subtasks-heading" : undefined}>
      {shift.dialog}
      {converting ? (
        <ConvertToMainTaskDialog
          taskId={converting.id}
          title={converting.title}
          memberships={task.memberships}
          editableProjectIds={task.editableProjectIds}
          onClose={() => setConverting(null)}
        />
      ) : null}
      {allSubtasks.length > 0 ? (
        <div className="flex items-center gap-2">
          <h3 id="subtasks-heading" className={PANE_HEADING}>
            Subtasks
          </h3>
          <span className="ml-auto text-xs tabular-nums text-zinc-500">
            {done} of {allSubtasks.length} done
          </span>
          <SubtaskOrganizeMenu prefs={prefs} onChange={setPrefs} />
        </div>
      ) : null}
      {allSubtasks.length > 0 && isOrganized(prefs) ? (
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-zinc-500">
          <span>{organizeSummary(subtasks.length, allSubtasks.length, prefs)}</span>
          <button
            type="button"
            onClick={() => setPrefs({ hideCompleted: false, assignedToMe: false, sort: "manual" })}
            className="font-medium text-accent-700 hover:underline"
          >
            Show all in manual order
          </button>
        </p>
      ) : null}

      {allSubtasks.length > 0 || adding ? (
        <ul
          className="mt-1.5 border-t border-zinc-100"
          onDragOver={(e) => {
            if (!dragging) return;
            e.preventDefault();
            if (dropBefore === undefined) setDropBefore(null);
          }}
          onDrop={dragging ? drop : undefined}
        >
          {subtasks.map((subtask, index) => {
            const completed = Boolean(subtask.completedAt);
            const approval = approvalBySubtask.get(subtask.id);
            const showDrop = dragging !== null && dragging !== subtask.id && dropBefore === subtask.id;
            return (
              <li
                key={subtask.id}
                className={`group flex min-h-9 items-center gap-1.5 border-b border-zinc-100 pr-1 hover:bg-zinc-50 ${
                  dragging === subtask.id ? "opacity-40" : ""
                } ${showDrop ? "shadow-[inset_0_2px_0_var(--color-accent-500)]" : ""}`}
                onDragOver={(e) => {
                  if (!dragging || dragging === subtask.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > rect.top + rect.height / 2;
                  setDropBefore(after ? (subtasks[index + 1]?.id ?? null) : subtask.id);
                }}
              >
                {canEdit && manualOrder ? (
                  <span
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(SUBTASK_DRAG, subtask.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(subtask.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropBefore(undefined);
                    }}
                    title="Drag to reorder"
                    aria-hidden
                    className="flex w-4 shrink-0 cursor-grab justify-center text-zinc-300 opacity-0 hover:text-zinc-500 active:cursor-grabbing group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <GripVertical className="size-3.5" />
                  </span>
                ) : (
                  <span className="w-1 shrink-0" aria-hidden />
                )}
                {approval ? (
                  <span
                    data-tooltip="Approval subtask: decide it in Approvals below"
                    className={`inline-flex size-4 shrink-0 items-center justify-center ${
                      approval.status === "approved" ? "text-green-700" : "text-amber-600"
                    }`}
                  >
                    <ShieldCheck className="size-4" aria-label="Approval" />
                  </span>
                ) : (
                  <CompleteToggle
                    size="sm"
                    kind={subtask.kind}
                    completed={completed}
                    readOnly={!canEdit}
                    label={kindToggleLabel(subtask.kind, subtask.title, completed)}
                    onToggle={() =>
                      run(
                        () => updateSubtask(subtask.id, { completed: !completed }),
                        () => change({ type: "toggle", id: subtask.id, completed: !completed }),
                      )
                    }
                  />
                )}
                {canEdit ? (
                  <label className="sr-only" htmlFor={`subtask-${subtask.id}`}>
                    Subtask name
                  </label>
                ) : null}
                {subtask.requestLabel ? (
                  <span className="shrink-0 text-xs font-medium text-zinc-500">
                    {formatRequestLabel(subtask.requestLabel)}
                  </span>
                ) : null}
                {!canEdit ? (
                  <span className={`min-w-0 flex-1 truncate px-1 text-sm ${completed ? "text-zinc-400 line-through" : "text-zinc-800"}`}>
                    {subtask.title}
                  </span>
                ) : (
                <input
                  id={`subtask-${subtask.id}`}
                  defaultValue={subtask.title}
                  onBlur={(e) => {
                    const title = e.currentTarget.value.trim();
                    if (!title) e.currentTarget.value = subtask.title;
                    else if (title !== subtask.title) run(() => updateSubtask(subtask.id, { title }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  className={`h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-sm hover:border-zinc-200 focus:border-zinc-300 focus:bg-white focus:outline-none ${
                    completed ? "text-zinc-400 line-through" : "text-zinc-800"
                  }`}
                />
                )}
                {subtask.subtaskCount > 0 ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-zinc-500"
                    title={`${subtask.subtaskDoneCount} of ${subtask.subtaskCount} subtasks done`}
                  >
                    <ListChecks className="size-3.5" aria-hidden />
                    <span className="sr-only">Subtasks done:</span>
                    {subtask.subtaskDoneCount}/{subtask.subtaskCount}
                  </span>
                ) : null}
                <SubtaskAssignee subtask={subtask} people={assignableFor(subtask)} canEdit={canEdit} onChange={(assigneeId) => patch(subtask, { assigneeId })} />
                <SubtaskDates subtask={subtask} canEdit={canEdit} onChange={(dates) => changeDates(subtask, dates)} />
                {canEdit ? (
                  <Popover
                    label={`More for subtask ${subtask.title}`}
                    tooltip="More actions"
                    align="end"
                    panelClassName="w-52 p-1.5"
                    buttonClassName={`btn-icon size-6 ${REVEAL}`}
                    button={<MoreHorizontal className="size-4" aria-hidden />}
                  >
                    {(close) => (
                      <>
                        <MenuItem
                          disabled={index === 0 || !manualOrder}
                          onClick={() => {
                            close();
                            move(subtask, subtasks[index - 1].id);
                          }}
                        >
                          <ArrowUp className="size-4 text-zinc-500" aria-hidden /> Move up
                        </MenuItem>
                        <MenuItem
                          disabled={index === subtasks.length - 1 || !manualOrder}
                          onClick={() => {
                            close();
                            move(subtask, subtasks[index + 2]?.id ?? null);
                          }}
                        >
                          <ArrowDown className="size-4 text-zinc-500" aria-hidden /> Move down
                        </MenuItem>
                        {canConvertSubtaskRow(task, Boolean(approval)) ? (
                          <MenuItem
                            onClick={() => {
                              close();
                              setConverting(subtask);
                            }}
                          >
                            <GitBranch className="size-4 text-zinc-500" aria-hidden /> Convert to main task…
                          </MenuItem>
                        ) : null}
                        <MenuItem
                          danger
                          onClick={() => {
                            close();
                            run(
                              () => deleteSubtask(subtask.id),
                              () => change({ type: "remove", id: subtask.id }),
                            );
                          }}
                        >
                          <Trash2 className="size-4" aria-hidden /> Delete subtask
                        </MenuItem>
                      </>
                    )}
                  </Popover>
                ) : null}
                <TaskLink
                  taskId={subtask.id}
                  seed={() => subtaskSeed(subtask)}
                  aria-label={`Open subtask ${subtask.title}`}
                  data-tooltip="Open subtask"
                  className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
                >
                  <ChevronRight className="size-4" />
                </TaskLink>
              </li>
            );
          })}
          {adding ? (
            <li className="flex min-h-9 items-center gap-1.5 border-b border-zinc-100 pl-5 pr-1">
              <span aria-hidden className="size-4 shrink-0 rounded-full border border-dashed border-zinc-300" />
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
                className="min-w-0 flex-1"
              >
                <label className="sr-only" htmlFor="new-subtask">
                  New subtask name
                </label>
                <input
                  ref={inputRef}
                  id="new-subtask"
                  autoFocus
                  placeholder="Write a subtask name, then press Enter"
                  onBlur={(e) => {
                    if (!e.currentTarget.value.trim()) onAddingChange(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.value = "";
                      onAddingChange(false);
                    }
                  }}
                  className="h-7 w-full rounded-md border border-transparent bg-transparent px-1 text-sm placeholder:text-zinc-500 focus:outline-none"
                />
              </form>
            </li>
          ) : null}
        </ul>
      ) : null}

      {canEdit && !atDepthLimit && !adding ? (
        <button type="button" onClick={() => onAddingChange(true)} className="btn-ghost -ml-1 mt-1 h-7 px-1.5 text-zinc-600 print:hidden">
          <Plus className="size-4" aria-hidden />
          Add subtask
        </button>
      ) : null}
      {canEdit && atDepthLimit && subtasks.length > 0 ? (
        <p className="mt-1 text-xs text-zinc-500">Subtasks nest up to {MAX_SUBTASK_DEPTH} levels; this one is at the limit.</p>
      ) : null}
    </section>
  );
}

// The subtask's assignee: their avatar, or a dashed person on hover; a picker for Editors.
function SubtaskAssignee({
  subtask,
  people,
  canEdit,
  onChange,
}: {
  subtask: SubtaskItem;
  people: Profile[];
  canEdit: boolean;
  onChange: (assigneeId: string | null) => void;
}) {
  const assignee = people.find((p) => p.id === subtask.assigneeId);
  const name = assignee ? displayName(assignee) : null;
  const face = name ? (
    <Avatar name={name} src={assignee?.avatar_url} profileId={assignee?.id} />
  ) : (
    <span className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-zinc-300 text-zinc-400">
      <UserRound className="size-3" aria-hidden />
    </span>
  );
  if (!canEdit) return name ? <span className="shrink-0">{face}<span className="sr-only">Assigned to {name}</span></span> : null;
  return (
    <PersonPicker
      label={`${subtask.kind === "approval" ? "Approver" : "Assignee"} of ${subtask.title}: ${name ?? "nobody"}. Change`}
      tooltip={name ?? "Assign"}
      align="end"
      people={people}
      value={subtask.assigneeId}
      onPick={onChange}
      onClear={() => onChange(null)}
      buttonClassName={`inline-flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-zinc-100 ${name ? "" : REVEAL}`}
      button={face}
    />
  );
}

// The subtask's dates: the due date (red when overdue, green today / tomorrow), or a dashed calendar on
// hover; the same date picker as the task's, without times or Repeats.
function SubtaskDates({
  subtask,
  canEdit,
  onChange,
}: {
  subtask: SubtaskItem;
  canEdit: boolean;
  onChange: (dates: { startOn: string | null; dueOn: string | null }) => void;
}) {
  const today = useToday();
  const dateText = useDateText();
  const completed = Boolean(subtask.completedAt);
  const { startOn, dueOn } = subtask;
  const overdue = Boolean(dueOn && today && !completed && dueOn < today);
  const soon = Boolean(dueOn && today && !completed && (dueOn === today || dueOn === addDays(today, 1)));
  const text = dueOn ? (startOn && startOn !== dueOn ? `${dateText(startOn)} – ${dateText(dueOn)}` : dateText(dueOn)) : startOn ? `Starts ${dateText(startOn)}` : null;
  const shown = text ? (
    <span className={`whitespace-nowrap text-xs tabular-nums ${overdue ? "font-medium text-red-600" : soon ? "font-medium text-green-700" : "text-zinc-500"}`}>
      {text}
    </span>
  ) : (
    <span className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-zinc-300 text-zinc-400">
      <CalendarDays className="size-3" aria-hidden />
    </span>
  );
  if (!canEdit) return text ? <span className="shrink-0">{shown}</span> : null;
  return (
    <Popover
      label={`Dates of ${subtask.title}: ${text ?? "none"}. Change`}
      tooltip={text ? undefined : "Set a due date"}
      align="end"
      panelClassName="w-[19rem] p-0"
      buttonClassName={`inline-flex h-6 shrink-0 items-center rounded-md px-1 hover:bg-zinc-100 aria-expanded:bg-zinc-100 ${text ? "" : REVEAL}`}
      button={shown}
    >
      {(close) => (
        <DateRangePicker
          value={{ start: startOn, due: dueOn }}
          allowStart={subtask.kind !== "milestone"}
          onChange={(next, shouldClose) => {
            if (shouldClose) close();
            if (next.start !== startOn || next.due !== dueOn) onChange({ startOn: next.start, dueOn: next.due });
          }}
        />
      )}
    </Popover>
  );
}

// The Subtasks organize menu (Oct 27 notes, batch 5): Filter and Sort, saved for this person.
function SubtaskOrganizeMenu({ prefs, onChange }: { prefs: SubtaskPrefs; onChange: (next: SubtaskPrefs) => void }) {
  const row = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100";
  const on = isOrganized(prefs);
  return (
    <Popover
      label="Filter and sort subtasks"
      tooltip="Filter and sort"
      align="end"
      panelClassName="w-60 p-1.5"
      buttonClassName={`btn-ghost h-6 gap-1 px-1.5 text-xs ${on ? "text-accent-700 hover:text-accent-800" : ""}`}
      button={
        <>
          <ListFilter className="size-3.5" aria-hidden />
          Organize
          {on ? <span className="sr-only"> (on)</span> : null}
        </>
      }
    >
      {() => (
        <div>
          <p className="px-2 pb-1 pt-0.5 text-2xs font-medium uppercase tracking-wide text-zinc-400">Filter</p>
          {(
            [
              { key: "hideCompleted", label: "Hide completed" },
              { key: "assignedToMe", label: "Assigned to me" },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={prefs[item.key]}
              onClick={() => onChange({ ...prefs, [item.key]: !prefs[item.key] })}
              className={row}
            >
              <span className="flex-1">{item.label}</span>
              {prefs[item.key] ? <Check className="size-3.5 text-accent-600" aria-hidden /> : null}
            </button>
          ))}
          <div role="separator" className="my-1 border-t border-zinc-100" />
          <p className="px-2 pb-1 pt-0.5 text-2xs font-medium uppercase tracking-wide text-zinc-400">Sort</p>
          <div role="group" aria-label="Sort subtasks">
            {SUBTASK_SORTS.map((sort) => (
              <button
                key={sort}
                type="button"
                role="menuitemradio"
                aria-checked={prefs.sort === sort}
                onClick={() => onChange({ ...prefs, sort })}
                className={row}
              >
                <span className="flex-1">{SUBTASK_SORT_LABELS[sort]}</span>
                {prefs.sort === sort ? <Check className="size-3.5 text-accent-600" aria-hidden /> : null}
              </button>
            ))}
          </div>
          <p className="px-2 pt-1 text-2xs text-zinc-500">Saved for you on every task. Drag to reorder in Manual.</p>
        </div>
      )}
    </Popover>
  );
}
