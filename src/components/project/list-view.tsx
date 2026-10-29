"use client";

import { useTagsEnabled } from "@/components/tags/tags-enabled";
import { useEffect, useOptimistic, useRef, useState, useTransition, type DragEvent, type ReactNode } from "react";
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  GripVertical,
  ListTodo,
  Pencil,
  Plus,
  SearchX,
} from "lucide-react";
import { BulkBar, useBulkEdit, type BulkContext } from "@/components/bulk/bulk-bar";
import { useTaskSelection, type TaskSelection } from "@/components/bulk/use-task-selection";
import { MenuItem, Popover } from "@/components/popover";
import type { TaskKind } from "@/lib/task-kinds";
import { ShowMoreRows, useGroupPages, usePagedShowMore } from "@/components/show-more";
import { useProjectPermissions, useSectionPermissions } from "@/components/project/project-access";
import { EditFieldDialog, NewFieldDialog } from "@/components/project/field-dialog";
import { useViewConfig } from "@/components/project/view-config";
import { scrollRowIntoView, useListKeys } from "@/components/shortcuts/keyboard";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { RowCompleteControl } from "@/components/task/row-complete-control";
import { useApprovalShortcut } from "@/components/task/approval-action";
import { useDependencyShift } from "@/components/task/dependency-shift";
import { TaskLink, useOpenTask, useTaskPrefetch } from "@/components/task/task-link";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import {
  moveTask,
  placeSection,
  placeTask,
  saveListCollapsedGroups,
  saveListColumnWidths,
  setFieldValue,
  setTaskCompleted,
  updateSubtask,
  updateTask,
  type ActionResult,
} from "@/lib/actions";
import {
  MAX_COLUMN_WIDTH,
  clampColumnWidth,
  columnWidth,
  type ColumnWidthKey,
  type ColumnWidths,
} from "@/lib/column-widths";
import type { Profile, ProjectTask, ProjectTaskGroupPage, Section, SubtaskItem } from "@/lib/data";
import { displayTaskTitle, type RequestLabel } from "@/lib/request-numbers";
import { OPTION_COLOR_CLASSES, type FieldDef } from "@/lib/fields";
import type { Json } from "@/lib/supabase/database.types";
import {
  columnsOf,
  fieldRef,
  groupOf,
  hasActiveFilters,
  refFieldId,
  sameConfig,
  showsSubtasks,
  sortOf,
  type ColumnKey,
  type SortKey,
  type ViewConfig,
} from "@/lib/views";
import { FieldValueChips, type FieldContext } from "./field-chips";
import {
  ExpandToggle,
  InlineAssigneeCell,
  InlineChoiceCell,
  InlineDateCell,
  InlineFieldCell,
  blockedCount,
  blockedSkipMessage,
  flattenSubtaskRows,
  mergeDateEdit,
  splitBlocked,
  useSubtaskTrees,
  type DateEdit,
  type FlatSubtaskRow,
  type RowPatch,
  type SubtaskTrees,
} from "./inline-cells";
import { ADD_TASK_EVENT, AddSection, AddTaskInput, SectionActions, SectionTitle, addTaskKindOf } from "./shared";
import { AttachmentCount, CommentCount, DueDate, EmptyCellHint, StartDate, TaskBadges } from "./task-meta";
import {
  LIST_CELL,
  LIST_GRID,
  LIST_HEADER_ROW,
  LIST_PINNED_CELL,
  LIST_RESIZE_HANDLE,
  LIST_VIEW_WIDTH_VAR,
  NAME_INDENT,
  listGridStyle,
  listHeaderCellClass,
  subtaskIndentRem,
} from "./list-grid";
import { useProjectTaskSeeds } from "./task-seeds";
import { sortOrderFor, useProjectTasks } from "./use-project-tasks";
import { groupTasks, groupsFromPage, withPageCursors, type TaskGroup } from "./view-groups";
import { TagChips } from "@/components/tags/tag-chip";
import type { Tag } from "@/lib/tags";
import type { TaskSeed } from "@/lib/task-seed";

type Seeds = ReturnType<typeof useProjectTaskSeeds>;

type Props = {
  projectId: string;
  sections: Section[];
  tasks: ProjectTask[];
  profiles: Profile[];
  fields: FieldDef[];
  config: ViewConfig;
  // The task pane's preview shows it for a clicked row.
  projectName?: string | null;
  // Server page of cards. Null means every matching task is already in `tasks`.
  taskPage?: ProjectTaskGroupPage[] | null;
  bulk?: Omit<BulkContext, "project">;
  // The subtask trees the server loaded: every listed task's with “Show subtasks” on (the view's
  // show_subtasks), else the rows this person opened (Oct 27 notes, batch 6). Others load on opening.
  subtasks?: SubtaskItem[] | null;
  // Rows this person opened (getExpandedTaskIds(); kept per person, newest first).
  expandedTaskIds?: string[];
  tags: Tag[];
  // The viewer's own saved column widths for this project (list_column_widths).
  columnWidths?: ColumnWidths;
  // Group keys this person collapsed in this project (kept per person; Oct 26 notes, batch 4).
  collapsedGroups?: string[];
  // Every task per section, whatever the view shows (a section can be deleted only when empty).
  sectionTaskCounts?: Record<string, number>;
};

type TaskDrop = { groupKey: string; beforeId: string | null };
type SectionDrop = { beforeId: string | null };
// The inline add row opened at the top of a group: the toolbar's "+ Add task" / "Add milestone" (the
// first section, groupKey null) or a section header's "+".
type TopAdd = { groupKey: string | null; nonce: number; kind: TaskKind };

const TASK_DRAG = "application/x-alhc-task";
const SECTION_DRAG = "application/x-alhc-section";
// The grid, the pinned Name cell, and the Name cell's leading controls are defined once for the header
// and every row (list-grid.ts; Oct 29 notes, batch 7, item 53).

function sortSections(list: Section[], change: { id: string; sortOrder: number }) {
  return list
    .map((s) => (s.id === change.id ? { ...s, sort_order: change.sortOrder } : s))
    .sort((a, b) => a.sort_order - b.sort_order);
}

// What a column sorts by (Name = title); Section and Tags columns have no sort.
function sortKeyFor(column: ColumnKey | "task", fieldsById: Map<string, FieldDef>): SortKey | null {
  if (column === "task") return "title";
  if (column === "assignee" || column === "due" || column === "start") return column;
  const field = fieldsById.get(refFieldId(column) ?? "");
  return field && !field.boundToSections ? fieldRef(field.id) : null;
}

export function ListView({
  projectId,
  sections,
  tasks,
  profiles,
  fields,
  config: configProp,
  projectName = null,
  taskPage = null,
  bulk,
  subtasks = null,
  expandedTaskIds,
  tags,
  columnWidths = {},
  collapsedGroups = [],
  sectionTaskCounts = {},
}: Props) {
  // The task whose pane is open (instant: no server render on open / close; Oct 19 notes).
  const openTaskId = useOpenTaskId();
  const openTask = useOpenTask();
  const seeds = useProjectTaskSeeds({ profiles, tags, sections, fields, projectName });
  const viewConfig = useViewConfig();
  // The page's (optimistic) config: column menus apply instantly as an unsaved draft.
  const config = viewConfig?.current ?? configProp;
  const tagsOn = useTagsEnabled();
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const [optimisticSections, moveSectionLocally] = useOptimistic(sections, sortSections);
  const [, run] = useServerAction();
  const notify = useNotify();
  const [, startTransition] = useTransition();
  const bulkEdit = useBulkEdit();
  const canEdit = useProjectPermissions().canEdit;
  const who = canEdit ? "editor" : "viewer";
  // Every collapse / expand is kept for this person (saved a moment after the last change, and right
  // away when the List goes away; no refresh), so groups stay collapsed across visits and reloads. Keys
  // are kept per grouping ("assignee::assignee-none"), so collapsing "No Priority" in one view doesn't
  // collapse "No Status" in another.
  const [collapsedAll, setCollapsedAll] = useState<Set<string>>(() => new Set(collapsedGroups));
  const scope = collapseScope(config);
  const collapsed = scopedKeys(collapsedAll, scope);
  const setCollapsed = (update: (current: Set<string>) => Set<string>) =>
    setCollapsedAll((all) => withScopedKeys(all, scope, update(scopedKeys(all, scope))));
  const savedCollapsed = useRef(collapsedAll);
  const unsavedCollapsed = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (savedCollapsed.current === collapsedAll) return;
    unsavedCollapsed.current = collapsedAll;
    const timer = setTimeout(() => {
      savedCollapsed.current = collapsedAll;
      unsavedCollapsed.current = null;
      startTransition(async () => {
        const result = await saveListCollapsedGroups(projectId, [...collapsedAll]);
        if (result.error) notify(result.error);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [collapsedAll, projectId, notify]);
  useEffect(
    () => () => {
      // Leaving within the moment before a save: save now (fire and forget).
      if (unsavedCollapsed.current) void saveListCollapsedGroups(projectId, [...unsavedCollapsed.current]);
    },
    [projectId],
  );
  const pages = useGroupPages();
  const showMorePage = usePagedShowMore();
  const [quickAdd, setQuickAdd] = useState<{ groupKey: string; nonce: number } | null>(null);
  const [draggingTask, setDraggingTask] = useState<string | null>(null);
  const [taskDrop, setTaskDrop] = useState<TaskDrop | null>(null);
  const [draggingSection, setDraggingSection] = useState<string | null>(null);
  const [sectionDrop, setSectionDrop] = useState<SectionDrop | null>(null);
  const [topAdd, setTopAdd] = useState<TopAdd | null>(null);
  const [addingField, setAddingField] = useState(false);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [widths, setWidths] = useState<ColumnWidths>(columnWidths);
  const widthsRef = useRef(widths);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The List's visible width, for the Name track's limit (listNameTrack): set as a CSS variable, so a
  // window resize or the task pane opening never re-renders the rows.
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    widthsRef.current = widths;
  }, [widths]);

  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollParentOf(root);
    if (!root || !scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => root.style.setProperty(LIST_VIEW_WIDTH_VAR, `${scroller.clientWidth}px`));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onAdd = (event: Event) =>
      setTopAdd((t) => ({ groupKey: null, nonce: (t?.nonce ?? 0) + 1, kind: addTaskKindOf(event) }));
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
  const groupContext = { sections: optimisticSections, profilesById, fields, tags };
  // A paged list keeps the server's groups until the loaded cards change (a drag) or the
  // saved config is what the page was built from. Sorting the partial page here would hide tasks.
  const groups =
    taskPage && optimisticTasks === tasks && sameConfig(config, configProp)
      ? groupsFromPage(taskPage, configProp, groupContext)
      : withPageCursors(
          groupTasks(optimisticTasks, taskPage ? configProp : config, groupContext),
          taskPage ?? [],
        );
  const tagsById = new Map(tags.map((t) => [t.id, t] as const));
  const bySection = groupOf(config) === "section";
  // Precise drop positions only make sense in manual (sort_order) order, like Board.
  const manualOrder = bySection && sortOf(config)[0]?.key === "manual";
  const canDragTasks = canEdit && manualOrder;
  // Oct 27 notes (batch 5): while the owner has locked the sections, only owners reorder them.
  const { canEditSections } = useSectionPermissions();
  const canDragSections = canEditSections && bySection && !config.filters?.sections;
  const filtered = hasActiveFilters(config.filters);

  const visibleTasks = (group: TaskGroup) =>
    group.total != null ? group.tasks : group.tasks.slice(0, pages.limit(group.key));
  const shownIds = (group: TaskGroup) => visibleTasks(group).map((task) => task.id);
  const allIds = groups.flatMap((group) => shownIds(group));
  const navIds = groups.filter((group) => !collapsed.has(group.key)).flatMap((group) => shownIds(group));
  const selection = useTaskSelection(allIds, navIds);
  const tasksById = new Map(optimisticTasks.map((t) => [t.id, t]));
  const approvalShortcut = useApprovalShortcut();

  const toggle = (task: ProjectTask) => {
    const completed = !task.completedAt;
    // A blocked task has a lock instead of a checkbox; never try (and undo) completing it.
    if (completed && blockedCount(task) > 0) return;
    run(
      () => setTaskCompleted(task.id, completed),
      () => applyChange({ type: "complete", taskId: task.id, completed }),
    );
  };

  const rename = (task: ProjectTask, title: string) =>
    run(
      () => updateTask(task.id, { title }),
      () => applyChange({ type: "title", taskId: task.id, title }),
    );

  // Oct 27 notes (batch 6): every visible cell edits in place (item 46), and rows open their subtasks
  // (item 41). Dates go through the dependency shift (dependents may move too), never a plain update.
  const shift = useDependencyShift();
  const showAll = showsSubtasks(config);
  const treeRows: { id: string; rootId: string }[] = [];
  const treeRowIds = new Set<string>();
  for (const group of groups) {
    if (collapsed.has(group.key)) continue;
    for (const task of visibleTasks(group)) {
      if (task.subtaskCount <= 0 || treeRowIds.has(task.id)) continue;
      treeRowIds.add(task.id);
      treeRows.push({ id: task.id, rootId: task.id });
    }
  }
  const trees = useSubtaskTrees({ initialExpanded: expandedTaskIds, serverSubtasks: subtasks, projectId, rows: treeRows, showAll });
  // Only the project's members can be assigned (others couldn't read the task); the database decides.
  const memberIds = bulk?.memberIds ? new Set(bulk.memberIds) : null;
  const assignable = memberIds ? profiles.filter((p) => memberIds.has(p.id)) : profiles;

  const assign = (task: ProjectTask, assigneeId: string | null) => {
    if (assigneeId === task.assigneeId) return;
    run(
      () => updateTask(task.id, { assigneeId }),
      () => applyChange({ type: "assign", taskId: task.id, assigneeId }),
    );
  };
  const setField = (task: ProjectTask, field: FieldDef, value: Json) =>
    run(
      () => setFieldValue(task.id, field.id, value),
      () => applyChange({ type: "field", taskId: task.id, fieldId: field.id, value }),
    );
  const moveToSection = (task: ProjectTask, sectionId: string | null) => {
    if (sectionId === task.sectionId) return;
    const last = optimisticTasks.filter((t) => t.sectionId === sectionId && t.id !== task.id).at(-1)?.sortOrder ?? 0;
    run(
      () => moveTask(task.id, projectId, sectionId),
      () => applyChange({ type: "move", taskId: task.id, sectionId, sortOrder: last + 1024 }),
    );
  };
  // A row's new dates (a task or a subtask). The rows that move (it, and dependents the person lets
  // move) are drawn in their new place at once.
  const changeRowDates = (
    task: { id: string; title: string; startOn: string | null; dueOn: string | null; kind: TaskKind },
    edit: DateEdit,
    close: () => void,
  ) => {
    const dates = mergeDateEdit(task, edit, task.kind === "milestone");
    if (!dates) return;
    const before = new Map<string, RowPatch | undefined>();
    shift.changeDates(task, dates, {
      projectId,
      onPrompt: close,
      onOptimistic: (moves) => {
        for (const move of moves) {
          if (tasksById.has(move.taskId)) {
            applyChange({ type: "dates", taskId: move.taskId, startOn: move.startOn, dueOn: move.dueOn });
          } else {
            const patch = { startOn: move.startOn, dueOn: move.dueOn };
            if (!before.has(move.taskId)) before.set(move.taskId, trees.keptPatch(move.taskId));
            trees.show(move.taskId, patch);
            trees.keep(move.taskId, patch);
          }
        }
      },
      onRevert: () => before.forEach((previous, id) => trees.restore(id, previous)),
    });
  };
  // Subtask edits show at once and are kept until fresh data arrives (a tree loaded in the browser isn't
  // part of the page's refresh).
  const editSubtask = (subtask: SubtaskItem, patch: RowPatch, action: () => Promise<ActionResult>) =>
    run(
      async () => {
        const result = await action();
        if (!result.error) trees.keep(subtask.id, patch);
        return result;
      },
      () => trees.show(subtask.id, patch),
    );
  const subtaskHandlers: SubtaskHandlers = {
    toggle(subtask) {
      const completed = !subtask.completedAt;
      if (completed && blockedCount(subtask) > 0) return;
      editSubtask(subtask, { completedAt: completed ? new Date().toISOString() : null }, () => setTaskCompleted(subtask.id, completed));
    },
    rename: (subtask, title) => editSubtask(subtask, { title }, () => updateSubtask(subtask.id, { title })),
    assign(subtask, assigneeId) {
      if (assigneeId !== subtask.assigneeId) editSubtask(subtask, { assigneeId }, () => updateTask(subtask.id, { assigneeId }));
    },
    dates: changeRowDates,
    expand: (id) => trees.toggle(id),
  };

  // Shortcuts act on the selection, else the task open in the pane, else the keyboard cursor.
  const targets = () => {
    if (selection.selected.length) return selection.selected;
    const one = openTaskId && tasksById.has(openTaskId) ? openTaskId : selection.active;
    return one ? [one] : [];
  };

  const expand = (groupKey: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      next.delete(groupKey);
      return next;
    });

  useListKeys({
    move(delta) {
      const next = selection.move(delta);
      if (next) requestAnimationFrame(() => scrollRowIntoView(next));
    },
    open() {
      const id = selection.active ?? (selection.selected.length === 1 ? selection.selected[0] : null);
      const task = id ? tasksById.get(id) : undefined;
      if (id) openTask(id, task ? seeds.task(task) : null);
    },
    escape() {
      if (openTaskId) return false; // the pane closes itself
      if (selection.selected.length === 0) return false;
      selection.clear();
      return true;
    },
    complete() {
      let ids = targets();
      if (ids.length === 0) return;
      const completed = !ids.every((id) => tasksById.get(id)?.completedAt);
      if (completed) {
        // One approval task the viewer doesn't approve: its approval step instead (Oct 29 notes, batch 7).
        const only = ids.length === 1 ? tasksById.get(ids[0]) : undefined;
        if (only && approvalShortcut(only, seeds.task(only))) return;
        // Blocked tasks can't be completed: say so and leave them out (item 43).
        const listed = ids.flatMap((id) => tasksById.get(id) ?? []);
        const { blocked } = splitBlocked(listed);
        const message = blockedSkipMessage(blocked);
        if (message) notify(message);
        const skip = new Set(blocked.map((t) => t.id));
        ids = ids.filter((id) => !skip.has(id));
        if (ids.length === 0) return;
      }
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
      expand(group.key);
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
    const sortOrder = sortOrderFor(
      group.tasks,
      beforeId,
      task.id,
      group.nextId != null && group.nextSortOrder != null
        ? { id: group.nextId, sortOrder: group.nextSortOrder }
        : null,
    );
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

  const columns = columnsOf(config, fields, tagsOn).filter(
    (c) => !c.startsWith("field:") || fieldsById.has(refFieldId(c) ?? ""),
  );
  // Column menus write an explicit column list into the (draft) view config.
  const applyColumns = (next: ColumnKey[]) => viewConfig?.apply({ ...config, columns: next });
  const applySort = (key: SortKey, dir: "asc" | "desc") => viewConfig?.apply({ ...config, sort: [{ key, dir }] });
  const firstSort = sortOf(config)[0];
  // Fixed pixel tracks (dragged to size) plus a filler, so the rows fill the page and scroll sideways
  // once the columns are wider than it. The header and every row use exactly this.
  const gridStyle = listGridStyle(widths, columns);
  const tagsInline = tagsOn && !columns.includes("tags");
  const fieldContext: FieldContext = {
    profilesById,
    sectionNames: new Map(optimisticSections.map((s) => [s.id, s.name])),
  };
  const sectionOptions = optimisticSections.map((s) => ({ id: s.id, name: s.name }));
  const rowProps = {
    profilesById,
    tagsById,
    openTaskId,
    seeds,
    onToggle: toggle,
    onRename: rename,
    canEdit,
    columns,
    fieldsById,
    fieldContext,
    gridStyle,
    selection,
    selecting: selection.selected.length > 0,
    tagsInline,
    edit: {
      people: assignable,
      everyone: profiles,
      sections: sectionOptions,
      assign,
      setField,
      moveToSection,
      dates: changeRowDates,
    },
  };
  const subtaskProps = {
    trees,
    profilesById,
    people: assignable,
    seeds,
    openTaskId,
    canEdit,
    columns,
    gridStyle,
    handlers: subtaskHandlers,
  };
  const sectionGroups = groups.filter((g) => g.section);
  const firstSectionGroup = groups.find((g) => g.target.kind === "section");
  const editingField = editingFieldId ? fieldsById.get(editingFieldId) : undefined;

  const columnMenu = (column: ColumnKey | "task", index: number) => {
    const key = sortKeyFor(column, fieldsById);
    const field = column === "task" ? undefined : fieldsById.get(refFieldId(column) ?? "");
    return (
      <ColumnMenu
        label={column === "task" ? "Name" : columnLabel(column, fieldsById)}
        sort={key ? { current: firstSort?.key === key ? firstSort.dir : null, apply: (dir) => applySort(key, dir) } : null}
        onHide={column === "task" ? undefined : () => applyColumns(columns.filter((c) => c !== column))}
        onMoveLeft={
          column === "task" || index === 0
            ? undefined
            : () => applyColumns(columns.map((c, i) => (i === index - 1 ? column : i === index ? columns[index - 1] : c)))
        }
        onMoveRight={
          column === "task" || index === columns.length - 1
            ? undefined
            : () => applyColumns(columns.map((c, i) => (i === index + 1 ? column : i === index ? columns[index + 1] : c)))
        }
        onEditField={field && canEdit ? () => setEditingFieldId(field.id) : undefined}
      />
    );
  };

  return (
    <div ref={rootRef} className="min-w-full px-gutter pb-24" style={{ width: "max-content" }}>
      <div className={LIST_HEADER_ROW} style={gridStyle}>
        <HeaderCell
          label="Name"
          pinned
          className={NAME_INDENT[who].header}
          width={columnWidth(widths, "task")}
          onResize={(w) => resizeColumn("task", w)}
          onReset={() => resizeColumn("task", null)}
          onCommit={commitWidths}
          menu={columnMenu("task", -1)}
        />
        {columns.map((column, index) => (
          <HeaderCell
            key={column}
            label={columnLabel(column, fieldsById)}
            width={columnWidth(widths, column)}
            onResize={(w) => resizeColumn(column, w)}
            onReset={() => resizeColumn(column, null)}
            onCommit={commitWidths}
            menu={columnMenu(column, index)}
          />
        ))}
        <span className="flex items-center px-1">
          {canEdit ? (
            <button
              type="button"
              onClick={() => setAddingField(true)}
              aria-label="Add a field"
              title="Add field"
              className="btn-icon size-6 text-zinc-400 hover:text-zinc-700"
            >
              <Plus className="size-4" />
            </button>
          ) : null}
        </span>
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
        // The toolbar's "+ Add task" targets the first section group; a section's "+" its own.
        const topTarget =
          topAdd !== null &&
          group.target.kind === "section" &&
          (topAdd.groupKey === group.key || (topAdd.groupKey === null && group === firstSectionGroup));
        const isTaskTarget = draggingTask !== null && taskDrop?.groupKey === group.key;
        const sectionId = group.section?.id;
        return (
          <SectionGroup
            key={group.key}
            title={<GroupTitle group={group} />}
            collapsed={collapsed.has(group.key) && !topTarget}
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
            dragHandle={
              canDragSections && sectionId ? (
                <span
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(SECTION_DRAG, sectionId);
                    e.dataTransfer.effectAllowed = "move";
                    setDraggingSection(sectionId);
                  }}
                  onDragEnd={() => {
                    setDraggingSection(null);
                    setSectionDrop(null);
                  }}
                  title="Drag to reorder"
                  aria-hidden
                  className="cursor-grab rounded p-0.5 text-zinc-400 opacity-0 hover:bg-zinc-100 active:cursor-grabbing group-hover/section:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <GripVertical className="size-4" />
                </span>
              ) : canEdit ? (
                <span aria-hidden className="w-5 shrink-0" />
              ) : null
            }
            actions={
              group.section && sectionId ? (
                <SectionActions
                  projectId={projectId}
                  section={group.section}
                  taskCount={sectionTaskCounts[sectionId] ?? group.tasks.length}
                  nextSectionId={optimisticSections[optimisticSections.findIndex((s) => s.id === sectionId) + 1]?.id ?? null}
                  orientation="vertical"
                  onAddTask={() => {
                    expand(group.key);
                    setTopAdd((t) => ({ groupKey: group.key, nonce: (t?.nonce ?? 0) + 1, kind: "task" }));
                  }}
                  onMoveUp={
                    canDragSections && sectionIndex > 0
                      ? () => moveSection(sectionId, sectionGroups[sectionIndex - 1].section!.id)
                      : undefined
                  }
                  onMoveDown={
                    canDragSections && sectionIndex < sectionGroups.length - 1
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
            {topTarget && topAdd && group.target.kind === "section" ? (
              <div className="sticky left-0 w-[min(100%,48rem)] border-b border-zinc-100">
                <AddTaskInput
                  key={`top-${topAdd.nonce}`}
                  projectId={projectId}
                  sectionId={group.target.sectionId}
                  variant="row"
                  indent={NAME_INDENT[who].title}
                  idSuffix="-top"
                  defaultOpen
                  defaultKind={topAdd.kind}
                  atTop
                  onClose={() => setTopAdd(null)}
                />
              </div>
            ) : null}
            {visibleTasks(group).map((task, index) => (
              <div
                key={task.id}
                onDragOver={(e) => {
                  if (!draggingTask || draggingTask === task.id || group.target.kind !== "section") return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > rect.top + rect.height / 2;
                  setTaskDrop({
                    groupKey: group.key,
                    beforeId: after ? (group.tasks[index + 1]?.id ?? group.nextId ?? null) : task.id,
                  });
                }}
              >
                {isTaskTarget && taskDrop?.beforeId === task.id ? <DropLine /> : null}
                <TaskRow
                  task={task}
                  {...rowProps}
                  expanded={task.subtaskCount > 0 && trees.isExpanded(task.id)}
                  onToggleExpanded={() => trees.toggle(task.id)}
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
                {task.subtaskCount > 0 && trees.isExpanded(task.id) ? (
                  <SubtaskRows root={task} {...subtaskProps} />
                ) : null}
              </div>
            ))}
            {(group.total ?? group.tasks.length) > visibleTasks(group).length ? (
              <div className="sticky left-0 w-[min(100%,48rem)]">
                <ShowMoreRows
                  hidden={(group.total ?? group.tasks.length) - visibleTasks(group).length}
                  onClick={() =>
                    group.total != null
                      ? showMorePage(group.key, visibleTasks(group).length)
                      : pages.showMore(group.key)
                  }
                  className={NAME_INDENT[who].title}
                />
              </div>
            ) : null}
            {isTaskTarget && taskDrop?.beforeId === null && group.tasks.length > 0 ? <DropLine /> : null}
            {group.section && group.tasks.length === 0 && (draggingTask || filtered || !canEdit) ? (
              <p className={`sticky left-0 flex min-h-row items-center border-b border-zinc-100 text-xs text-zinc-400 ${NAME_INDENT[who].title}`}>
                {draggingTask ? "Drop here" : filtered ? "No matching tasks in this section." : "No tasks in this section yet."}
              </p>
            ) : null}
            {group.target.kind === "section" ? (
              // Asana's inline "Add task…" row at the end of every section: grey text under the names.
              <div className="sticky left-0 w-[min(100%,48rem)]">
                <AddTaskInput
                  key={quickAdd?.groupKey === group.key ? `quick-${quickAdd.nonce}` : "add"}
                  projectId={projectId}
                  sectionId={group.target.sectionId}
                  variant="row"
                  indent={NAME_INDENT[who].title}
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
        <div className="sticky left-0 mt-4 w-fit">
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

      {addingField ? (
        <NewFieldDialog
          projectId={projectId}
          existingFieldIds={fields.map((f) => f.id)}
          onClose={() => setAddingField(false)}
          onCreated={(fieldId) => {
            // Pinned fields show in views with the default columns; a view with its own columns gets it
            // as an unsaved change (Save view keeps it).
            if (config.columns) applyColumns([...columns, fieldRef(fieldId)]);
          }}
        />
      ) : null}
      {editingField ? (
        <EditFieldDialog
          field={editingField}
          sectionNames={optimisticSections.map((s) => s.name)}
          onClose={() => setEditingFieldId(null)}
        />
      ) : null}
      {/* "Move dependent tasks too?" after a date change in a row (outside the rows: they contain paint). */}
      {shift.dialog}
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
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${OPTION_COLOR_CLASSES[group.color]}`}>
          {group.label}
        </span>
      ) : (
        <span className={group.target.kind === "section" ? "text-zinc-500" : undefined}>{group.label}</span>
      )}
      <span className="text-xs font-normal tabular-nums text-zinc-400">{group.tasks.length}</span>
    </span>
  );
}

function SectionGroup({
  title,
  collapsed,
  onToggleCollapsed,
  highlight,
  sectionDropBefore,
  dragHandle,
  actions,
  onHeaderDragOver,
  onHeaderDrop,
  onBodyDragOver,
  onBodyDrop,
  children,
}: {
  title: ReactNode;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  highlight: boolean;
  sectionDropBefore: boolean;
  dragHandle: ReactNode;
  actions: ReactNode;
  onHeaderDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onHeaderDrop?: (e: DragEvent) => void;
  onBodyDragOver: (e: DragEvent<HTMLElement>) => void;
  onBodyDrop?: (e: DragEvent) => void;
  children: ReactNode;
}) {
  return (
    <section className="group/section mt-4" onDragOver={onBodyDragOver} onDrop={onBodyDrop}>
      {sectionDropBefore ? <DropLine /> : null}
      <div
        className="sticky left-0 flex h-9 w-[min(100%,48rem)] items-center gap-0.5"
        onDragOver={onHeaderDragOver}
        onDrop={onHeaderDrop}
      >
        {dragHandle}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand group" : "Collapse group"}
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        {/* Asana puts "+" and "…" right after the name, so the pair sizes to its content. */}
        <div className="flex min-w-0 items-center gap-1">
          {title}
          {actions}
        </div>
      </div>
      {collapsed ? null : (
        <div className={`border-t border-zinc-200 ${highlight ? "bg-accent-50/40" : ""}`}>{children}</div>
      )}
    </section>
  );
}

// A column header's chevron menu (on hover or focus): sort, hide, move, edit the field. Every change
// is an unsaved draft of the view (Save view keeps it), like the toolbar's.
function ColumnMenu({
  label,
  sort,
  onHide,
  onMoveLeft,
  onMoveRight,
  onEditField,
}: {
  label: string;
  sort: { current: "asc" | "desc" | null; apply: (dir: "asc" | "desc") => void } | null;
  onHide?: () => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  onEditField?: () => void;
}) {
  const item = (onClick: () => void, close: () => void) => () => {
    close();
    onClick();
  };
  return (
    <Popover
      label={`Options for the ${label} column`}
      panelClassName="w-52 p-1.5"
      buttonClassName="btn-icon size-5 shrink-0 opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
      button={<ChevronDown className="size-3.5" aria-hidden />}
    >
      {(close) => (
        <>
          {sort ? (
            <>
              <MenuItem onClick={item(() => sort.apply("asc"), close)}>
                <ArrowUpNarrowWide className="size-4 text-zinc-500" />
                <span className="flex-1">Sort ascending</span>
                {sort.current === "asc" ? <Check className="size-3.5 text-accent-600" aria-label="(current)" /> : null}
              </MenuItem>
              <MenuItem onClick={item(() => sort.apply("desc"), close)}>
                <ArrowDownNarrowWide className="size-4 text-zinc-500" />
                <span className="flex-1">Sort descending</span>
                {sort.current === "desc" ? <Check className="size-3.5 text-accent-600" aria-label="(current)" /> : null}
              </MenuItem>
            </>
          ) : null}
          {sort && (onHide || onMoveLeft || onMoveRight || onEditField) ? (
            <div role="separator" className="my-1 border-t border-zinc-100" />
          ) : null}
          {onEditField ? (
            <MenuItem onClick={item(onEditField, close)}>
              <Pencil className="size-4 text-zinc-500" /> Edit field
            </MenuItem>
          ) : null}
          {onHide ? (
            <MenuItem onClick={item(onHide, close)}>
              <EyeOff className="size-4 text-zinc-500" /> Hide column
            </MenuItem>
          ) : null}
          {onHide ? (
            <>
              <MenuItem disabled={!onMoveLeft} onClick={item(() => onMoveLeft?.(), close)}>
                <ChevronLeft className="size-4 text-zinc-500" /> Move left
              </MenuItem>
              <MenuItem disabled={!onMoveRight} onClick={item(() => onMoveRight?.(), close)}>
                <ChevronRight className="size-4 text-zinc-500" /> Move right
              </MenuItem>
            </>
          ) : null}
          {!sort && !onHide ? <p className="px-2 py-1 text-xs text-zinc-500">Nothing to change here.</p> : null}
        </>
      )}
    </Popover>
  );
}

// A column's width as drawn: the Name column can be drawn narrower than its saved width on a narrow page
// (listNameTrack), and a resize starts from what the person sees.
function drawnWidth(handle: HTMLElement, saved: number) {
  const drawn = handle.parentElement?.getBoundingClientRect().width;
  return drawn ? Math.min(saved, Math.round(drawn)) : saved;
}

// The List's scroller (the nearest ancestor that scrolls sideways).
function scrollParentOf(element: HTMLElement | null) {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowX } = getComputedStyle(node);
    if (overflowX === "auto" || overflowX === "scroll") return node;
  }
  return null;
}

// A resizable column header: drag the right edge (or focus it and use ←/→), double-click to reset. The
// chevron menu shows on hover. The Name header is pinned exactly like the rows' Name cells
// (listHeaderCellClass), and the handle stays inside the cell (list-grid.ts).
function HeaderCell({
  label,
  width,
  pinned = false,
  className = "",
  menu,
  onResize,
  onReset,
  onCommit,
}: {
  label: string;
  width: number;
  pinned?: boolean;
  className?: string;
  menu: ReactNode;
  onResize: (width: number) => void;
  onReset: () => void;
  onCommit: () => void;
}) {
  return (
    <div className={`${listHeaderCellClass(pinned)} ${className}`}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {menu}
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
          const from = drawnWidth(handle, width);
          handle.setPointerCapture(e.pointerId);
          const move = (event: PointerEvent) => onResize(from + event.clientX - startX);
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
          onResize(drawnWidth(e.currentTarget, width) + (e.key === "ArrowRight" ? 16 : -16));
          onCommit();
        }}
        onDoubleClick={() => {
          onReset();
          onCommit();
        }}
        className={LIST_RESIZE_HANDLE}
      />
    </div>
  );
}

// The task name. Editors click it to rename in place (Enter saves, Esc cancels); the ">" at the end of
// the cell, a click elsewhere on the row, or Enter on the selected row opens the task. Below Editor the
// name is a link to the task. Subtask rows use it too (a lighter name, "Subtask:" for screen readers).
function TaskTitle({
  task,
  seed,
  canEdit,
  open,
  editing,
  setEditing,
  onRename,
  subtask = false,
}: {
  task: { id: string; title: string; completedAt: string | null; requestLabel?: RequestLabel | null };
  seed: () => TaskSeed;
  canEdit: boolean;
  open: boolean;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  onRename: (title: string) => void;
  subtask?: boolean;
}) {
  const completed = Boolean(task.completedAt);
  const tone = completed ? "text-zinc-400 line-through" : subtask ? "text-zinc-700" : "text-zinc-900";
  const prefix = subtask ? <span className="sr-only">Subtask: </span> : null;
  if (!canEdit) {
    return (
      <TaskLink
        taskId={task.id}
        seed={seed}
        draggable={false}
        aria-current={open ? "true" : undefined}
        className={`min-w-0 truncate text-sm hover:underline ${tone}`}
      >
        {prefix}
        {displayTaskTitle(task.title, task.requestLabel)}
      </TaskLink>
    );
  }
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={task.title}
        maxLength={500}
        aria-label={subtask ? "Subtask name" : "Task name"}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          const title = e.currentTarget.value.trim();
          setEditing(false);
          if (title && title !== task.title) onRename(title);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = task.title;
            e.currentTarget.blur();
          }
        }}
        className="h-6 min-w-0 flex-1 rounded border border-accent-500/60 bg-white px-1 text-sm text-zinc-900 shadow-[0_0_0_3px_var(--focus-ring)] focus:outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      draggable={false}
      onClick={() => setEditing(true)}
      title="Rename"
      aria-label={`Rename “${task.title}”`}
      className={`-mx-1 min-w-0 truncate rounded px-1 text-left text-sm ring-zinc-200 group-hover:ring-1 hover:ring-zinc-300 ${tone}`}
    >
      {prefix}
      {displayTaskTitle(task.title, task.requestLabel)}
    </button>
  );
}

// The ">" at the end of a Name cell: opens the task (shown on hover; always on touch screens).
function OpenTaskLink({ taskId, title, seed, open }: { taskId: string; title: string; seed: () => TaskSeed; open: boolean }) {
  return (
    <TaskLink
      taskId={taskId}
      seed={seed}
      draggable={false}
      aria-label={`Open “${title}”`}
      aria-current={open ? "true" : undefined}
      title="Details"
      className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 opacity-0 hover:bg-zinc-200/70 hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
    >
      <ChevronRight className="size-4" />
    </TaskLink>
  );
}

// A click on the row itself (not on a control) opens the task. Clicks inside a cell's picker (drawn on
// <body>, but still the row's child in React) aren't the row's.
function rowClickOpens(e: React.MouseEvent<HTMLElement>) {
  const target = e.target as HTMLElement;
  if (!e.currentTarget.contains(target)) return "outside" as const;
  return target.closest("a, button, input, select, textarea, label") ? ("control" as const) : ("row" as const);
}

type RowEdit = {
  // People who can be assigned (the project's members) and everyone (people fields).
  people: Profile[];
  everyone: Profile[];
  sections: { id: string; name: string }[];
  assign: (task: ProjectTask, assigneeId: string | null) => void;
  setField: (task: ProjectTask, field: FieldDef, value: Json) => void;
  moveToSection: (task: ProjectTask, sectionId: string | null) => void;
  dates: (task: ProjectTask, edit: DateEdit, close: () => void) => void;
};

function TaskRow({
  task,
  profilesById,
  tagsById,
  openTaskId,
  seeds,
  onToggle,
  onRename,
  canEdit,
  columns,
  fieldsById,
  fieldContext,
  gridStyle,
  selection,
  selecting,
  tagsInline,
  edit,
  expanded,
  onToggleExpanded,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  task: ProjectTask;
  profilesById: Map<string, Profile>;
  tagsById: Map<string, Tag>;
  openTaskId: string | null;
  seeds: Seeds;
  onToggle: (task: ProjectTask) => void;
  onRename: (task: ProjectTask, title: string) => void;
  canEdit: boolean;
  columns: ColumnKey[];
  fieldsById: Map<string, FieldDef>;
  fieldContext: FieldContext;
  gridStyle: React.CSSProperties;
  selection: TaskSelection;
  selecting: boolean;
  tagsInline: boolean;
  edit: RowEdit;
  expanded: boolean;
  onToggleExpanded: () => void;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const openTask = useOpenTask();
  const seed = () => seeds.task(task);
  // Hovering the row fetches the pane's data, so a click usually finds it ready.
  const prefetch = useTaskPrefetch(task.id, seed);
  // Renaming in place (or typing in a cell): the row stops being draggable so the mouse can select text.
  const [editing, setEditing] = useState(false);
  const [editingCell, setEditingCell] = useState(false);
  const completed = Boolean(task.completedAt);
  const blocked = blockedCount(task);
  const assignee = task.assigneeId ? profilesById.get(task.assigneeId) : undefined;
  const open = openTaskId === task.id;
  const selected = selection.isSelected(task.id);
  // The keyboard cursor's blue edge (after ↑/↓ only; a clicked row keeps none once the pane closes).
  const active = selection.cursor === task.id;
  // The sticky Name cell needs an opaque background of its own.
  const tone = selected || open ? "bg-accent-50" : "bg-white group-hover:bg-zinc-50";

  return (
    <div
      data-task-row={task.id}
      draggable={draggable && !editing && !editingCell}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onPointerEnter={prefetch.onPointerEnter}
      onPointerLeave={prefetch.onPointerLeave}
      onClick={(e) => {
        const where = rowClickOpens(e);
        if (where === "outside") return;
        if (where === "control") {
          // The ">" (and a viewer's name link) opens the task (⌘/Ctrl-click: a new tab).
          if ((e.target as HTMLElement).closest("a")) selection.setActive(task.id);
          return;
        }
        // Clicking a row opens the task; only the checkbox on the left selects (and brings up the bulk bar).
        selection.setActive(task.id);
        if (!open) openTask(task.id, seed());
      }}
      className={`cv-row group ${LIST_GRID} min-h-row cursor-pointer border-b border-zinc-100 ${
        selected || open ? "bg-accent-50" : "hover:bg-zinc-50"
      } ${dragging ? "opacity-40" : ""} ${draggable ? "active:cursor-grabbing" : ""}`}
      style={gridStyle}
    >
      <div
        className={`${LIST_PINNED_CELL} gap-2 py-1 ${NAME_INDENT[canEdit ? "editor" : "viewer"].row} ${tone} ${
          active ? "shadow-[inset_2px_0_0_var(--color-accent-500)]" : ""
        }`}
      >
        {canEdit ? (
          // Asana's 6-dot handle at the far left (the whole row drags; this shows where to grab).
          <span
            aria-hidden
            title={draggable ? "Drag to reorder" : undefined}
            className={`flex w-4 shrink-0 justify-center text-zinc-400 ${
              draggable ? "cursor-grab opacity-0 group-hover:opacity-100 active:cursor-grabbing" : "invisible"
            }`}
          >
            <GripVertical className="size-4" />
          </span>
        ) : null}
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
        <ExpandToggle expandable={task.subtaskCount > 0} expanded={expanded} title={task.title} onToggle={onToggleExpanded} />
        {/* Blocked tasks wear a lock (item 43); approval tasks only their approvers tick (Oct 29 notes, batch 7). */}
        <RowCompleteControl
          task={task}
          completed={completed}
          readOnly={!canEdit}
          blocked={blocked}
          seed={seed}
          onToggle={() => onToggle(task)}
        />
        <TaskTitle
          task={task}
          seed={seed}
          canEdit={canEdit}
          open={open}
          editing={editing}
          setEditing={setEditing}
          onRename={(title) => onRename(task, title)}
        />
        <span className="flex shrink-0 items-center gap-2">
          <TaskBadges task={task} />
          <AttachmentCount count={task.attachmentCount} />
          <CommentCount count={task.commentCount} />
        </span>
        {tagsInline && task.tagIds.length > 0 ? (
          // Tags give way first (the cell never grows past its column), so the ">" stays in view.
          <span className="flex min-w-0 overflow-hidden">
            <TagChips ids={task.tagIds} byId={tagsById} />
          </span>
        ) : null}
        <OpenTaskLink taskId={task.id} title={task.title} seed={seed} open={open} />
      </div>
      {columns.map((column) => {
        if (column === "assignee") {
          return (
            <div key={column} className={LIST_CELL}>
              <InlineAssigneeCell
                taskTitle={task.title}
                assignee={assignee}
                people={edit.people}
                canEdit={canEdit}
                onChange={(assigneeId) => edit.assign(task, assigneeId)}
              />
            </div>
          );
        }
        if (column === "due") {
          return (
            <div key={column} className={LIST_CELL}>
              <InlineDateCell
                taskTitle={task.title}
                column="due"
                startOn={task.startOn}
                dueOn={task.dueOn}
                milestone={task.kind === "milestone"}
                canEdit={canEdit}
                display={task.dueOn ? <DueDate task={task} /> : <EmptyCellHint kind="date" hidden={!canEdit} />}
                onChange={(change, close) => edit.dates(task, change, close)}
              />
            </div>
          );
        }
        if (column === "start") {
          return (
            <div key={column} className={LIST_CELL}>
              <InlineDateCell
                taskTitle={task.title}
                column="start"
                startOn={task.startOn}
                dueOn={task.dueOn}
                milestone={task.kind === "milestone"}
                canEdit={canEdit}
                display={task.startOn ? <StartDate task={task} /> : <EmptyCellHint kind="date" hidden={!canEdit || task.kind === "milestone"} />}
                onChange={(change, close) => edit.dates(task, change, close)}
              />
            </div>
          );
        }
        if (column === "section") {
          const name = task.sectionId ? fieldContext.sectionNames.get(task.sectionId) : "";
          const shown = <span className="truncate text-xs text-zinc-600">{name}</span>;
          return (
            <div key={column} className={LIST_CELL}>
              {canEdit ? (
                <InlineChoiceCell
                  label={`Section of “${task.title}”: ${name || "No section"}. Change`}
                  value={task.sectionId}
                  options={edit.sections.map((s) => ({ id: s.id, name: s.name, color: "zinc" as const }))}
                  clearLabel="No section"
                  display={shown}
                  onChange={(sectionId) => edit.moveToSection(task, sectionId)}
                />
              ) : (
                shown
              )}
            </div>
          );
        }
        if (column === "tags") {
          return (
            <div key={column} className={`${LIST_CELL} overflow-hidden`}>
              <TagChips ids={task.tagIds} byId={tagsById} />
            </div>
          );
        }
        const field = fieldsById.get(refFieldId(column) ?? "");
        return (
          <div key={column} className={LIST_CELL}>
            {field ? (
              <InlineFieldCell
                field={field}
                value={task.fieldValues[field.id]}
                sectionId={task.sectionId}
                sections={edit.sections}
                people={edit.everyone}
                taskTitle={task.title}
                canEdit={canEdit}
                display={<FieldValueChips field={field} task={task} context={fieldContext} showName />}
                onChange={(value) => edit.setField(task, field, value)}
                onSectionChange={(sectionId) => edit.moveToSection(task, sectionId)}
                onEditingChange={setEditingCell}
              />
            ) : null}
          </div>
        );
      })}
      <span aria-hidden />
    </div>
  );
}

type SubtaskHandlers = {
  toggle: (subtask: SubtaskItem) => void;
  rename: (subtask: SubtaskItem, title: string) => void;
  assign: (subtask: SubtaskItem, assigneeId: string | null) => void;
  dates: (subtask: SubtaskItem, edit: DateEdit, close: () => void) => void;
  expand: (id: string) => void;
};

type SubtaskRowsProps = {
  trees: SubtaskTrees;
  profilesById: Map<string, Profile>;
  people: Profile[];
  seeds: Seeds;
  openTaskId: string | null;
  canEdit: boolean;
  columns: ColumnKey[];
  gridStyle: React.CSSProperties;
  handlers: SubtaskHandlers;
};

// An open row's subtasks (Oct 27 notes, batch 6; also every row's with “Show subtasks”): every level,
// indented, each one expandable when it has subtasks of its own, edited in place like a task row
// (complete, rename, assignee, dates) for Editors. Subtasks aren't selected, dragged, or filtered — they
// follow their task — and open in the pane with a click.
function SubtaskRows({ root, trees, canEdit, ...rest }: { root: ProjectTask } & SubtaskRowsProps) {
  const who = canEdit ? "editor" : "viewer";
  if (trees.isLoading(root.id)) {
    return (
      <p
        role="status"
        className="sticky left-0 flex min-h-row w-[min(100%,48rem)] items-center border-b border-zinc-100 text-xs text-zinc-400"
        style={{ paddingLeft: `${subtaskIndentRem(who, 1)}rem` }}
      >
        Loading subtasks…
      </p>
    );
  }
  const rows = flattenSubtaskRows(root.id, root.title, trees.childrenOf, trees.isExpanded);
  if (rows.length === 0) return null;
  return (
    <ul aria-label={`Subtasks of “${root.title}”`}>
      {rows.map((row) => (
        <li key={row.item.id}>
          <SubtaskRow row={row} indentRem={subtaskIndentRem(who, row.depth)} canEdit={canEdit} trees={trees} {...rest} />
        </li>
      ))}
    </ul>
  );
}

function SubtaskRow({
  row,
  indentRem,
  profilesById,
  people,
  seeds,
  openTaskId,
  canEdit,
  columns,
  gridStyle,
  handlers,
}: { row: FlatSubtaskRow; indentRem: number } & SubtaskRowsProps) {
  const { item: subtask, parentTitle } = row;
  const openTask = useOpenTask();
  const [editing, setEditing] = useState(false);
  const completed = Boolean(subtask.completedAt);
  const blocked = blockedCount(subtask);
  const open = openTaskId === subtask.id;
  const seed = () => seeds.subtask(subtask, parentTitle);
  const assignee = subtask.assigneeId ? profilesById.get(subtask.assigneeId) : undefined;
  return (
    <div
      data-subtask-row={subtask.id}
      onClick={(e) => {
        if (rowClickOpens(e) !== "row") return;
        if (!open) openTask(subtask.id, seed());
      }}
      className={`cv-row group ${LIST_GRID} min-h-row cursor-pointer border-b border-zinc-100 ${open ? "bg-accent-50" : "hover:bg-zinc-50"}`}
      style={gridStyle}
    >
      <div
        className={`${LIST_PINNED_CELL} gap-2 py-1 ${open ? "bg-accent-50" : "bg-white group-hover:bg-zinc-50"}`}
        style={{ paddingLeft: `${indentRem}rem` }}
      >
        <ExpandToggle
          expandable={row.hasChildren}
          expanded={row.expanded}
          title={subtask.title}
          onToggle={() => handlers.expand(subtask.id)}
        />
        <RowCompleteControl
          task={subtask}
          completed={completed}
          readOnly={!canEdit}
          blocked={blocked}
          size="sm"
          seed={seed}
          onToggle={() => handlers.toggle(subtask)}
        />
        <TaskTitle
          task={subtask}
          seed={seed}
          canEdit={canEdit}
          open={open}
          editing={editing}
          setEditing={setEditing}
          onRename={(title) => handlers.rename(subtask, title)}
          subtask
        />
        {subtask.subtaskCount > 0 ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-zinc-500"
            title={`${subtask.subtaskDoneCount} of ${subtask.subtaskCount} subtasks done`}
          >
            {subtask.subtaskDoneCount}/{subtask.subtaskCount}
          </span>
        ) : null}
        <OpenTaskLink taskId={subtask.id} title={subtask.title} seed={seed} open={open} />
      </div>
      {columns.map((column) => (
        <div key={column} className={LIST_CELL}>
          {column === "assignee" ? (
            <InlineAssigneeCell
              taskTitle={subtask.title}
              assignee={assignee}
              people={people}
              canEdit={canEdit}
              onChange={(assigneeId) => handlers.assign(subtask, assigneeId)}
            />
          ) : column === "due" ? (
            <InlineDateCell
              taskTitle={subtask.title}
              column="due"
              startOn={subtask.startOn}
              dueOn={subtask.dueOn}
              milestone={subtask.kind === "milestone"}
              canEdit={canEdit}
              display={subtask.dueOn ? <DueDate task={subtask} /> : <EmptyCellHint kind="date" hidden={!canEdit} />}
              onChange={(change, close) => handlers.dates(subtask, change, close)}
            />
          ) : column === "start" ? (
            <InlineDateCell
              taskTitle={subtask.title}
              column="start"
              startOn={subtask.startOn}
              dueOn={subtask.dueOn}
              milestone={subtask.kind === "milestone"}
              canEdit={canEdit}
              display={
                subtask.startOn ? <StartDate task={subtask} /> : <EmptyCellHint kind="date" hidden={!canEdit || subtask.kind === "milestone"} />
              }
              onChange={(change, close) => handlers.dates(subtask, change, close)}
            />
          ) : null}
        </div>
      ))}
      <span aria-hidden />
    </div>
  );
}

// Oct 26 notes (batch 4): collapsed List groups are stored as "<grouping>::<group key>".
export function collapseScope(config: ViewConfig): string {
  return `${groupOf(config)}::`;
}

export function scopedKeys(all: Set<string>, scope: string): Set<string> {
  return new Set([...all].filter((k) => k.startsWith(scope)).map((k) => k.slice(scope.length)));
}

export function withScopedKeys(all: Set<string>, scope: string, keys: Set<string>): Set<string> {
  const next = new Set([...all].filter((k) => !k.startsWith(scope)));
  for (const key of keys) next.add(`${scope}${key}`);
  return next;
}
