"use client";

import Link from "next/link";
import { useEffect, useState, type DragEvent } from "react";
import { CompleteToggle, kindToggleLabel } from "@/components/complete-toggle";
import { approvalOpen, type TaskKind } from "@/lib/task-kinds";
import { useCan } from "@/components/project/project-access";
import { useServerAction } from "@/components/toast";
import { moveTask, moveTaskTag, placeTask, setFieldValue, setTaskCompleted, updateTask } from "@/lib/actions";
import { TagChips } from "@/components/tags/tag-chip";
import type { Tag } from "@/lib/tags";
import type { Profile, ProjectTask, Section } from "@/lib/data";
import type { FieldDef } from "@/lib/fields";
import { columnsOf, groupOf, refFieldId, sortOf, type ViewConfig } from "@/lib/views";
import { FieldValueChips, type FieldContext } from "./field-chips";
import { GroupTitle } from "./list-view";
import { ADD_TASK_EVENT, AddSection, AddTaskInput, SectionActions, addTaskKindOf, useTaskHref } from "./shared";
import { Assignee, CommentCount, DueDate, StartDate, TaskBadges } from "./task-meta";
import { sortOrderFor, useProjectTasks } from "./use-project-tasks";
import { groupTasks, type TaskGroup } from "./view-groups";

type Props = {
  projectId: string;
  sections: Section[];
  tasks: ProjectTask[];
  profiles: Profile[];
  fields: FieldDef[];
  config: ViewConfig;
  openTaskId: string | null;
  tags: Tag[];
  // Every task per section, whatever the view shows (a section can be deleted only when empty).
  sectionTaskCounts?: Record<string, number>;
};

type DropTarget = { groupKey: string; beforeId: string | null };
// The add box opened at the top of a column: the toolbar's "+ Add task" / "Add milestone" (the first
// section column, groupKey null) or a column header's "+".
type TopAdd = { groupKey: string | null; nonce: number; kind: TaskKind };

const DRAG_TYPE = "application/x-alhc-task";

// Asana's Board: ~280px light-grey columns with white cards (soft shadow, 8px corners) showing the
// field pills, assignee, due date, and subtask / comment counts; "+ Add task" at the top of each column
// (and at the bottom on hover); an "Add section" column at the end.
export function BoardView({
  projectId,
  sections,
  tasks,
  profiles,
  fields,
  config,
  openTaskId,
  tags,
  sectionTaskCounts = {},
}: Props) {
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const [, run] = useServerAction();
  const canEdit = useCan("editor");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // The column a card was dragged from (grouped by tag, a task sits in several columns).
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [topAdd, setTopAdd] = useState<TopAdd | null>(null);

  useEffect(() => {
    const onAdd = (event: Event) =>
      setTopAdd((t) => ({ groupKey: null, nonce: (t?.nonce ?? 0) + 1, kind: addTaskKindOf(event) }));
    window.addEventListener(ADD_TASK_EVENT, onAdd);
    return () => window.removeEventListener(ADD_TASK_EVENT, onAdd);
  }, []);

  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const groups = groupTasks(optimisticTasks, config, { sections, profilesById, fields, tags });
  const tagsById = new Map(tags.map((t) => [t.id, t] as const));
  const groupBy = groupOf(config);
  const bySection = groupBy === "section";
  // Precise positions only make sense when cards are shown in manual (sort_order) order.
  const manualOrder = bySection && sortOf(config)[0]?.key === "manual";
  const columns = columnsOf(config, fields);
  // The column already shows the grouping value, so a field chip for it would only repeat it.
  const cardFields = columns
    .map((c) => fieldsById.get(refFieldId(c) ?? ""))
    .filter((f): f is FieldDef => Boolean(f))
    .filter((f) => !(bySection && f.boundToSections) && `field:${f.id}` !== groupBy);
  const showAssignee = columns.includes("assignee");
  const showDue = columns.includes("due");
  const showStart = columns.includes("start");
  const fieldContext: FieldContext = {
    profilesById,
    sectionNames: new Map(sections.map((s) => [s.id, s.name])),
  };
  const firstSectionGroup = groups.find((g) => g.target.kind === "section");

  // Viewers and commenters can't move cards: no drag, no "Move to" menu.
  const moveOptions = canEdit ? groups.filter((g) => g.target.kind !== "none") : [];

  function move(task: ProjectTask, group: TaskGroup, beforeId: string | null, fromKey: string | null = null) {
    const target = group.target;
    if (target.kind === "section") {
      if (beforeId === task.id) return;
      if (!manualOrder && task.sectionId === target.sectionId) return;
      const sortOrder = manualOrder
        ? sortOrderFor(group.tasks, beforeId, task.id)
        : (group.tasks.filter((t) => t.id !== task.id).at(-1)?.sortOrder ?? 0) + 1024;
      // Manual order: the database places it before `beforeId` (reindexing tiny gaps); otherwise append.
      run(
        () =>
          manualOrder
            ? placeTask(task.id, projectId, target.sectionId, beforeId)
            : moveTask(task.id, projectId, target.sectionId),
        () => applyChange({ type: "move", taskId: task.id, sectionId: target.sectionId, sortOrder }),
      );
    } else if (target.kind === "assignee") {
      if (task.assigneeId === target.assigneeId) return;
      run(
        () => updateTask(task.id, { assigneeId: target.assigneeId }),
        () => applyChange({ type: "assign", taskId: task.id, assigneeId: target.assigneeId }),
      );
    } else if (target.kind === "field") {
      if ((task.fieldValues[target.fieldId] ?? null) === target.optionId) return;
      run(
        () => setFieldValue(task.id, target.fieldId, target.optionId),
        () => applyChange({ type: "field", taskId: task.id, fieldId: target.fieldId, value: target.optionId }),
      );
    } else if (target.kind === "tag") {
      const from = groups.find((g) => g.key === fromKey)?.target;
      const fromTagId = from?.kind === "tag" ? from.tagId : null;
      if (fromTagId === target.tagId || (target.tagId && task.tagIds.includes(target.tagId) && !fromTagId)) return;
      const next = task.tagIds.filter((t) => t !== fromTagId);
      if (target.tagId && !next.includes(target.tagId)) next.push(target.tagId);
      run(
        () => moveTaskTag(task.id, fromTagId, target.tagId),
        () => applyChange({ type: "tags", taskId: task.id, tagIds: next }),
      );
    }
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
    const group = groups.find((g) => g.key === dropTarget?.groupKey);
    if (task && group && dropTarget) move(task, group, dropTarget.beforeId, dragFrom);
    setDragging(null);
    setDragFrom(null);
    setDropTarget(null);
  }

  return (
    <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-gutter py-3">
      {groups.map((group) => {
        const droppable = group.target.kind !== "none";
        const isTarget = dragging && dropTarget?.groupKey === group.key;
        const sectionId = group.section?.id;
        const topTarget =
          topAdd !== null &&
          group.target.kind === "section" &&
          (topAdd.groupKey === group.key || (topAdd.groupKey === null && group === firstSectionGroup));
        return (
          <section
            key={group.key}
            aria-label={group.label}
            onDragOver={(e) => {
              if (!dragging || !droppable) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              // Cards set precise targets; the column only claims the drop when entering it.
              setDropTarget((current) =>
                current?.groupKey === group.key ? current : { groupKey: group.key, beforeId: null },
              );
            }}
            onDrop={handleDrop}
            className={`group/section flex max-h-full w-70 shrink-0 flex-col rounded-xl p-2 transition-colors ${
              isTarget ? "bg-accent-50 ring-1 ring-accent-200" : "bg-zinc-100/70"
            }`}
          >
            <header className="flex h-8 shrink-0 items-center gap-1 pl-1">
              <GroupTitle group={group} />
              {group.section && sectionId ? (
                <SectionActions
                  projectId={projectId}
                  section={group.section}
                  taskCount={sectionTaskCounts[sectionId] ?? group.tasks.length}
                  nextSectionId={sections[sections.findIndex((s) => s.id === sectionId) + 1]?.id ?? null}
                  orientation="horizontal"
                  onAddTask={() => setTopAdd((t) => ({ groupKey: group.key, nonce: (t?.nonce ?? 0) + 1, kind: "task" }))}
                />
              ) : null}
            </header>

            {group.target.kind === "section" ? (
              <div className="pb-1.5">
                <AddTaskInput
                  key={topTarget && topAdd ? `top-${topAdd.nonce}` : "top"}
                  projectId={projectId}
                  sectionId={group.target.sectionId}
                  variant="card"
                  idSuffix="-top"
                  atTop
                  defaultOpen={topTarget}
                  defaultKind={topTarget && topAdd ? topAdd.kind : "task"}
                  onClose={topTarget ? () => setTopAdd(null) : undefined}
                />
              </div>
            ) : null}

            <ol className="flex min-h-8 flex-col gap-2 overflow-y-auto p-0.5">
              {group.tasks.map((task, index) => (
                <li
                  key={task.id}
                  onDragOver={(e) => {
                    if (!dragging || dragging === task.id || !droppable) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (!manualOrder) {
                      setDropTarget({ groupKey: group.key, beforeId: null });
                      return;
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY > rect.top + rect.height / 2;
                    const beforeId = after ? (group.tasks[index + 1]?.id ?? null) : task.id;
                    setDropTarget({ groupKey: group.key, beforeId });
                  }}
                >
                  {manualOrder && dragging && dropTarget?.groupKey === group.key && dropTarget.beforeId === task.id ? (
                    <DropIndicator />
                  ) : null}
                  <TaskCard
                    task={task}
                    assignee={showAssignee && task.assigneeId ? profilesById.get(task.assigneeId) : undefined}
                    showDue={showDue}
                    showStart={showStart}
                    open={openTaskId === task.id}
                    dragging={dragging === task.id}
                    groupKey={group.key}
                    moveOptions={moveOptions}
                    cardFields={cardFields}
                    fieldContext={fieldContext}
                    canEdit={canEdit}
                    onToggle={() => toggle(task)}
                    tagsById={tagsById}
                    onMove={(key) => {
                      const target = groups.find((g) => g.key === key);
                      if (target) move(task, target, null, group.key);
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, task.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(task.id);
                      setDragFrom(group.key);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDragFrom(null);
                      setDropTarget(null);
                    }}
                  />
                </li>
              ))}
              {isTarget && dropTarget?.beforeId === null ? <DropIndicator /> : null}
            </ol>

            {group.tasks.length === 0 && !isTarget ? (
              <p className="rounded-lg border border-dashed border-zinc-300/80 px-2 py-4 text-center text-xs text-zinc-400">
                {dragging ? "Drop here" : group.target.kind === "section" ? "No tasks yet. Add one above or drag a card here." : "No tasks"}
              </p>
            ) : null}

            {group.target.kind === "section" && group.tasks.length > 0 ? (
              // The bottom "+ Add task" shows while the column is hovered (always on touch screens).
              <div className="pt-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/section:opacity-100 [@media(hover:none)]:opacity-100">
                <AddTaskInput
                  projectId={projectId}
                  sectionId={group.target.sectionId}
                  variant="card"
                  idSuffix="-bottom"
                />
              </div>
            ) : null}
          </section>
        );
      })}

      {bySection ? <AddSection projectId={projectId} variant="board" /> : null}
    </div>
  );
}

function DropIndicator() {
  return <div aria-hidden className="mb-2 h-0.5 rounded-full bg-accent-500" />;
}

function TaskCard({
  task,
  assignee,
  showDue,
  showStart,
  open,
  dragging,
  groupKey,
  moveOptions,
  cardFields,
  fieldContext,
  canEdit,
  tagsById,
  onToggle,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  task: ProjectTask;
  assignee: Profile | undefined;
  showDue: boolean;
  showStart: boolean;
  open: boolean;
  dragging: boolean;
  groupKey: string;
  moveOptions: TaskGroup[];
  cardFields: FieldDef[];
  fieldContext: FieldContext;
  canEdit: boolean;
  tagsById: Map<string, Tag>;
  onToggle: () => void;
  onMove: (groupKey: string) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const taskHref = useTaskHref();
  const completed = Boolean(task.completedAt);
  const due = showDue && task.dueOn;
  const start = showStart && task.startOn;
  const hasCounts =
    task.approvalStatus !== null || task.recurring || task.blockedBy > 0 || task.subtaskCount > 0 || task.projectCount > 1 || task.commentCount > 0;

  return (
    <article
      draggable={moveOptions.length > 0}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`group relative rounded-lg border bg-white px-3 py-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition-[border-color,box-shadow] ${
        open ? "border-accent-500 ring-2 ring-accent-100" : "border-zinc-200/80 hover:border-zinc-300 hover:shadow-[0_2px_6px_rgb(0_0_0/0.08)]"
      } ${dragging ? "opacity-40" : ""} ${moveOptions.length > 0 ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      <div className="flex items-start gap-2">
        <span className="pt-0.5">
          <CompleteToggle
            size="sm"
            kind={task.kind}
            completed={completed}
            disabled={!canEdit || (task.kind === "approval" && approvalOpen(task.approvalStatus))}
            onToggle={onToggle}
            label={kindToggleLabel(task.kind, task.title, completed)}
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

      {cardFields.some((f) => task.fieldValues[f.id] != null || f.boundToSections) ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {cardFields.map((field) => (
            <FieldValueChips key={field.id} field={field} task={task} context={fieldContext} showName />
          ))}
        </div>
      ) : null}

      {task.tagIds.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          <TagChips ids={task.tagIds} byId={tagsById} max={4} />
        </div>
      ) : null}

      {due || start || hasCounts || assignee ? (
        <div className="mt-2.5 flex min-h-6 items-center gap-2">
          {assignee ? <Assignee profile={assignee} /> : null}
          {start ? <StartDate task={task} prefix={due ? "" : "Starts "} /> : null}
          {start && due ? <span className="-mx-1.5 text-xs text-zinc-400">–</span> : null}
          {showDue ? <DueDate task={task} /> : null}
          <span className="ml-auto flex items-center gap-2">
            <TaskBadges task={task} />
            <CommentCount count={task.commentCount} />
          </span>
        </div>
      ) : null}

      {moveOptions.length > 0 ? (
        <>
          <label className="sr-only" htmlFor={`move-${task.id}`}>
            Move “{task.title}” to
          </label>
          <select
            id={`move-${task.id}`}
            value={groupKey}
            onChange={(e) => onMove(e.target.value)}
            className="absolute right-2 top-2 max-w-28 rounded border border-zinc-200 bg-white py-0.5 pl-1 text-xs text-zinc-600 opacity-0 shadow-xs focus:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          >
            {moveOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </article>
  );
}
