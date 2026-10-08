"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition, type DragEvent } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, ListTodo, SearchX } from "lucide-react";
import { BulkBar, useBulkEdit, type BulkContext } from "@/components/bulk/bulk-bar";
import { useTaskSelection, type TaskSelection } from "@/components/bulk/use-task-selection";
import { CompleteToggle, kindToggleLabel } from "@/components/complete-toggle";
import { approvalOpen } from "@/lib/task-kinds";
import { useCan } from "@/components/project/project-access";
import { scrollRowIntoView, useListKeys } from "@/components/shortcuts/keyboard";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { placeSection, placeTask, saveListColumnWidths, setTaskCompleted } from "@/lib/actions";
import {
  MAX_COLUMN_WIDTH,
  clampColumnWidth,
  columnWidth,
  type ColumnWidthKey,
  type ColumnWidths,
} from "@/lib/column-widths";
import type { Profile, ProjectTask, Section, SubtaskItem } from "@/lib/data";
import { subtasksByParent } from "@/lib/subtasks";
import { OPTION_COLOR_CLASSES, type FieldDef } from "@/lib/fields";
import { columnsOf, groupOf, hasActiveFilters, refFieldId, sortOf, type ColumnKey, type ViewConfig } from "@/lib/views";
import { FieldValueChips, type FieldContext } from "./field-chips";
import { ADD_TASK_EVENT, AddSection, AddTaskInput, SectionTitle, useTaskHref } from "./shared";
import { Assignee, DueDate, StartDate, TaskBadges } from "./task-meta";
import { sortOrderFor, useProjectTasks } from "./use-project-tasks";
import { groupTasks, type TaskGroup } from "./view-groups";
import { TagChips } from "@/components/tags/tag-chip";
import type { Tag } from "@/lib/tags";

type Props = {
  projectId: string;
  sections: Section[];
  tasks: ProjectTask[];
  profiles: Profile[];
  fields: FieldDef[];
  config: ViewConfig;
  openTaskId: string | null;
  bulk?: Omit<BulkContext, "project">;
  // “Show subtasks” on: every listed task's subtask tree (null = off).
  subtasks?: SubtaskItem[] | null;
  tags: Tag[];
  // The viewer's own saved column widths for this project (list_column_widths).
  columnWidths?: ColumnWidths;
};

type TaskDrop = { groupKey: string; beforeId: string | null };
type SectionDrop = { beforeId: string | null };

const TASK_DRAG = "application/x-alhc-task";
const SECTION_DRAG = "application/x-alhc-section";
const GRID = "grid items-stretch";
// The List header sticks under the toolbar while rows scroll (the page's <main> is the scroller); the
// Task column sticks to the left while the other columns scroll sideways.
const HEADER = "sticky top-0 z-20 border-b border-zinc-200 bg-white text-xs font-medium text-zinc-500";
const CELL = "flex min-w-0 items-center px-2";
const STICKY_CELL = "sticky left-0 z-[1] border-r border-zinc-100";

function sortSections(list: Section[], change: { id: string; sortOrder: number }) {
  return list
    .map((s) => (s.id === change.id ? { ...s, sort_order: change.sortOrder } : s))
    .sort((a, b) => a.sort_order - b.sort_order);
}

export function ListView({
  projectId,
  sections,
  tasks,
  profiles,
  fields,
  config,
  openTaskId,
  bulk,
  subtasks = null,
  tags,
  columnWidths = {},
}: Props) {
  const router = useRouter();
  const taskHref = useTaskHref();
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const [optimisticSections, moveSectionLocally] = useOptimistic(sections, sortSections);
  const [, run] = useServerAction();
  const notify = useNotify();
  const [, startTransition] = useTransition();
  const bulkEdit = useBulkEdit();
  const canEdit = useCan("editor");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [quickAdd, setQuickAdd] = useState<{ groupKey: string; nonce: number } | null>(null);
  const [draggingTask, setDraggingTask] = useState<string | null>(null);
  const [taskDrop, setTaskDrop] = useState<TaskDrop | null>(null);
  const [draggingSection, setDraggingSection] = useState<string | null>(null);
  const [sectionDrop, setSectionDrop] = useState<SectionDrop | null>(null);
  // The toolbar's "+ Add task" opens an add row at the top of the first section.
  const [topAdd, setTopAdd] = useState<number | null>(null);
  const [widths, setWidths] = useState<ColumnWidths>(columnWidths);
  const widthsRef = useRef(widths);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    widthsRef.current = widths;
  }, [widths]);

  useEffect(() => {
    const onAdd = () => setTopAdd((n) => (n ?? 0) + 1);
    window.addEventListener(ADD_TASK_EVENT, onAdd);
    return () => window.removeEventListener(ADD_TASK_EVENT, onAdd);
  }, []);

  const resizeColumn = (key: ColumnWidthKey, width: number | null) =>
    setWidths((current) => {
      const next = { ...current };
      if (width === null) delete next[key];
      else next[key] = clampColumnWidth(key, width);
      return next;
    });
  // Saved per person per project, a moment after the last change (the effect above has run by then).
  const commitWidths = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      startTransition(async () => {
        const result = await saveListColumnWidths(projectId, widthsRef.current);
        if (result.error) notify(result.error);
      });
    }, 400);
  };

  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const groups = groupTasks(optimisticTasks, config, { sections: optimisticSections, profilesById, fields, tags });
  const tagsById = new Map(tags.map((t) => [t.id, t] as const));
  const bySection = groupOf(config) === "section";
  // Precise drop positions only make sense in manual (sort_order) order, like Board.
  const manualOrder = bySection && sortOf(config)[0]?.key === "manual";
  const canDragTasks = canEdit && manualOrder;
  const canDragSections = canEdit && bySection && !config.filters?.sections;
  const filtered = hasActiveFilters(config.filters);

  const allIds = groups.flatMap((g) => g.tasks.map((t) => t.id));
  const navIds = groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.tasks.map((t) => t.id));
  const selection = useTaskSelection(allIds, navIds);
  const tasksById = new Map(optimisticTasks.map((t) => [t.id, t]));

  const toggle = (task: ProjectTask) => {
    const completed = !task.completedAt;
    run(
      () => setTaskCompleted(task.id, completed),
      () => applyChange({ type: "complete", taskId: task.id, completed }),
    );
  };

  // Shortcuts act on the selection, else the task open in the pane, else the keyboard cursor.
  const targets = () => {
    if (selection.selected.length) return selection.selected;
    const one = openTaskId && tasksById.has(openTaskId) ? openTaskId : selection.active;
    return one ? [one] : [];
  };

  useListKeys({
    move(delta, extend) {
      const next = selection.move(delta, extend);
      if (next) requestAnimationFrame(() => scrollRowIntoView(next));
    },
    open() {
      const id = selection.active ?? (selection.selected.length === 1 ? selection.selected[0] : null);
      if (id) router.push(taskHref(id), { scroll: false });
    },
    escape() {
      if (openTaskId) return false; // the pane closes itself
      if (selection.selected.length === 0) return false;
      selection.clear();
      return true;
    },
    complete() {
      const ids = targets();
      if (ids.length === 0) return;
      const completed = !ids.every((id) => tasksById.get(id)?.completedAt);
      bulkEdit.apply(ids, { action: completed ? "complete" : "reopen" }, () => {
        if (canEdit) for (const taskId of ids) applyChange({ type: "complete", taskId, completed });
      });
    },
    quickAdd() {
      if (!canEdit) return;
      const activeTask = selection.active ? tasksById.get(selection.active) : undefined;
      const group =
        groups.find((g) => g.target.kind === "section" && activeTask && g.tasks.includes(activeTask)) ??
        groups.find((g) => g.target.kind === "section");
      if (!group) return;
      setCollapsed((c) => {
        const next = new Set(c);
        next.delete(group.key);
        return next;
      });
      setQuickAdd((q) => ({ groupKey: group.key, nonce: (q?.nonce ?? 0) + 1 }));
    },
    assignToMe() {
      const ids = targets();
      if (ids.length === 0 || !bulk) return;
      const me = bulk.viewerId;
      bulkEdit.apply(ids, { action: "assign", assignee_id: me }, () => {
        if (canEdit) for (const taskId of ids) applyChange({ type: "assign", taskId, assigneeId: me });
      });
    },
  });

  function dropTask(event: DragEvent) {
    event.preventDefault();
    const taskId = event.dataTransfer.getData(TASK_DRAG);
    const task = tasksById.get(taskId);
    const group = groups.find((g) => g.key === taskDrop?.groupKey);
    const beforeId = taskDrop?.beforeId ?? null;
    setDraggingTask(null);
    setTaskDrop(null);
    if (!task || !group || group.target.kind !== "section" || beforeId === task.id) return;
    const sectionId = group.target.sectionId;
    const sortOrder = sortOrderFor(group.tasks, beforeId, task.id);
    run(
      () => placeTask(task.id, projectId, sectionId, beforeId),
      () => applyChange({ type: "move", taskId: task.id, sectionId, sortOrder }),
    );
  }

  function moveSection(sectionId: string, beforeId: string | null) {
    if (beforeId === sectionId) return;
    const others = optimisticSections.filter((s) => s.id !== sectionId);
    const index = beforeId ? others.findIndex((s) => s.id === beforeId) : -1;
    const next = index === -1 ? null : others[index].sort_order;
    const prev = index === -1 ? (others.at(-1)?.sort_order ?? 0) : index > 0 ? others[index - 1].sort_order : null;
    const sortOrder = next === null ? (prev ?? 0) + 1024 : prev === null ? next - 1024 : (prev + next) / 2;
    startTransition(async () => {
      moveSectionLocally({ id: sectionId, sortOrder });
      const result = await placeSection(sectionId, beforeId);
      if (result.error) notify(result.error);
    });
  }

  function dropSection(event: DragEvent) {
    event.preventDefault();
    const sectionId = event.dataTransfer.getData(SECTION_DRAG);
    const target = sectionDrop;
    setDraggingSection(null);
    setSectionDrop(null);
    if (sectionId && target) moveSection(sectionId, target.beforeId);
  }

  const columns = columnsOf(config, fields).filter(
    (c) => !c.startsWith("field:") || fieldsById.has(refFieldId(c) ?? ""),
  );
  // Fixed pixel tracks (dragged to size) plus a filler, so the rows fill the page and scroll sideways
  // once the columns are wider than it.
  const gridStyle = {
    gridTemplateColumns: [
      `${columnWidth(widths, "task")}px`,
      ...columns.map((c) => `${columnWidth(widths, c)}px`),
      "minmax(1.5rem,1fr)",
    ].join(" "),
  };
  const tagsInline = !columns.includes("tags");
  const fieldContext: FieldContext = {
    profilesById,
    sectionNames: new Map(optimisticSections.map((s) => [s.id, s.name])),
  };
  const rowProps = {
    profilesById,
    tagsById,
    openTaskId,
    onToggle: toggle,
    canEdit,
    columns,
    fieldsById,
    fieldContext,
    gridStyle,
    selection,
    selecting: selection.selected.length > 0,
    tagsInline,
  };
  const sectionGroups = groups.filter((g) => g.section);
  const childrenOf = subtasks ? subtasksByParent(subtasks) : null;
  const toggleSubtask = (subtask: SubtaskItem) => run(() => setTaskCompleted(subtask.id, !subtask.completedAt));

  return (
    <div className="min-w-full px-gutter pb-24" style={{ width: "max-content" }}>
      <div className={`${GRID} ${HEADER}`} style={gridStyle}>
        <HeaderCell
          label="Task"
          className={`${STICKY_CELL} z-[2] bg-white ${canEdit ? "pl-[3.25rem]" : "pl-9"}`}
          width={columnWidth(widths, "task")}
          onResize={(w) => resizeColumn("task", w)}
          onReset={() => resizeColumn("task", null)}
          onCommit={commitWidths}
        />
        {columns.map((column) => (
          <HeaderCell
            key={column}
            label={columnLabel(column, fieldsById)}
            width={columnWidth(widths, column)}
            onResize={(w) => resizeColumn(column, w)}
            onReset={() => resizeColumn(column, null)}
            onCommit={commitWidths}
          />
        ))}
        <span aria-hidden />
      </div>

      {sections.length === 0 && tasks.length === 0 && !filtered ? (
        <div className="mt-6">
          <EmptyState icon={ListTodo} title="This project is empty">
            {canEdit
              ? "Add a section to group work (for example “Backlog” or “This week”), then add tasks to it. You can also add tasks without a section."
              : "No tasks have been added yet. Editors of this project can add sections and tasks."}
          </EmptyState>
        </div>
      ) : null}

      {filtered && optimisticTasks.length === 0 ? (
        <div className="mt-6">
          <EmptyState icon={SearchX} title="No tasks match this view’s filters" size="inline">
            Remove a filter chip above, or use Reset to go back to the saved view.
          </EmptyState>
        </div>
      ) : null}

      {groups.map((group) => {
        const sectionIndex = group.section ? sectionGroups.indexOf(group) : -1;
        // The toolbar's "+ Add task" targets the first section group (top of the list).
        const topTarget = topAdd !== null && group.target.kind === "section" && group === groups.find((g) => g.target.kind === "section");
        const firstByOrder = [...group.tasks].sort((a, b) => a.sortOrder - b.sortOrder)[0];
        const isTaskTarget = draggingTask !== null && taskDrop?.groupKey === group.key;
        const sectionId = group.section?.id;
        return (
          <SectionGroup
            key={group.key}
            title={<GroupTitle group={group} />}
            collapsed={collapsed.has(group.key)}
            onToggleCollapsed={() =>
              setCollapsed((c) => {
                const next = new Set(c);
                if (next.has(group.key)) next.delete(group.key);
                else next.add(group.key);
                return next;
              })
            }
            highlight={isTaskTarget && taskDrop?.beforeId === null}
            sectionDropBefore={draggingSection !== null && sectionDrop?.beforeId === sectionId && sectionId !== undefined}
            sectionControls={
              canDragSections && group.section && sectionId ? (
                <SectionMoveControls
                  name={group.section.name}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(SECTION_DRAG, sectionId);
                    e.dataTransfer.effectAllowed = "move";
                    setDraggingSection(sectionId);
                  }}
                  onDragEnd={() => {
                    setDraggingSection(null);
                    setSectionDrop(null);
                  }}
                  onUp={
                    sectionIndex > 0 ? () => moveSection(sectionId, sectionGroups[sectionIndex - 1].section!.id) : undefined
                  }
                  onDown={
                    sectionIndex < sectionGroups.length - 1
                      ? () => moveSection(sectionId, sectionGroups[sectionIndex + 2]?.section?.id ?? null)
                      : undefined
                  }
                />
              ) : null
            }
            onHeaderDragOver={(e) => {
              if (draggingSection && sectionId && draggingSection !== sectionId) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = e.currentTarget.getBoundingClientRect();
                const after = e.clientY > rect.top + rect.height / 2;
                const beforeId = after ? (sectionGroups[sectionIndex + 1]?.section?.id ?? null) : sectionId;
                setSectionDrop({ beforeId });
              }
            }}
            onHeaderDrop={draggingSection ? dropSection : undefined}
            onBodyDragOver={(e) => {
              if (!draggingTask || group.target.kind !== "section") return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setTaskDrop((current) => (current?.groupKey === group.key ? current : { groupKey: group.key, beforeId: null }));
            }}
            // Row drops bubble here too; the row only refines the position during dragover.
            onBodyDrop={draggingTask ? dropTask : undefined}
          >
            {topTarget && group.target.kind === "section" ? (
              <div className="sticky left-0 w-[min(100%,48rem)]">
                <AddTaskInput
                  key={`top-${topAdd}`}
                  projectId={projectId}
                  sectionId={group.target.sectionId}
                  variant="row"
                  defaultOpen
                  beforeTaskId={firstByOrder?.id ?? null}
                  onClose={() => setTopAdd(null)}
                />
              </div>
            ) : null}
            {group.tasks.map((task, index) => (
              <div
                key={task.id}
                onDragOver={(e) => {
                  if (!draggingTask || draggingTask === task.id || group.target.kind !== "section") return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > rect.top + rect.height / 2;
                  setTaskDrop({ groupKey: group.key, beforeId: after ? (group.tasks[index + 1]?.id ?? null) : task.id });
                }}
              >
                {isTaskTarget && taskDrop?.beforeId === task.id ? <DropLine /> : null}
                <TaskRow
                  task={task}
                  {...rowProps}
                  draggable={canDragTasks}
                  dragging={draggingTask === task.id}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(TASK_DRAG, task.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDraggingTask(task.id);
                  }}
                  onDragEnd={() => {
                    setDraggingTask(null);
                    setTaskDrop(null);
                  }}
                />
                {childrenOf ? (
                  <SubtaskRows
                    parentId={task.id}
                    depth={1}
                    childrenOf={childrenOf}
                    profilesById={profilesById}
                    openTaskId={openTaskId}
                    canEdit={canEdit}
                    columns={columns}
                    gridStyle={gridStyle}
                    onToggle={toggleSubtask}
                  />
                ) : null}
              </div>
            ))}
            {isTaskTarget && taskDrop?.beforeId === null && group.tasks.length > 0 ? <DropLine /> : null}
            {group.section && group.tasks.length === 0 && (draggingTask || filtered || !canEdit) ? (
              <p className="sticky left-0 flex min-h-row items-center border-b border-zinc-100 pl-10 text-xs text-zinc-400">
                {draggingTask ? "Drop here" : filtered ? "No matching tasks in this section." : "No tasks in this section yet."}
              </p>
            ) : null}
            {group.target.kind === "section" ? (
              // Asana's inline "Add task…" row at the end of every section.
              <div className="sticky left-0 w-[min(100%,48rem)]">
                <AddTaskInput
                  key={quickAdd?.groupKey === group.key ? `quick-${quickAdd.nonce}` : "add"}
                  projectId={projectId}
                  sectionId={group.target.sectionId}
                  variant="row"
                  defaultOpen={quickAdd?.groupKey === group.key}
                />
              </div>
            ) : null}
          </SectionGroup>
        );
      })}

      {draggingSection ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setSectionDrop({ beforeId: null });
          }}
          onDrop={dropSection}
          className={`mt-2 rounded-md border border-dashed px-3 py-2 text-xs ${
            sectionDrop?.beforeId === null ? "border-accent-500 bg-accent-50 text-accent-700" : "border-zinc-300 text-zinc-400"
          }`}
        >
          Drop here to move the section to the end
        </div>
      ) : null}

      {bySection ? (
        <div className="mt-4">
          <AddSection projectId={projectId} variant="list" />
        </div>
      ) : null}

      {bulk ? (
        <BulkBar
          selected={canEdit ? selection.selected : []}
          completedCount={selection.selected.filter((id) => tasksById.get(id)?.completedAt).length}
          context={{ ...bulk, project: { id: projectId, sections: optimisticSections, fields } }}
          bulk={bulkEdit}
          onClear={selection.clear}
        />
      ) : null}
    </div>
  );
}

function DropLine() {
  return <div aria-hidden className="h-0.5 rounded-full bg-accent-500" />;
}

function columnLabel(column: ColumnKey, fieldsById: Map<string, FieldDef>) {
  if (column === "assignee") return "Assignee";
  if (column === "due") return "Due date";
  if (column === "start") return "Start";
  if (column === "section") return "Section";
  if (column === "tags") return "Tags";
  return fieldsById.get(refFieldId(column) ?? "")?.name ?? "";
}

export function GroupTitle({ group }: { group: TaskGroup }) {
  if (group.section) return <SectionTitle section={group.section} count={group.tasks.length} />;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 px-1 text-sm font-semibold text-zinc-900">
      {group.color ? (
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${OPTION_COLOR_CLASSES[group.color]}`}>
          {group.label}
        </span>
      ) : (
        <span className={group.target.kind === "section" ? "text-zinc-500" : undefined}>{group.label}</span>
      )}
      <span className="text-xs font-normal tabular-nums text-zinc-400">{group.tasks.length}</span>
    </span>
  );
}

// Drag handle plus keyboard-reachable Move up / Move down buttons for a section.
function SectionMoveControls({
  name,
  onDragStart,
  onDragEnd,
  onUp,
  onDown,
}: {
  name: string;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const reveal = "opacity-0 focus-visible:opacity-100 group-hover/section:opacity-100 [@media(hover:none)]:opacity-100";
  return (
    <span className="flex shrink-0 items-center">
      <span
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title="Drag to reorder"
        aria-hidden
        className={`cursor-grab rounded p-0.5 text-zinc-400 hover:bg-zinc-100 active:cursor-grabbing ${reveal}`}
      >
        <GripVertical className="size-4" />
      </span>
      {onUp ? (
        <button type="button" onClick={onUp} aria-label={`Move section ${name} up`} title="Move up" className={`rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 ${reveal}`}>
          <ArrowUp className="size-3.5" />
        </button>
      ) : null}
      {onDown ? (
        <button type="button" onClick={onDown} aria-label={`Move section ${name} down`} title="Move down" className={`rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 ${reveal}`}>
          <ArrowDown className="size-3.5" />
        </button>
      ) : null}
    </span>
  );
}

function SectionGroup({
  title,
  collapsed,
  onToggleCollapsed,
  highlight,
  sectionDropBefore,
  sectionControls,
  onHeaderDragOver,
  onHeaderDrop,
  onBodyDragOver,
  onBodyDrop,
  children,
}: {
  title: React.ReactNode;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  highlight: boolean;
  sectionDropBefore: boolean;
  sectionControls: React.ReactNode;
  onHeaderDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onHeaderDrop?: (e: DragEvent) => void;
  onBodyDragOver: (e: DragEvent<HTMLElement>) => void;
  onBodyDrop?: (e: DragEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="group/section mt-4" onDragOver={onBodyDragOver} onDrop={onBodyDrop}>
      {sectionDropBefore ? <DropLine /> : null}
      <div
        className="sticky left-0 flex h-8 w-[min(100%,48rem)] items-center gap-1 px-1"
        onDragOver={onHeaderDragOver}
        onDrop={onHeaderDrop}
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand group" : "Collapse group"}
          className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        {title}
        {sectionControls}
      </div>
      {collapsed ? null : (
        <div className={`border-t border-zinc-200 ${highlight ? "bg-accent-50/40" : ""}`}>{children}</div>
      )}
    </section>
  );
}

// A resizable column header: drag the right edge (or focus it and use ←/→), double-click to reset.
function HeaderCell({
  label,
  width,
  className = "",
  onResize,
  onReset,
  onCommit,
}: {
  label: string;
  width: number;
  className?: string;
  onResize: (width: number) => void;
  onReset: () => void;
  onCommit: () => void;
}) {
  return (
    <div className={`relative ${CELL} h-8 ${className}`}>
      <span className="truncate">{label}</span>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize the ${label} column`}
        aria-valuenow={width}
        aria-valuemax={MAX_COLUMN_WIDTH}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => {
          e.preventDefault();
          const handle = e.currentTarget;
          const startX = e.clientX;
          handle.setPointerCapture(e.pointerId);
          const move = (event: PointerEvent) => onResize(width + event.clientX - startX);
          const up = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
            onCommit();
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", up);
          handle.addEventListener("pointercancel", up);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          e.stopPropagation();
          onResize(width + (e.key === "ArrowRight" ? 16 : -16));
          onCommit();
        }}
        onDoubleClick={() => {
          onReset();
          onCommit();
        }}
        className="absolute -right-1 top-1 bottom-1 z-[3] w-2 cursor-col-resize touch-none rounded after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-zinc-200 hover:after:w-0.5 hover:after:bg-accent-400 focus-visible:outline-2 focus-visible:outline-accent-500"
      />
    </div>
  );
}

function TaskRow({
  task,
  profilesById,
  tagsById,
  openTaskId,
  onToggle,
  canEdit,
  columns,
  fieldsById,
  fieldContext,
  gridStyle,
  selection,
  selecting,
  tagsInline,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  task: ProjectTask;
  profilesById: Map<string, Profile>;
  tagsById: Map<string, Tag>;
  openTaskId: string | null;
  onToggle: (task: ProjectTask) => void;
  canEdit: boolean;
  columns: ColumnKey[];
  fieldsById: Map<string, FieldDef>;
  fieldContext: FieldContext;
  gridStyle: React.CSSProperties;
  selection: TaskSelection;
  selecting: boolean;
  tagsInline: boolean;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const router = useRouter();
  const taskHref = useTaskHref();
  const completed = Boolean(task.completedAt);
  const assignee = task.assigneeId ? profilesById.get(task.assigneeId) : undefined;
  const open = openTaskId === task.id;
  const selected = selection.isSelected(task.id);
  const active = selection.active === task.id;
  // The sticky Task cell needs an opaque background of its own.
  const tone = selected || open ? "bg-accent-50" : "bg-white group-hover:bg-zinc-50";

  return (
    <div
      data-task-row={task.id}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // no text selection on Shift-click ranges
      }}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const control = target.closest("a, button, input, select, textarea, label");
        const modified = e.shiftKey || e.metaKey || e.ctrlKey;
        if (control && !(control.tagName === "A" && modified)) {
          if (control.tagName === "A") selection.setActive(task.id);
          return;
        }
        e.preventDefault();
        // Shift / ⌘ / Ctrl-click still multi-select (like Asana); a plain click opens the task.
        if (modified) {
          selection.click(task.id, e);
          return;
        }
        selection.setActive(task.id);
        if (!open) router.push(taskHref(task.id), { scroll: false });
      }}
      className={`group ${GRID} min-h-row cursor-pointer border-b border-zinc-100 ${
        selected || open ? "bg-accent-50" : "hover:bg-zinc-50"
      } ${dragging ? "opacity-40" : ""} ${draggable ? "active:cursor-grabbing" : ""}`}
      style={gridStyle}
    >
      <div
        className={`${CELL} ${STICKY_CELL} gap-2.5 py-1 pl-3 ${tone} ${
          active ? "shadow-[inset_2px_0_0_var(--color-accent-500)]" : ""
        }`}
      >
        {canEdit ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => undefined}
            onClick={(e) => {
              e.stopPropagation();
              selection.toggle(task.id, e.shiftKey);
            }}
            aria-label={`Select “${task.title}”`}
            className={`size-3.5 shrink-0 rounded border-zinc-300 accent-accent-600 ${
              selected || selecting ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
            }`}
          />
        ) : null}
        <CompleteToggle
          kind={task.kind}
          completed={completed}
          disabled={!canEdit || (task.kind === "approval" && approvalOpen(task.approvalStatus))}
          onToggle={() => onToggle(task)}
          label={kindToggleLabel(task.kind, task.title, completed)}
        />
        <Link
          href={taskHref(task.id)}
          scroll={false}
          draggable={false}
          aria-current={open ? "true" : undefined}
          className={`min-w-0 truncate text-sm hover:underline ${
            completed ? "text-zinc-400 line-through" : "text-zinc-900"
          }`}
        >
          {task.title}
        </Link>
        <span className="flex shrink-0 items-center gap-2">
          <TaskBadges task={task} />
        </span>
        {tagsInline ? <TagChips ids={task.tagIds} byId={tagsById} /> : null}
      </div>
      {columns.map((column) => {
        if (column === "assignee") {
          return (
            <div key={column} className={CELL}>
              <Assignee profile={assignee} showName />
            </div>
          );
        }
        if (column === "due") {
          return (
            <div key={column} className={CELL}>
              <DueDate task={task} />
            </div>
          );
        }
        if (column === "start") {
          return (
            <div key={column} className={CELL}>
              <StartDate task={task} />
            </div>
          );
        }
        if (column === "section") {
          return (
            <div key={column} className={`${CELL} text-xs text-zinc-600`}>
              <span className="truncate">{task.sectionId ? fieldContext.sectionNames.get(task.sectionId) : ""}</span>
            </div>
          );
        }
        if (column === "tags") {
          return (
            <div key={column} className={`${CELL} overflow-hidden`}>
              <TagChips ids={task.tagIds} byId={tagsById} />
            </div>
          );
        }
        const field = fieldsById.get(refFieldId(column) ?? "");
        return (
          <div key={column} className={CELL}>
            {field ? <FieldValueChips field={field} task={task} context={fieldContext} showName /> : null}
          </div>
        );
      })}
      <span aria-hidden />
    </div>
  );
}

// “Show subtasks”: a task's subtasks (all levels) under its row, indented, read-only apart from
// completing them; open one to edit it in the pane. Subtasks aren't selected, dragged, or filtered —
// they follow their task.
function SubtaskRows({
  parentId,
  depth,
  childrenOf,
  profilesById,
  openTaskId,
  canEdit,
  columns,
  gridStyle,
  onToggle,
}: {
  parentId: string;
  depth: number;
  childrenOf: Map<string, SubtaskItem[]>;
  profilesById: Map<string, Profile>;
  openTaskId: string | null;
  canEdit: boolean;
  columns: ColumnKey[];
  gridStyle: React.CSSProperties;
  onToggle: (subtask: SubtaskItem) => void;
}) {
  const router = useRouter();
  const taskHref = useTaskHref();
  const children = childrenOf.get(parentId) ?? [];
  if (children.length === 0) return null;
  return (
    <ul aria-label="Subtasks">
      {children.map((subtask) => {
        const completed = Boolean(subtask.completedAt);
        const open = openTaskId === subtask.id;
        return (
          <li key={subtask.id}>
            <div
              data-subtask-row={subtask.id}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a, button, input, select, textarea, label")) return;
                if (!open) router.push(taskHref(subtask.id), { scroll: false });
              }}
              className={`group ${GRID} min-h-row cursor-pointer border-b border-zinc-100 ${open ? "bg-accent-50" : "hover:bg-zinc-50"}`}
              style={gridStyle}
            >
              <div
                className={`${CELL} ${STICKY_CELL} gap-2.5 py-1 ${open ? "bg-accent-50" : "bg-white group-hover:bg-zinc-50"}`}
                style={{ paddingLeft: `${0.75 + (canEdit ? 1.5 : 0) + depth * 1.25}rem` }}
              >
                <CompleteToggle
                  size="sm"
                  kind={subtask.kind}
                  completed={completed}
                  disabled={!canEdit || subtask.kind === "approval"}
                  onToggle={() => onToggle(subtask)}
                  label={kindToggleLabel(subtask.kind, subtask.title, completed)}
                />
                <Link
                  href={taskHref(subtask.id)}
                  scroll={false}
                  aria-current={open ? "true" : undefined}
                  className={`min-w-0 truncate text-sm hover:underline ${completed ? "text-zinc-400 line-through" : "text-zinc-700"}`}
                >
                  <span className="sr-only">Subtask: </span>
                  {subtask.title}
                </Link>
                {subtask.subtaskCount > 0 ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-zinc-500"
                    title={`${subtask.subtaskDoneCount} of ${subtask.subtaskCount} subtasks done`}
                  >
                    {subtask.subtaskDoneCount}/{subtask.subtaskCount}
                  </span>
                ) : null}
              </div>
              {columns.map((column) => (
                <div key={column} className={CELL}>
                  {column === "assignee" ? (
                    <Assignee profile={subtask.assigneeId ? profilesById.get(subtask.assigneeId) : undefined} showName />
                  ) : column === "due" ? (
                    <DueDate task={subtask} />
                  ) : column === "start" ? (
                    <StartDate task={subtask} />
                  ) : null}
                </div>
              ))}
              <span aria-hidden />
            </div>
            <SubtaskRows
              parentId={subtask.id}
              depth={depth + 1}
              childrenOf={childrenOf}
              profilesById={profilesById}
              openTaskId={openTaskId}
              canEdit={canEdit}
              columns={columns}
              gridStyle={gridStyle}
              onToggle={onToggle}
            />
          </li>
        );
      })}
    </ul>
  );
}
