"use client";

import Link from "next/link";
import { useOptimistic, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, CalendarDays, ChevronRight, GripVertical, ListChecks, MoreHorizontal, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { CompleteToggle, kindToggleLabel } from "@/components/complete-toggle";
import { MenuItem, Popover } from "@/components/popover";
import { useTaskHref } from "@/components/project/shared";
import { useServerAction } from "@/components/toast";
import { createSubtask, deleteSubtask, placeSubtask, updateSubtask, updateTask } from "@/lib/actions";
import { addDays, useToday } from "@/lib/dates";
import type { Profile, SubtaskItem, TaskDetail } from "@/lib/data";
import { formatRequestLabel } from "@/lib/request-numbers";
import { hasRole } from "@/lib/roles";
import { MAX_SUBTASK_DEPTH, subtaskOrderBefore } from "@/lib/subtasks";
import { DateRangePicker } from "./date-picker";
import { PersonPicker } from "./person-picker";
import { useDateText } from "./task-dates";
import { PANE_HEADING } from "./pane-styles";

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
  return hasRole(task.viewerRole, "editor") && task.ancestors.length < MAX_SUBTASK_DEPTH;
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
}: {
  task: TaskDetail;
  profiles: Profile[];
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
}) {
  const [, run] = useServerAction();
  const taskHref = useTaskHref();
  const inputRef = useRef<HTMLInputElement>(null);
  const [subtasks, change] = useOptimistic(task.subtasks, applyChange);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  const canEdit = hasRole(task.viewerRole, "editor");
  const done = subtasks.filter((s) => s.completedAt).length;
  const approvalBySubtask = new Map(task.approvals.filter((a) => a.subtaskId).map((a) => [a.subtaskId!, a] as const));
  // This task's own depth is its number of ancestors (0 = an ordinary task); subtasks sit one below.
  const atDepthLimit = task.ancestors.length >= MAX_SUBTASK_DEPTH;
  const assignableFor = (s: SubtaskItem) =>
    profiles.filter(
      (p) =>
        p.id === s.assigneeId ||
        (s.kind === "approval" ? hasRole(task.memberRoles[p.id], "commenter") : p.id in task.memberRoles),
    );

  if (subtasks.length === 0 && !(canEdit && !atDepthLimit)) return null;

  function move(subtask: SubtaskItem, beforeId: string | null) {
    if (beforeId === subtask.id) return;
    const sortOrder = subtaskOrderBefore(subtasks, beforeId, subtask.id);
    run(
      () => placeSubtask(subtask.id, beforeId),
      () => change({ type: "move", id: subtask.id, sortOrder }),
    );
  }

  function patch(subtask: SubtaskItem, value: Partial<Pick<SubtaskItem, "assigneeId" | "startOn" | "dueOn">>) {
    run(
      () => updateTask(subtask.id, value),
      () => change({ type: "patch", id: subtask.id, patch: value }),
    );
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
      {subtasks.length > 0 ? (
        <div className="flex items-baseline justify-between">
          <h3 id="subtasks-heading" className={PANE_HEADING}>
            Subtasks
          </h3>
          <span className="text-xs tabular-nums text-zinc-500">
            {done} of {subtasks.length} done
          </span>
        </div>
      ) : null}

      {subtasks.length > 0 || adding ? (
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
                {canEdit ? (
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
                    disabled={!canEdit}
                    label={kindToggleLabel(subtask.kind, subtask.title, completed)}
                    onToggle={() =>
                      run(
                        () => updateSubtask(subtask.id, { completed: !completed }),
                        () => change({ type: "toggle", id: subtask.id, completed: !completed }),
                      )
                    }
                  />
                )}
                <label className="sr-only" htmlFor={`subtask-${subtask.id}`}>
                  Subtask name
                </label>
                {subtask.requestLabel ? (
                  <span className="shrink-0 text-xs font-medium text-zinc-500">
                    {formatRequestLabel(subtask.requestLabel)}
                  </span>
                ) : null}
                <input
                  id={`subtask-${subtask.id}`}
                  defaultValue={subtask.title}
                  readOnly={!canEdit}
                  onBlur={(e) => {
                    const title = e.currentTarget.value.trim();
                    if (!title) e.currentTarget.value = subtask.title;
                    else if (title !== subtask.title) run(() => updateSubtask(subtask.id, { title }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  className={`h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-sm hover:border-zinc-200 focus:border-zinc-300 focus:bg-white focus:outline-none read-only:hover:border-transparent ${
                    completed ? "text-zinc-400 line-through" : "text-zinc-800"
                  }`}
                />
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
                <SubtaskDates subtask={subtask} canEdit={canEdit} onChange={(dates) => patch(subtask, dates)} />
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
                          disabled={index === 0}
                          onClick={() => {
                            close();
                            move(subtask, subtasks[index - 1].id);
                          }}
                        >
                          <ArrowUp className="size-4 text-zinc-500" aria-hidden /> Move up
                        </MenuItem>
                        <MenuItem
                          disabled={index === subtasks.length - 1}
                          onClick={() => {
                            close();
                            move(subtask, subtasks[index + 2]?.id ?? null);
                          }}
                        >
                          <ArrowDown className="size-4 text-zinc-500" aria-hidden /> Move down
                        </MenuItem>
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
                <Link
                  href={taskHref(subtask.id)}
                  scroll={false}
                  aria-label={`Open subtask ${subtask.title}`}
                  data-tooltip="Open subtask"
                  className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
                >
                  <ChevronRight className="size-4" />
                </Link>
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
    <Avatar name={name} />
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
