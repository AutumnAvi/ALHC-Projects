"use client";

import Link from "next/link";
import { useState, type DragEvent } from "react";
import { CompleteToggle } from "@/components/complete-toggle";
import { useServerAction } from "@/components/toast";
import { moveTask, setTaskCompleted } from "@/lib/actions";
import type { Profile, ProjectTask, Section } from "@/lib/data";
import { AddSection, AddTaskInput, SectionTitle, useTaskHref } from "./shared";
import { Assignee, DueDate, TaskBadges } from "./task-meta";
import { sortOrderFor, tasksBySection, useProjectTasks } from "./use-project-tasks";

type Props = {
  projectId: string;
  sections: Section[];
  tasks: ProjectTask[];
  profiles: Profile[];
  openTaskId: string | null;
};

type DropTarget = { sectionId: string | null; beforeId: string | null };

const DRAG_TYPE = "application/x-alhc-task";

export function BoardView({ projectId, sections, tasks, profiles, openTaskId }: Props) {
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const [, run] = useServerAction();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const groups = tasksBySection(optimisticTasks);
  const unsectioned = groups.get(null) ?? [];

  const columns: { id: string | null; section: Section | null; tasks: ProjectTask[] }[] = [
    ...(unsectioned.length > 0 || sections.length === 0
      ? [{ id: null, section: null, tasks: unsectioned }]
      : []),
    ...sections.map((section) => ({
      id: section.id,
      section,
      tasks: groups.get(section.id) ?? [],
    })),
  ];

  const sectionOptions = [
    ...(unsectioned.length > 0 ? [{ id: null as string | null, name: "No section" }] : []),
    ...sections.map((s) => ({ id: s.id as string | null, name: s.name })),
  ];

  function move(task: ProjectTask, target: DropTarget) {
    const column = groups.get(target.sectionId) ?? [];
    if (target.beforeId === task.id) return;
    const sortOrder = sortOrderFor(column, target.beforeId, task.id);
    run(
      () => moveTask(task.id, projectId, target.sectionId, sortOrder),
      () => applyChange({ type: "move", taskId: task.id, sectionId: target.sectionId, sortOrder }),
    );
  }

  function toggle(task: ProjectTask) {
    const completed = !task.completedAt;
    run(
      () => setTaskCompleted(task.id, completed),
      () => applyChange({ type: "complete", taskId: task.id, completed }),
    );
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    const taskId = event.dataTransfer.getData(DRAG_TYPE);
    const task = optimisticTasks.find((t) => t.id === taskId);
    if (task && dropTarget) move(task, dropTarget);
    setDragging(null);
    setDropTarget(null);
  }

  return (
    <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-6 py-4">
      {columns.map((column) => {
        const isTarget = dragging && dropTarget?.sectionId === column.id;
        return (
          <section
            key={column.id ?? "none"}
            aria-label={column.section?.name ?? "No section"}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              // Cards set precise targets; the column only claims the drop when entering it.
              setDropTarget((current) =>
                current?.sectionId === column.id ? current : { sectionId: column.id, beforeId: null },
              );
            }}
            onDrop={handleDrop}
            className={`flex max-h-full w-72 shrink-0 flex-col rounded-xl border p-2 transition-colors ${
              isTarget ? "border-accent-200 bg-accent-50" : "border-transparent bg-zinc-100/70"
            }`}
          >
            <header className="flex items-center gap-1 px-1 pb-2">
              {column.section ? (
                <SectionTitle section={column.section} count={column.tasks.length} />
              ) : (
                <span className="flex flex-1 items-center gap-2 px-1 text-sm font-semibold text-zinc-500">
                  No section
                  <span className="text-xs font-normal tabular-nums text-zinc-400">
                    {column.tasks.length}
                  </span>
                </span>
              )}
            </header>

            <ol className="flex min-h-8 flex-col gap-2 overflow-y-auto">
              {column.tasks.map((task) => (
                <li
                  key={task.id}
                  onDragOver={(e) => {
                    if (!dragging || dragging === task.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY > rect.top + rect.height / 2;
                    const index = column.tasks.findIndex((t) => t.id === task.id);
                    const beforeId = after ? (column.tasks[index + 1]?.id ?? null) : task.id;
                    setDropTarget({ sectionId: column.id, beforeId });
                  }}
                >
                  {dragging && dropTarget?.sectionId === column.id && dropTarget.beforeId === task.id ? (
                    <DropIndicator />
                  ) : null}
                  <TaskCard
                    task={task}
                    assignee={task.assigneeId ? profilesById.get(task.assigneeId) : undefined}
                    open={openTaskId === task.id}
                    dragging={dragging === task.id}
                    sectionId={column.id}
                    sectionOptions={sectionOptions}
                    onToggle={() => toggle(task)}
                    onMove={(sectionId) => move(task, { sectionId, beforeId: null })}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, task.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(task.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                  />
                </li>
              ))}
              {isTarget && dropTarget?.beforeId === null ? <DropIndicator /> : null}
            </ol>

            {column.tasks.length === 0 && !isTarget ? (
              <p className="px-2 pb-1 text-xs text-zinc-400">
                {dragging ? "Drop here" : "No tasks yet. Add one below or drag a card here."}
              </p>
            ) : null}

            <div className="pt-2">
              <AddTaskInput projectId={projectId} sectionId={column.id} variant="card" />
            </div>
          </section>
        );
      })}

      <AddSection projectId={projectId} variant="board" />
    </div>
  );
}

function DropIndicator() {
  return <div aria-hidden className="mb-2 h-0.5 rounded-full bg-accent-500" />;
}

function TaskCard({
  task,
  assignee,
  open,
  dragging,
  sectionId,
  sectionOptions,
  onToggle,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  task: ProjectTask;
  assignee: Profile | undefined;
  open: boolean;
  dragging: boolean;
  sectionId: string | null;
  sectionOptions: { id: string | null; name: string }[];
  onToggle: () => void;
  onMove: (sectionId: string | null) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const taskHref = useTaskHref();
  const completed = Boolean(task.completedAt);

  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`group relative rounded-lg border bg-white p-3 shadow-xs transition ${
        open ? "border-accent-500 ring-2 ring-accent-100" : "border-zinc-200 hover:border-zinc-300"
      } ${dragging ? "opacity-40" : ""} cursor-grab active:cursor-grabbing`}
    >
      <div className="flex items-start gap-2">
        <span className="pt-0.5">
          <CompleteToggle
            size="sm"
            completed={completed}
            onToggle={onToggle}
            label={completed ? `Mark “${task.title}” incomplete` : `Mark “${task.title}” complete`}
          />
        </span>
        <Link
          href={taskHref(task.id)}
          scroll={false}
          draggable={false}
          className={`min-w-0 flex-1 text-sm leading-snug break-words hover:underline ${
            completed ? "text-zinc-400 line-through" : "text-zinc-900"
          }`}
        >
          {task.title}
        </Link>
      </div>

      {task.dueOn || task.subtaskCount > 0 || task.projectCount > 1 || assignee ? (
        <div className="mt-2.5 flex items-center gap-2.5 pl-6">
          <DueDate task={task} />
          <TaskBadges task={task} />
          <span className="ml-auto">
            <Assignee profile={assignee} />
          </span>
        </div>
      ) : null}

      <label className="sr-only" htmlFor={`move-${task.id}`}>
        Move “{task.title}” to section
      </label>
      <select
        id={`move-${task.id}`}
        value={sectionId ?? ""}
        onChange={(e) => onMove(e.target.value || null)}
        className="absolute right-2 top-2 max-w-28 rounded border border-zinc-200 bg-white py-0.5 pl-1 text-xs text-zinc-600 opacity-0 shadow-xs focus:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        {sectionOptions.map((option) => (
          <option key={option.id ?? "none"} value={option.id ?? ""}>
            {option.name}
          </option>
        ))}
      </select>
    </article>
  );
}
