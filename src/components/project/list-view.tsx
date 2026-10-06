"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition, type DragEvent } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, ListTodo, SearchX } from "lucide-react";
import { BulkBar, useBulkEdit, type BulkContext } from "@/components/bulk/bulk-bar";
import { useTaskSelection, type TaskSelection } from "@/components/bulk/use-task-selection";
import { CompleteToggle } from "@/components/complete-toggle";
import { useCan } from "@/components/project/project-access";
import { scrollRowIntoView, useListKeys } from "@/components/shortcuts/keyboard";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { placeSection, placeTask, setTaskCompleted } from "@/lib/actions";
import type { Profile, ProjectTask, Section } from "@/lib/data";
import { OPTION_COLOR_CLASSES, type FieldDef } from "@/lib/fields";
import { columnsOf, groupOf, hasActiveFilters, refFieldId, sortOf, type ColumnKey, type ViewConfig } from "@/lib/views";
import { FieldValueChips, type FieldContext } from "./field-chips";
import { AddSection, AddTaskInput, SectionTitle, useTaskHref } from "./shared";
import { Assignee, DueDate, StartDate, TaskBadges } from "./task-meta";
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
  bulk?: Omit<BulkContext, "project">;
};

type TaskDrop = { groupKey: string; beforeId: string | null };
type SectionDrop = { beforeId: string | null };

const TASK_DRAG = "application/x-alhc-task";
const SECTION_DRAG = "application/x-alhc-section";
const GRID = "grid items-center gap-3";
// The List header sticks under the toolbar while rows scroll (the page's <main> is the scroller).
const HEADER = "sticky top-0 z-10 border-b border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-500";
const COLUMN_WIDTH: Record<string, string> = { assignee: "9rem", due: "6rem", start: "6rem", section: "8rem" };

function sortSections(list: Section[], change: { id: string; sortOrder: number }) {
  return list
    .map((s) => (s.id === change.id ? { ...s, sort_order: change.sortOrder } : s))
    .sort((a, b) => a.sort_order - b.sort_order);
}

export function ListView({ projectId, sections, tasks, profiles, fields, config, openTaskId, bulk }: Props) {
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

  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const groups = groupTasks(optimisticTasks, config, { sections: optimisticSections, profilesById, fields });
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
  const gridStyle = {
    gridTemplateColumns: ["minmax(0,1fr)", ...columns.map((c) => COLUMN_WIDTH[c] ?? "8rem")].join(" "),
  };
  const fieldContext: FieldContext = {
    profilesById,
    sectionNames: new Map(optimisticSections.map((s) => [s.id, s.name])),
  };
  const rowProps = {
    profilesById,
    openTaskId,
    onToggle: toggle,
    canEdit,
    columns,
    fieldsById,
    fieldContext,
    gridStyle,
    selection,
    selecting: selection.selected.length > 0,
  };
  const sectionGroups = groups.filter((g) => g.section);

  return (
    <div className="px-gutter pb-24" style={{ minWidth: `${28 + columns.length * 8.75}rem` }}>
      <div className={`${GRID} ${HEADER}`} style={gridStyle} aria-hidden>
        <span className={canEdit ? "pl-12" : "pl-7"}>Task</span>
        {columns.map((column) => (
          <span key={column} className="truncate">
            {columnLabel(column, fieldsById)}
          </span>
        ))}
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
              </div>
            ))}
            {isTaskTarget && taskDrop?.beforeId === null && group.tasks.length > 0 ? <DropLine /> : null}
            {group.section && group.tasks.length === 0 ? (
              <p className="flex min-h-row items-center border-b border-zinc-100 pl-10 text-xs text-zinc-400">
                {draggingTask ? "Drop here" : filtered ? "No matching tasks in this section." : "No tasks in this section yet."}
              </p>
            ) : null}
            {group.target.kind === "section" ? (
              <AddTaskInput
                key={quickAdd?.groupKey === group.key ? `quick-${quickAdd.nonce}` : "add"}
                projectId={projectId}
                sectionId={group.target.sectionId}
                variant="row"
                defaultOpen={quickAdd?.groupKey === group.key}
              />
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
  if (column === "due") return "Due";
  if (column === "start") return "Start";
  if (column === "section") return "Section";
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
      <div className="flex h-8 items-center gap-1 px-1" onDragOver={onHeaderDragOver} onDrop={onHeaderDrop}>
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

function TaskRow({
  task,
  profilesById,
  openTaskId,
  onToggle,
  canEdit,
  columns,
  fieldsById,
  fieldContext,
  gridStyle,
  selection,
  selecting,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  task: ProjectTask;
  profilesById: Map<string, Profile>;
  openTaskId: string | null;
  onToggle: (task: ProjectTask) => void;
  canEdit: boolean;
  columns: ColumnKey[];
  fieldsById: Map<string, FieldDef>;
  fieldContext: FieldContext;
  gridStyle: React.CSSProperties;
  selection: TaskSelection;
  selecting: boolean;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const taskHref = useTaskHref();
  const completed = Boolean(task.completedAt);
  const assignee = task.assigneeId ? profilesById.get(task.assigneeId) : undefined;
  const open = openTaskId === task.id;
  const selected = selection.isSelected(task.id);
  const active = selection.active === task.id;

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
        selection.click(task.id, e);
      }}
      className={`group ${GRID} min-h-row border-b border-zinc-100 px-3 py-1 ${
        selected ? "bg-accent-50" : open ? "bg-accent-50/60" : "hover:bg-zinc-50"
      } ${active ? "shadow-[inset_2px_0_0_var(--color-accent-500)]" : ""} ${dragging ? "opacity-40" : ""} ${
        draggable ? "cursor-grab active:cursor-grabbing" : ""
      }`}
      style={gridStyle}
    >
      <div className="flex min-w-0 items-center gap-2.5">
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
          completed={completed}
          disabled={!canEdit}
          onToggle={() => onToggle(task)}
          label={completed ? `Mark “${task.title}” incomplete` : `Mark “${task.title}” complete`}
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
      </div>
      {columns.map((column) => {
        if (column === "assignee") {
          return (
            <div key={column} className="min-w-0">
              <Assignee profile={assignee} showName />
            </div>
          );
        }
        if (column === "due") {
          return (
            <div key={column}>
              <DueDate task={task} />
            </div>
          );
        }
        if (column === "start") {
          return (
            <div key={column}>
              <StartDate task={task} />
            </div>
          );
        }
        if (column === "section") {
          return (
            <div key={column} className="min-w-0 truncate text-xs text-zinc-600">
              {task.sectionId ? fieldContext.sectionNames.get(task.sectionId) : ""}
            </div>
          );
        }
        const field = fieldsById.get(refFieldId(column) ?? "");
        return (
          <div key={column} className="min-w-0">
            {field ? <FieldValueChips field={field} task={task} context={fieldContext} showName /> : null}
          </div>
        );
      })}
    </div>
  );
}
