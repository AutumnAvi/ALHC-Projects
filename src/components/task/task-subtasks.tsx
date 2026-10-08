"use client";

import Link from "next/link";
import { useOptimistic, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, ChevronRight, GripVertical, ListChecks, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { displayName } from "@/components/avatar";
import { CompleteToggle, kindToggleLabel } from "@/components/complete-toggle";
import { useTaskHref } from "@/components/project/shared";
import { useServerAction } from "@/components/toast";
import { createSubtask, deleteSubtask, placeSubtask, updateSubtask, updateTask } from "@/lib/actions";
import type { Profile, SubtaskItem, TaskDetail } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import { MAX_SUBTASK_DEPTH, subtaskOrderBefore } from "@/lib/subtasks";
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
const SMALL_CONTROL =
  "h-6 rounded-md border border-transparent bg-transparent px-1 text-xs text-zinc-600 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none disabled:hover:border-transparent";

// The pane's Subtasks section: real subtasks (tasks with this task as parent). Inline add, rename,
// complete, assign, start/due dates, reorder (drag, or Move up / Move down), delete, and open one in its
// own pane (where it has its own subtasks, comments, fields, and so on).
export function TaskSubtasks({ task, profiles }: { task: TaskDetail; profiles: Profile[] }) {
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

  return (
    <section className="mt-6" aria-labelledby="subtasks-heading">
      <div className="flex items-baseline justify-between">
        <h3 id="subtasks-heading" className={PANE_HEADING}>
          Subtasks
        </h3>
        {subtasks.length > 0 ? (
          <span className="text-xs tabular-nums text-zinc-500">
            {done} of {subtasks.length} done
          </span>
        ) : null}
      </div>

      <ul
        className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-200"
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
              className={`group px-2 py-1.5 ${dragging === subtask.id ? "opacity-40" : ""} ${
                showDrop ? "shadow-[inset_0_2px_0_var(--color-accent-500)]" : ""
              }`}
              onDragOver={(e) => {
                if (!dragging || dragging === subtask.id) return;
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const after = e.clientY > rect.top + rect.height / 2;
                setDropBefore(after ? (subtasks[index + 1]?.id ?? null) : subtask.id);
              }}
            >
              <div className="flex items-center gap-2">
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
                    className="cursor-grab rounded text-zinc-300 opacity-0 hover:text-zinc-500 active:cursor-grabbing group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <GripVertical className="size-3.5" />
                  </span>
                ) : null}
                {approval ? (
                  <span
                    title="Approval subtask: decide it in Approvals below"
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
                  className={`min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-zinc-200 focus:border-zinc-300 focus:outline-none ${
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
                {canEdit && index > 0 ? (
                  <button
                    type="button"
                    onClick={() => move(subtask, subtasks[index - 1].id)}
                    aria-label={`Move subtask ${subtask.title} up`}
                    title="Move up"
                    className="rounded p-0.5 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <ArrowUp className="size-3.5" />
                  </button>
                ) : null}
                {canEdit && index < subtasks.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => move(subtask, subtasks[index + 2]?.id ?? null)}
                    aria-label={`Move subtask ${subtask.title} down`}
                    title="Move down"
                    className="rounded p-0.5 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <ArrowDown className="size-3.5" />
                  </button>
                ) : null}
                {canEdit ? (
                  <button
                    type="button"
                    aria-label={`Delete subtask ${subtask.title}`}
                    title="Delete subtask (and its subtasks)"
                    onClick={() =>
                      run(
                        () => deleteSubtask(subtask.id),
                        () => change({ type: "remove", id: subtask.id }),
                      )
                    }
                    className="rounded p-0.5 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                ) : null}
                <Link
                  href={taskHref(subtask.id)}
                  scroll={false}
                  aria-label={`Open subtask ${subtask.title}`}
                  title="Open subtask"
                  className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
                >
                  <ChevronRight className="size-4" />
                </Link>
              </div>
              <div className={`mt-0.5 flex flex-wrap items-center gap-1 ${canEdit ? "pl-[3.25rem]" : "pl-6"}`}>
                <label className="sr-only" htmlFor={`subtask-assignee-${subtask.id}`}>
                  {subtask.kind === "approval" ? "Approver" : "Assignee"} of {subtask.title}
                </label>
                <select
                  id={`subtask-assignee-${subtask.id}`}
                  key={`a-${subtask.assigneeId ?? "none"}`}
                  defaultValue={subtask.assigneeId ?? ""}
                  disabled={!canEdit}
                  onChange={(e) => patch(subtask, { assigneeId: e.currentTarget.value || null })}
                  className={`${SMALL_CONTROL} max-w-40`}
                >
                  <option value="">No assignee</option>
                  {assignableFor(subtask).map((p) => (
                    <option key={p.id} value={p.id}>
                      {displayName(p)}
                    </option>
                  ))}
                </select>
                {subtask.kind === "milestone" ? null : (
                  <>
                    <label className="sr-only" htmlFor={`subtask-start-${subtask.id}`}>
                      Start date of {subtask.title}
                    </label>
                    <input
                      id={`subtask-start-${subtask.id}`}
                      key={`s-${subtask.startOn ?? ""}`}
                      type="date"
                      title="Start date"
                      defaultValue={subtask.startOn ?? ""}
                      max={subtask.dueOn ?? undefined}
                      disabled={!canEdit}
                      onChange={(e) => patch(subtask, { startOn: e.currentTarget.value || null })}
                      className={`${SMALL_CONTROL} w-32`}
                    />
                    <span aria-hidden className="text-xs text-zinc-300">
                      →
                    </span>
                  </>
                )}
                <label className="sr-only" htmlFor={`subtask-due-${subtask.id}`}>
                  Due date of {subtask.title}
                </label>
                <input
                  id={`subtask-due-${subtask.id}`}
                  key={`d-${subtask.dueOn ?? ""}`}
                  type="date"
                  title="Due date"
                  defaultValue={subtask.dueOn ?? ""}
                  min={subtask.startOn ?? undefined}
                  disabled={!canEdit}
                  onChange={(e) => patch(subtask, { dueOn: e.currentTarget.value || null })}
                  className={`${SMALL_CONTROL} w-32`}
                />
              </div>
            </li>
          );
        })}
        {canEdit && !atDepthLimit ? (
          <li className="px-3 py-1.5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = inputRef.current;
                const title = input?.value.trim();
                if (!input || !title) return;
                input.value = "";
                run(() => createSubtask(task.id, title));
              }}
              className="flex items-center gap-2.5"
            >
              <Plus className="size-4 text-zinc-400" aria-hidden />
              <label className="sr-only" htmlFor="new-subtask">
                New subtask
              </label>
              <input
                ref={inputRef}
                id="new-subtask"
                placeholder={subtasks.length ? "Add another subtask" : "Break this task into steps"}
                className="min-w-0 flex-1 bg-transparent py-0.5 text-sm placeholder:text-zinc-400 focus:outline-none"
              />
            </form>
          </li>
        ) : null}
        {subtasks.length === 0 && (!canEdit || atDepthLimit) ? (
          <li className="px-3 py-2 text-xs text-zinc-500">
            {atDepthLimit
              ? `No subtasks. Subtasks nest up to ${MAX_SUBTASK_DEPTH} levels, and this one is at the limit.`
              : "No subtasks yet. Editors can break this task into steps here."}
          </li>
        ) : null}
      </ul>
      {canEdit && atDepthLimit && subtasks.length > 0 ? (
        <p className="mt-1 text-xs text-zinc-500">Subtasks nest up to {MAX_SUBTASK_DEPTH} levels; this one is at the limit.</p>
      ) : null}
    </section>
  );
}
