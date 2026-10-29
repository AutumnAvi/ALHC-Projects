"use client";

import Link from "next/link";
import { Fragment, useOptimistic, useState, type DragEvent, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Ellipsis,
  FolderClosed,
  GripVertical,
  Lock,
  Pencil,
  Plus,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { displayName } from "@/components/avatar";
import { BulkBar, useBulkEdit, type BulkContext } from "@/components/bulk/bulk-bar";
import { useTaskSelection, type TaskSelection } from "@/components/bulk/use-task-selection";
import { useConfirm } from "@/components/confirm";
import { MenuItem, Popover } from "@/components/popover";
import { Segmented } from "@/components/project/view-chrome";
import { scrollRowIntoView, useListKeys } from "@/components/shortcuts/keyboard";
import { ShowMoreRows, useGroupPages } from "@/components/show-more";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { useShell } from "@/components/shell/shell-context";
import { ApprovalToggle } from "@/components/complete-toggle";
import { RowCompleteControl } from "@/components/task/row-complete-control";
import { useApprovalAction, useApprovalShortcut } from "@/components/task/approval-action";
import { useDependencyShift } from "@/components/task/dependency-shift";
import { TaskLink, useOpenTask, useTaskPrefetch } from "@/components/task/task-link";
import { MoreTaskNumbers } from "@/components/task/task-number";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState, SkeletonRows } from "@/components/ui";
import {
  createMyTaskSection,
  createPrivateTask,
  deleteMyTaskSection,
  placeMyTask,
  placeMyTaskSection,
  renameMyTaskSection,
  setTaskCompleted,
  updateSubtask,
  updateTask,
  type ActionResult,
} from "@/lib/actions";
import { addDays, formatDueDate, useToday } from "@/lib/dates";
import { dayLabel } from "@/lib/date-input";
import {
  ExpandToggle,
  InlineAssigneeCell,
  InlineDateCell,
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
} from "@/components/project/inline-cells";
import { ApprovalStatusBadge, DueDate, EmptyCellHint } from "@/components/project/task-meta";
import type { AwaitingApproval, MyTask, Profile, SubtaskItem } from "@/lib/data";
import { bareTaskTitle, displayTaskTitle } from "@/lib/request-numbers";
import { seedFromMyTask, seedFromSubtask, seedFromTitle, type TaskSeed } from "@/lib/task-seed";
import {
  MY_TASKS_LAYOUT_COOKIE,
  type MyTaskPlacement,
  type MyTaskSection,
  type MyTasksLayout,
} from "@/lib/my-tasks";

type Group = { key: string; title: string; tasks: MyTask[]; section?: MyTaskSection };

const TASK_DRAG = "application/x-alhc-my-task";
const SECTION_DRAG = "application/x-alhc-my-section";
const LAYOUTS = [
  { value: "sections", label: "Sections" },
  { value: "due", label: "Due dates" },
] as const;

// Asana-style buckets, evaluated against the viewer's local date. See AGENTS.md › My Tasks.
function groupByDue(tasks: MyTask[], today: string): Group[] {
  const weekEnd = addDays(today, 7);
  const groups: Group[] = [
    { key: "overdue", title: "Overdue", tasks: [] },
    { key: "today", title: "Today", tasks: [] },
    { key: "next-7-days", title: "Next 7 days", tasks: [] },
    { key: "later", title: "Later", tasks: [] },
    { key: "no-date", title: "No due date", tasks: [] },
  ];
  const [overdue, dueToday, soon, later, noDate] = groups;
  for (const task of tasks) {
    if (!task.dueOn) noDate.tasks.push(task);
    else if (task.dueOn < today) overdue.tasks.push(task);
    else if (task.dueOn === today) dueToday.tasks.push(task);
    else if (task.dueOn <= weekEnd) soon.tasks.push(task);
    else later.tasks.push(task);
  }
  return groups.filter((g) => g.tasks.length > 0);
}

// The viewer's own sections in order; a task without a placement (just assigned) sits at the top of
// Recently assigned, which is where the database puts it on the next load.
function groupBySection(tasks: MyTask[], sections: MyTaskSection[], placements: Record<string, MyTaskPlacement>) {
  const recent = sections.find((s) => s.kind === "recently_assigned") ?? sections[0];
  const bySection = new Map<string, MyTask[]>(sections.map((s) => [s.id, []]));
  const order = (task: MyTask) => placements[task.id]?.sortOrder ?? Number.NEGATIVE_INFINITY;
  for (const task of tasks) {
    const sectionId = placements[task.id]?.sectionId;
    const list = (sectionId && bySection.get(sectionId)) || (recent ? bySection.get(recent.id) : undefined);
    list?.push(task);
  }
  return sections.map<Group>((section) => ({
    key: section.id,
    title: section.name,
    section,
    tasks: (bySection.get(section.id) ?? []).sort((a, b) => {
      const x = order(a);
      const y = order(b);
      return x === y ? 0 : x < y ? -1 : 1;
    }),
  }));
}

function sortOrderFor(tasks: MyTask[], placements: Record<string, MyTaskPlacement>, beforeId: string | null, movingId: string) {
  const orders = tasks.filter((t) => t.id !== movingId).map((t) => ({ id: t.id, order: placements[t.id]?.sortOrder ?? 0 }));
  const index = beforeId ? orders.findIndex((o) => o.id === beforeId) : -1;
  if (index === -1) return (orders.at(-1)?.order ?? 0) + 1024;
  const next = orders[index].order;
  const prev = index > 0 ? orders[index - 1].order : next - 2048;
  return (prev + next) / 2;
}

// The top-level task a My tasks row's subtask tree is loaded by (subtask trees load per top-level task):
// the row itself, or its root when the row is a subtask and the data says which (rootTaskId).
export function myTaskRootId(task: MyTask): string {
  return (task as MyTask & { rootTaskId?: string | null }).rootTaskId ?? task.id;
}

// Rows whose subtasks can be opened under them: open tasks with subtasks.
export function expandableMyTasks(tasks: MyTask[]): { id: string; rootId: string }[] {
  return tasks.filter((task) => !task.completedAt && (task.subtaskCount ?? 0) > 0).map((task) => ({ id: task.id, rootId: myTaskRootId(task) }));
}

const NO_AWAITING: AwaitingApproval[] = [];

export function MyTasksView({
  open,
  completed,
  bulk,
  layout: initialLayout,
  sections,
  placements: savedPlacements,
  expandedTaskIds,
  subtasks = null,
  awaiting = NO_AWAITING,
  profiles = [],
}: {
  open: MyTask[];
  completed: MyTask[];
  bulk: Omit<BulkContext, "project">;
  layout: MyTasksLayout;
  sections: MyTaskSection[];
  placements: Record<string, MyTaskPlacement>;
  // Oct 27 notes (batch 6): rows this person opened, the subtask trees the server loaded for them, the
  // approvals waiting on them, and the people a subtask can be assigned to.
  expandedTaskIds?: string[];
  subtasks?: SubtaskItem[] | null;
  awaiting?: AwaitingApproval[];
  profiles?: Profile[];
}) {
  // The task whose pane is open (instant: no server render on open / close; Oct 19 notes).
  const openTaskId = useOpenTaskId();
  const openTask = useOpenTask();
  const { member } = useShell();
  const seed = (task: MyTask): TaskSeed => seedFromMyTask(task, { id: member.id, name: member.name });
  const today = useToday();
  const [, run] = useServerAction();
  const notify = useNotify();
  const bulkEdit = useBulkEdit();
  const [layout, setLayout] = useState<MyTasksLayout>(initialLayout);
  const pages = useGroupPages();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["completed"]));
  const [draggingTask, setDraggingTask] = useState<string | null>(null);
  const [taskDrop, setTaskDrop] = useState<{ sectionId: string; beforeId: string | null } | null>(null);
  const [draggingSection, setDraggingSection] = useState<string | null>(null);
  const [sectionDrop, setSectionDrop] = useState<{ beforeId: string | null } | null>(null);
  // "+ Add task" in the toolbar opens an add row at the top (Recently assigned, where new tasks land).
  const [topAdd, setTopAdd] = useState<number | null>(null);
  const [toggled, setToggled] = useOptimistic(
    new Map<string, boolean>(),
    (current, change: { id: string; completed: boolean }) => new Map(current).set(change.id, change.completed),
  );
  const [placements, movePlacement] = useOptimistic(
    savedPlacements,
    (current, move: { taskId: string } & MyTaskPlacement) => ({
      ...current,
      [move.taskId]: { sectionId: move.sectionId, sortOrder: move.sortOrder },
    }),
  );
  const [orderedSections, moveSectionLocally] = useOptimistic(sections, (current, move: { id: string; sortOrder: number }) =>
    current
      .map((s) => (s.id === move.id ? { ...s, sortOrder: move.sortOrder } : s))
      .sort((a, b) => a.sortOrder - b.sortOrder),
  );

  // Row edits (Oct 27 notes, batch 6): a rename shows at once; a new due date too, until the page's
  // fresh data (or a cancelled prompt) replaces it.
  const [titles, setTitle] = useOptimistic(
    new Map<string, string>(),
    (current, change: { id: string; title: string }) => new Map(current).set(change.id, change.title),
  );
  const [dueEdits, setDueEdits] = useState<Record<string, string | null>>({});
  const [seenOpen, setSeenOpen] = useState(open);
  if (seenOpen !== open) {
    setSeenOpen(open);
    setDueEdits({});
  }
  const edited = (task: MyTask): MyTask => {
    const title = titles.get(task.id);
    const due = task.id in dueEdits ? dueEdits[task.id] : undefined;
    if (title === undefined && due === undefined) return task;
    return {
      ...task,
      ...(title !== undefined ? { title: displayTaskTitle(title, task.requestLabel) } : {}),
      ...(due !== undefined ? { dueOn: due } : {}),
    };
  };
  const openTasks = open.map(edited);
  const shift = useDependencyShift();
  const trees = useSubtaskTrees({ initialExpanded: expandedTaskIds, serverSubtasks: subtasks, rows: expandableMyTasks(open) });

  const bySections = layout === "sections" && orderedSections.length > 0;
  const isDone = (task: MyTask) => toggled.get(task.id) ?? Boolean(task.completedAt);
  const toggle = (task: MyTask) => {
    const next = !isDone(task);
    // A blocked task has a lock instead of a checkbox; never try (and undo) completing it.
    if (next && blockedCount(task) > 0) return;
    run(
      () => setTaskCompleted(task.id, next),
      () => setToggled({ id: task.id, completed: next }),
    );
  };
  const rename = (task: MyTask, title: string) =>
    run(
      () => updateTask(task.id, { title }),
      () => setTitle({ id: task.id, title }),
    );
  // Subtasks shown under rows: edits show at once and are kept until fresh data arrives.
  const showMoves = (moves: { taskId: string; startOn: string | null; dueOn: string | null }[], before: Map<string, RowPatch | undefined>) => {
    for (const move of moves) {
      if (tasksById.has(move.taskId)) continue; // a row of My tasks: the page's refresh brings it
      const patch = { startOn: move.startOn, dueOn: move.dueOn };
      if (!before.has(move.taskId)) before.set(move.taskId, trees.keptPatch(move.taskId));
      trees.show(move.taskId, patch);
      trees.keep(move.taskId, patch);
    }
  };
  // My tasks rows know the due date only: the start date is left as it is.
  const changeDue = (task: MyTask, edit: DateEdit, close: () => void) => {
    if (edit.dueOn === undefined || edit.dueOn === task.dueOn) return;
    const dueOn = edit.dueOn;
    const before = new Map<string, RowPatch | undefined>();
    setDueEdits((current) => ({ ...current, [task.id]: dueOn }));
    shift.changeMany([{ taskId: task.id, dueOn }], `“${task.title}”`, null, {
      onPrompt: close,
      onOptimistic: (moves) => showMoves(moves, before),
      onRevert: () => {
        setDueEdits((current) => {
          const next = { ...current };
          delete next[task.id];
          return next;
        });
        before.forEach((previous, id) => trees.restore(id, previous));
      },
    });
  };
  const editSubtask = (subtask: SubtaskItem, patch: RowPatch, action: () => Promise<ActionResult>) =>
    run(
      async () => {
        const result = await action();
        if (!result.error) trees.keep(subtask.id, patch);
        return result;
      },
      () => trees.show(subtask.id, patch),
    );
  const subtaskHandlers: MySubtaskHandlers = {
    toggle(subtask) {
      const done = !subtask.completedAt;
      if (done && blockedCount(subtask) > 0) return;
      editSubtask(subtask, { completedAt: done ? new Date().toISOString() : null }, () => setTaskCompleted(subtask.id, done));
    },
    rename: (subtask, title) => editSubtask(subtask, { title }, () => updateSubtask(subtask.id, { title })),
    assign(subtask, assigneeId) {
      if (assigneeId !== subtask.assigneeId) editSubtask(subtask, { assigneeId }, () => updateTask(subtask.id, { assigneeId }));
    },
    dates(subtask, edit, close) {
      const dates = mergeDateEdit(subtask, edit, subtask.kind === "milestone");
      if (!dates) return;
      const before = new Map<string, RowPatch | undefined>();
      shift.changeDates(subtask, dates, {
        onPrompt: close,
        onOptimistic: (moves) => showMoves(moves, before),
        onRevert: () => before.forEach((previous, id) => trees.restore(id, previous)),
      });
    },
    expand: (id) => trees.toggle(id),
  };

  function chooseLayout(next: MyTasksLayout) {
    setLayout(next);
    document.cookie = `${MY_TASKS_LAYOUT_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }

  const openGroups: Group[] = bySections
    ? groupBySection(openTasks, orderedSections, placements)
    : today === null
      ? []
      : groupByDue(openTasks, today);
  const groups: Group[] = [
    ...openGroups,
    ...(completed.length > 0 ? [{ key: "completed", title: "Recently completed", tasks: completed }] : []),
  ];
  const tasksById = new Map([...openTasks, ...completed].map((t) => [t.id, t]));
  const approvalShortcut = useApprovalShortcut();
  const shownIds = (key: string, list: { id: string }[]) => list.slice(0, pages.limit(key)).map((task) => task.id);
  const selection = useTaskSelection(
    groups.flatMap((g) => shownIds(g.key, g.tasks)),
    groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => shownIds(g.key, g.tasks)),
  );
  // Shortcuts act only on tasks the viewer can edit (a Viewer's or Commenter's task has no checkbox,
  // and ⌘/Ctrl+Enter or Tab→M leaves it alone instead of failing).
  const targets = () => {
    const editable = (id: string) => tasksById.get(id)?.canEdit === true;
    if (selection.selected.length) return selection.selected.filter(editable);
    const one = openTaskId && tasksById.has(openTaskId) ? openTaskId : selection.active;
    return one && editable(one) ? [one] : [];
  };

  useListKeys({
    move(delta) {
      const next = selection.move(delta);
      if (next) requestAnimationFrame(() => scrollRowIntoView(next));
    },
    open() {
      const id = selection.active ?? (selection.selected.length === 1 ? selection.selected[0] : null);
      const task = id ? tasksById.get(id) : undefined;
      if (id) openTask(id, task ? seed(task) : null);
    },
    escape() {
      if (openTaskId || selection.selected.length === 0) return false;
      selection.clear();
      return true;
    },
    complete() {
      let ids = targets();
      if (ids.length === 0) return;
      const next = !ids.every((id) => {
        const task = tasksById.get(id);
        return task ? isDone(task) : true;
      });
      if (next) {
        // One approval task the viewer doesn't approve: its approval step instead (Oct 29 notes, batch 7).
        const only = ids.length === 1 ? tasksById.get(ids[0]) : undefined;
        if (only && approvalShortcut({ ...only, completedAt: isDone(only) ? (only.completedAt ?? "done") : null }, seed(only))) return;
        // Blocked tasks can't be completed: say so and leave them out (Oct 27 notes, batch 6).
        const listed = ids.flatMap((id) => {
          const task = tasksById.get(id);
          return task ? [{ ...task, completedAt: isDone(task) ? (task.completedAt ?? "done") : null }] : [];
        });
        const { blocked } = splitBlocked(listed);
        const message = blockedSkipMessage(blocked);
        if (message) notify(message);
        const skip = new Set(blocked.map((task) => task.id));
        ids = ids.filter((id) => !skip.has(id));
        if (ids.length === 0) return;
      }
      bulkEdit.apply(ids, { action: next ? "complete" : "reopen" }, () => {
        for (const id of ids) setToggled({ id, completed: next });
      });
    },
    assignToMe() {
      const ids = targets();
      if (ids.length) bulkEdit.apply(ids, { action: "assign", assignee_id: bulk.viewerId });
    },
  });

  function dropTask(event: DragEvent) {
    event.preventDefault();
    const taskId = event.dataTransfer.getData(TASK_DRAG);
    const target = taskDrop;
    setDraggingTask(null);
    setTaskDrop(null);
    const group = openGroups.find((g) => g.key === target?.sectionId);
    if (!target || !group || !tasksById.has(taskId) || target.beforeId === taskId) return;
    const sortOrder = sortOrderFor(group.tasks, placements, target.beforeId, taskId);
    run(
      () => placeMyTask(taskId, target.sectionId, target.beforeId),
      () => movePlacement({ taskId, sectionId: target.sectionId, sortOrder }),
    );
  }

  function moveSection(sectionId: string, beforeId: string | null) {
    if (beforeId === sectionId) return;
    const others = orderedSections.filter((s) => s.id !== sectionId);
    const index = beforeId ? others.findIndex((s) => s.id === beforeId) : -1;
    const next = index === -1 ? null : others[index].sortOrder;
    const prev = index === -1 ? (others.at(-1)?.sortOrder ?? 0) : index > 0 ? others[index - 1].sortOrder : null;
    const sortOrder = next === null ? (prev ?? 0) + 1024 : prev === null ? next - 1024 : (prev + next) / 2;
    run(
      () => placeMyTaskSection(sectionId, beforeId),
      () => moveSectionLocally({ id: sectionId, sortOrder }),
    );
  }

  function dropSection(event: DragEvent) {
    event.preventDefault();
    const sectionId = event.dataTransfer.getData(SECTION_DRAG);
    const target = sectionDrop;
    setDraggingSection(null);
    setSectionDrop(null);
    if (sectionId && target) moveSection(sectionId, target.beforeId);
  }

  const rowProps = {
    openTaskId,
    seed,
    today,
    isDone,
    onToggle: toggle,
    onRename: rename,
    onDueChange: changeDue,
    selection,
    selecting: selection.selected.length > 0,
  };
  const subtaskProps = { trees, profiles, openTaskId, handlers: subtaskHandlers, today, viewer: { id: member.id, name: member.name } };
  // A row, then (when it's open) its subtasks under it.
  const expandable = (task: MyTask) => !isDone(task) && (task.subtaskCount ?? 0) > 0;
  const rowWithSubtasks = (task: MyTask, row: ReactNode) => (
    <Fragment key={task.id}>
      {row}
      {expandable(task) && trees.isExpanded(task.id) ? <MySubtaskRows task={task} {...subtaskProps} /> : null}
    </Fragment>
  );
  const expandProps = (task: MyTask) => ({
    expandable: expandable(task),
    expanded: expandable(task) && trees.isExpanded(task.id),
    onToggleExpanded: () => trees.toggle(task.id),
  });
  const collapseProps = (key: string) => ({
    collapsed: collapsed.has(key),
    onToggleCollapsed: () =>
      setCollapsed((c) => {
        const next = new Set(c);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
  });

  const recentSectionId = (orderedSections.find((s) => s.kind === "recently_assigned") ?? orderedSections[0])?.id ?? null;
  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      <button type="button" onClick={() => setTopAdd((n) => (n ?? 0) + 1)} className="btn-primary h-7 gap-1 px-2.5">
        <Plus className="size-3.5" aria-hidden />
        Add task
      </button>
      <p className="mr-auto text-xs text-zinc-500">
        {bySections
          ? "Drag tasks between your sections; only you see them. Newly assigned tasks land in Recently assigned."
          : "Grouped by due date, in your local time."}
      </p>
      <Segmented label="Group My tasks by" options={LAYOUTS} value={layout} onChange={chooseLayout} />
    </div>
  );
  // In the due-date layout there are no sections to add into: the row sits above the groups.
  const topAddRow =
    topAdd !== null && !bySections ? (
      <ul className="mt-3 border-y border-zinc-100">
        <MyAddTaskRow key={`top-${topAdd}`} sectionId={null} defaultOpen onClose={() => setTopAdd(null)} />
      </ul>
    ) : null;

  // Oct 27 notes (batch 6): approvals waiting on the viewer, above everything else (not selectable or
  // draggable; a row opens the task).
  const awaitingGroup =
    awaiting.length > 0 ? (
      <TaskGroup id="awaiting" title="Waiting on me to approve" count={awaiting.length} {...collapseProps("awaiting")}>
        {awaiting.map((item) => (
          <AwaitingRow key={item.requestId} item={item} openTaskId={openTaskId} />
        ))}
      </TaskGroup>
    ) : null;

  // With sections, an empty My Tasks still shows them (with their "Add task…" rows), like Asana.
  if (open.length === 0 && completed.length === 0 && !bySections) {
    return (
      <>
        {toolbar}
        {awaitingGroup}
        <div className="mt-6">
          <EmptyState icon={CircleCheck} title="Nothing assigned to you">
            Tasks you’re assigned to in any project show up here: new ones in Recently assigned, ready to sort into
            your own sections — or grouped by due date. Use Add task to keep a private to-do.
          </EmptyState>
        </div>
        {topAddRow}
      </>
    );
  }

  return (
    <div className="pb-20">
      {toolbar}
      {awaitingGroup}
      {topAddRow}
      {!bySections && today === null ? (
        <div role="status" className="mt-4">
          <span className="sr-only">Loading your tasks…</span>
          <SkeletonRows rows={Math.min(open.length || 3, 8)} />
        </div>
      ) : bySections ? (
        <>
          {openGroups.map((group, index) => {
            const section = group.section!;
            const isTarget = draggingTask !== null && taskDrop?.sectionId === section.id;
            return (
              <TaskGroup
                key={group.key}
                id={group.key}
                title={group.title}
                count={group.tasks.length}
                {...collapseProps(group.key)}
                dropBefore={draggingSection !== null && sectionDrop?.beforeId === section.id}
                highlight={isTarget && taskDrop?.beforeId === null}
                controls={
                  <SectionControls
                    section={section}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(SECTION_DRAG, section.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDraggingSection(section.id);
                    }}
                    onDragEnd={() => {
                      setDraggingSection(null);
                      setSectionDrop(null);
                    }}
                    onUp={index > 0 ? () => moveSection(section.id, openGroups[index - 1].key) : undefined}
                    onDown={
                      index < openGroups.length - 1
                        ? () => moveSection(section.id, openGroups[index + 2]?.key ?? null)
                        : undefined
                    }
                  />
                }
                onHeaderDragOver={(e) => {
                  if (!draggingSection || draggingSection === section.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const box = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > box.top + box.height / 2;
                  setSectionDrop({ beforeId: after ? (openGroups[index + 1]?.key ?? null) : section.id });
                }}
                onHeaderDrop={draggingSection ? dropSection : undefined}
                onBodyDragOver={(e) => {
                  if (!draggingTask) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setTaskDrop((current) => (current?.sectionId === section.id ? current : { sectionId: section.id, beforeId: null }));
                }}
                onBodyDrop={draggingTask ? dropTask : undefined}
                empty={draggingTask ? "Drop here" : undefined}
              >
                {topAdd !== null && section.id === recentSectionId ? (
                  <MyAddTaskRow
                    key={`top-${topAdd}`}
                    sectionId={null}
                    defaultOpen
                    onClose={() => setTopAdd(null)}
                  />
                ) : null}
                {group.tasks.slice(0, pages.limit(section.id)).map((task, i) =>
                  rowWithSubtasks(
                    task,
                  <MyTaskRow
                    task={task}
                    {...rowProps}
                    {...expandProps(task)}
                    dropBefore={isTarget && taskDrop?.beforeId === task.id}
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
                    onDragOver={(e) => {
                      if (!draggingTask || draggingTask === task.id) return;
                      e.preventDefault();
                      const box = e.currentTarget.getBoundingClientRect();
                      const after = e.clientY > box.top + box.height / 2;
                      setTaskDrop({ sectionId: section.id, beforeId: after ? (group.tasks[i + 1]?.id ?? null) : task.id });
                    }}
                  />,
                  ),
                )}
                {group.tasks.length > pages.limit(section.id) ? (
                  <li>
                    <ShowMoreRows
                      hidden={group.tasks.length - pages.limit(section.id)}
                      onClick={() => pages.showMore(section.id)}
                    />
                  </li>
                ) : null}
                {isTarget && taskDrop?.beforeId === null && group.tasks.length > 0 ? (
                  <li aria-hidden>
                    <DropLine />
                  </li>
                ) : null}
                <MyAddTaskRow sectionId={section.id} />
              </TaskGroup>
            );
          })}
          {draggingSection ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setSectionDrop({ beforeId: null });
              }}
              onDrop={dropSection}
              className={`mt-3 rounded-md border border-dashed px-3 py-2 text-center text-xs ${
                sectionDrop?.beforeId === null ? "border-accent-500 bg-accent-50 text-accent-700" : "border-zinc-300 text-zinc-400"
              }`}
            >
              Drop here to move the section to the end
            </div>
          ) : null}
          <AddSection />
        </>
      ) : (
        openGroups.map((group) => (
          <TaskGroup key={group.key} id={group.key} title={group.title} count={group.tasks.length} {...collapseProps(group.key)}>
            {group.tasks.slice(0, pages.limit(group.key)).map((task) =>
              rowWithSubtasks(task, <MyTaskRow task={task} {...rowProps} {...expandProps(task)} />),
            )}
            {group.tasks.length > pages.limit(group.key) ? (
              <ShowMoreRows hidden={group.tasks.length - pages.limit(group.key)} onClick={() => pages.showMore(group.key)} />
            ) : null}
          </TaskGroup>
        ))
      )}
      {open.length === 0 && !bySections ? (
        <div className="mt-4">
          <EmptyState icon={CheckCheck} title="You’re all caught up" size="inline">
            No open tasks are assigned to you. Completed ones are listed below.
          </EmptyState>
        </div>
      ) : null}
      {completed.length > 0 ? (
        <TaskGroup id="completed" title="Recently completed" count={completed.length} {...collapseProps("completed")}>
          {completed.map((task) => (
            <MyTaskRow key={task.id} task={task} {...rowProps} />
          ))}
        </TaskGroup>
      ) : null}
      <BulkBar
        // A Shift-range can span read-only rows; the bar only ever acts on tasks the viewer can edit.
        selected={selection.selected.filter((id) => tasksById.get(id)?.canEdit === true)}
        completedCount={selection.selected.filter((id) => tasksById.get(id)?.canEdit === true).filter((id) => {
          const task = tasksById.get(id);
          return task ? isDone(task) : false;
        }).length}
        context={bySections ? { ...bulk, mySections: orderedSections.map(({ id, name }) => ({ id, name })) } : bulk}
        bulk={bulkEdit}
        onClear={selection.clear}
      />
      {/* "Move dependent tasks too?" after a date change in a row. */}
      {shift.dialog}
    </div>
  );
}

// Asana's inline "Add task…" row. The task is private (no project): only you and whoever you assign it
// to can see it; adding it to a project (from the task pane) makes it an ordinary task of that project.
// With a section it lands at the end of that section, else at the top of Recently assigned.
function MyAddTaskRow({
  sectionId,
  defaultOpen = false,
  onClose,
}: {
  sectionId: string | null;
  defaultOpen?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [title, setTitle] = useState("");
  const [pending, run] = useServerAction();
  const inputId = `my-tasks-add-${sectionId ?? "top"}`;
  const close = () => {
    setOpen(false);
    setTitle("");
    onClose?.();
  };

  if (!open) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex min-h-row w-full items-center gap-2 pl-9 pr-3 text-left text-sm text-zinc-400 hover:bg-zinc-50 hover:text-zinc-700"
        >
          <Plus className="size-4" aria-hidden />
          Add task…
        </button>
      </li>
    );
  }

  return (
    <li>
      <form
        className="flex items-center gap-2 py-1.5 pl-9 pr-3"
        onSubmit={(e) => {
          e.preventDefault();
          const value = title.trim();
          if (!value) return;
          setTitle("");
          run(() => createPrivateTask(value, sectionId));
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          New private task name
        </label>
        <input
          id={inputId}
          autoFocus
          value={title}
          maxLength={1000}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={(e) => {
            if (!e.currentTarget.value.trim()) close();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
          placeholder={pending ? "Adding…" : "Task name, then Enter"}
          aria-describedby={`${inputId}-hint`}
          className="control min-w-0 flex-1"
        />
        <span id={`${inputId}-hint`} className="hidden shrink-0 items-center gap-1 text-xs text-zinc-500 md:inline-flex">
          <Lock className="size-3" aria-hidden />
          Private to you
        </span>
      </form>
    </li>
  );
}

function DropLine() {
  return <div aria-hidden className="h-0.5 rounded-full bg-accent-500" />;
}

function AddSection() {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [, run] = useServerAction();

  function save() {
    const value = name.trim();
    setAdding(false);
    setName("");
    if (value) run(() => createMyTaskSection(value));
  }

  if (!adding) {
    return (
      <button type="button" onClick={() => setAdding(true)} className="btn-ghost mt-3 text-zinc-500">
        <Plus className="size-4" aria-hidden />
        Add section
      </button>
    );
  }
  return (
    <form
      className="mt-3 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label htmlFor="my-task-section-name" className="sr-only">
        New section name
      </label>
      <input
        id="my-task-section-name"
        autoFocus
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setName("");
            setAdding(false);
          }
        }}
        placeholder="Section name"
        className="control w-64"
      />
    </form>
  );
}

// Drag handle, Move up / Move down (keyboard path), and Rename / Delete for custom sections.
function SectionControls({
  section,
  onDragStart,
  onDragEnd,
  onUp,
  onDown,
}: {
  section: MyTaskSection;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const [, run] = useServerAction();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const reveal = "opacity-0 focus-visible:opacity-100 group-hover/section:opacity-100 [@media(hover:none)]:opacity-100";
  const iconButton = `rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 ${reveal}`;

  if (renaming) {
    return (
      <input
        autoFocus
        aria-label={`Rename section ${section.name}`}
        defaultValue={section.name}
        maxLength={100}
        onBlur={(e) => {
          const value = e.currentTarget.value.trim();
          setRenaming(false);
          if (value && value !== section.name) run(() => renameMyTaskSection(section.id, value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = section.name;
            e.currentTarget.blur();
          }
        }}
        className="control h-7 w-56"
      />
    );
  }
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
        <button type="button" onClick={onUp} aria-label={`Move section ${section.name} up`} title="Move up" className={iconButton}>
          <ArrowUp className="size-3.5" />
        </button>
      ) : null}
      {onDown ? (
        <button type="button" onClick={onDown} aria-label={`Move section ${section.name} down`} title="Move down" className={iconButton}>
          <ArrowDown className="size-3.5" />
        </button>
      ) : null}
      {section.kind === "custom" ? (
        <Popover
          label={`Section ${section.name} options`}
          buttonClassName={iconButton}
          panelClassName="w-48"
          button={<Ellipsis className="size-4" />}
        >
          {(close) => (
            <div className="flex flex-col">
              <MenuItem
                onClick={() => {
                  close();
                  setRenaming(true);
                }}
              >
                <Pencil className="size-4 text-zinc-400" aria-hidden />
                Rename
              </MenuItem>
              <MenuItem
                danger
                onClick={async () => {
                  close();
                  if (
                    await confirm({
                      title: `Delete “${section.name}”?`,
                      message: "Its tasks move to Recently assigned.",
                      confirmLabel: "Delete",
                      tone: "danger",
                    })
                  ) {
                    run(() => deleteMyTaskSection(section.id));
                  }
                }}
              >
                <Trash2 className="size-4" aria-hidden />
                Delete section
              </MenuItem>
            </div>
          )}
        </Popover>
      ) : null}
    </span>
  );
}

function TaskGroup({
  id,
  title,
  count,
  collapsed,
  onToggleCollapsed,
  controls,
  dropBefore = false,
  highlight = false,
  onHeaderDragOver,
  onHeaderDrop,
  onBodyDragOver,
  onBodyDrop,
  empty,
  children,
}: {
  id: string;
  title: string;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  controls?: ReactNode;
  dropBefore?: boolean;
  highlight?: boolean;
  onHeaderDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onHeaderDrop?: (e: DragEvent) => void;
  onBodyDragOver?: (e: DragEvent<HTMLElement>) => void;
  onBodyDrop?: (e: DragEvent) => void;
  empty?: string;
  children: ReactNode;
}) {
  const headingId = `group-${id}`;
  return (
    <section className="group/section mt-4" aria-labelledby={headingId} onDragOver={onBodyDragOver} onDrop={onBodyDrop}>
      {dropBefore ? <DropLine /> : null}
      <div className="flex items-center gap-1" onDragOver={onHeaderDragOver} onDrop={onHeaderDrop}>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          className="flex h-8 items-center gap-1 rounded px-1 text-sm font-semibold text-zinc-900 hover:bg-zinc-100"
        >
          {collapsed ? <ChevronRight className="size-4 text-zinc-400" /> : <ChevronDown className="size-4 text-zinc-400" />}
          <span id={headingId}>{title}</span>
          <span className="text-xs font-normal tabular-nums text-zinc-400">{count}</span>
        </button>
        {controls}
      </div>
      {collapsed ? null : (
        <ul className={`border-t border-zinc-200 ${highlight ? "bg-accent-50/60" : ""}`}>
          {children}
          {count === 0 && empty ? <li className="px-3 py-2 text-xs text-zinc-400">{empty}</li> : null}
        </ul>
      )}
    </section>
  );
}

// A row's name: Editors click it to rename in place (Enter saves, Escape cancels) and open the task with
// the ">" after it or a click elsewhere on the row; below Editor it is a link to the task. The stored name
// has no number in front (the label is drawn from the task's project).
function RowTitle({
  taskId,
  title,
  bareTitle,
  done,
  canEdit,
  open,
  seed,
  subtask = false,
  after = null,
  onRename,
  onEditingChange,
}: {
  taskId: string;
  // As shown (with the number in front).
  title: string;
  // As stored (what the rename box starts from).
  bareTitle: string;
  done: boolean;
  canEdit: boolean;
  open: boolean;
  seed: () => TaskSeed;
  subtask?: boolean;
  // Right after the name: the "+N" of a task numbered in several projects (Oct 29 notes, 55b).
  after?: ReactNode;
  onRename: (title: string) => void;
  // Renaming: a draggable row stops being draggable so the mouse can select text.
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditingState] = useState(false);
  const setEditing = (next: boolean) => {
    setEditingState(next);
    onEditingChange?.(next);
  };
  const tone = done ? "text-zinc-400 line-through" : subtask ? "text-zinc-700" : "text-zinc-900";
  const prefix = subtask ? <span className="sr-only">Subtask: </span> : null;
  if (!canEdit) {
    const link = (
      <TaskLink
        taskId={taskId}
        seed={seed}
        draggable={false}
        data-task-link=""
        aria-current={open ? "true" : undefined}
        className={`min-w-0 truncate text-sm hover:underline ${tone} ${after ? "" : "flex-1"}`}
      >
        {prefix}
        {title}
      </TaskLink>
    );
    return after ? (
      <span className="flex min-w-0 flex-1 items-center gap-1">
        {link}
        {after}
      </span>
    ) : (
      link
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      {editing ? (
        <input
          autoFocus
          defaultValue={bareTitle}
          maxLength={500}
          aria-label={subtask ? "Subtask name" : "Task name"}
          draggable={false}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            const next = e.currentTarget.value.trim();
            setEditing(false);
            if (next && next !== bareTitle) onRename(next);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = bareTitle;
              e.currentTarget.blur();
            }
          }}
          className="h-6 min-w-0 flex-1 rounded border border-accent-500/60 bg-white px-1 text-sm text-zinc-900 shadow-[0_0_0_3px_var(--focus-ring)] focus:outline-none"
        />
      ) : (
        <button
          type="button"
          draggable={false}
          onClick={() => setEditing(true)}
          title="Rename"
          aria-label={`Rename “${title}”`}
          className={`-mx-1 min-w-0 truncate rounded px-1 text-left text-sm ring-zinc-200 group-hover:ring-1 hover:ring-zinc-300 ${tone}`}
        >
          {prefix}
          {title}
        </button>
      )}
      {editing ? null : after}
      <TaskLink
        taskId={taskId}
        seed={seed}
        draggable={false}
        data-task-link=""
        aria-label={`Open “${title}”`}
        aria-current={open ? "true" : undefined}
        title="Details"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 opacity-0 hover:bg-zinc-200/70 hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <ChevronRight className="size-4" />
      </TaskLink>
    </span>
  );
}

// A click on the row itself (not a control) opens the task. Clicks inside a cell's picker (drawn on
// <body>, but the row's child in React) aren't the row's.
function rowClickOpens(e: React.MouseEvent<HTMLElement>) {
  const target = e.target as HTMLElement;
  if (!e.currentTarget.contains(target)) return "outside" as const;
  return target.closest("a, button, input, select, textarea, label") ? ("control" as const) : ("row" as const);
}

// The due date as My tasks shows it: red when overdue.
function MyDueDate({ dueOn, done, today }: { dueOn: string | null; done: boolean; today: string | null }) {
  if (!dueOn) return null;
  const overdue = Boolean(today && !done && dueOn < today);
  return (
    <span className={`ml-auto text-xs tabular-nums ${overdue ? "font-medium text-red-600" : "text-zinc-500"}`}>
      {formatDueDate(dueOn, today ? Number(today.slice(0, 4)) : undefined)}
      {overdue ? <span className="sr-only"> (overdue)</span> : null}
    </span>
  );
}

function MyTaskRow({
  task,
  openTaskId,
  seed,
  today,
  isDone,
  onToggle,
  onRename,
  onDueChange,
  selection,
  selecting,
  expandable = false,
  expanded = false,
  onToggleExpanded,
  dragging = false,
  dropBefore = false,
  onDragStart,
  onDragEnd,
  onDragOver,
}: {
  task: MyTask;
  openTaskId: string | null;
  seed: (task: MyTask) => TaskSeed;
  today: string | null;
  isDone: (task: MyTask) => boolean;
  onToggle: (task: MyTask) => void;
  onRename: (task: MyTask, title: string) => void;
  onDueChange: (task: MyTask, edit: DateEdit, close: () => void) => void;
  selection: TaskSelection;
  selecting: boolean;
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  dragging?: boolean;
  dropBefore?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: DragEvent<HTMLLIElement>) => void;
}) {
  const openTask = useOpenTask();
  const seedThis = () => seed(task);
  // Hovering the row fetches the pane's data, so a click usually finds it ready.
  const prefetch = useTaskPrefetch(task.id, seedThis);
  const done = isDone(task);
  const open = openTaskId === task.id;
  const selected = selection.isSelected(task.id);
  const blocked = done ? 0 : blockedCount(task);
  const [renaming, setRenaming] = useState(false);

  return (
    <li
      data-task-row={task.id}
      draggable={Boolean(onDragStart) && !renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onPointerEnter={prefetch.onPointerEnter}
      onPointerLeave={prefetch.onPointerLeave}
      onClick={(e) => {
        const where = rowClickOpens(e);
        if (where === "outside") return;
        if (where === "control") {
          // The title link opens the task too (⌘/Ctrl-click: a new tab, the browser's own behaviour).
          if ((e.target as HTMLElement).closest("a")) selection.setActive(task.id);
          return;
        }
        // Clicking a row opens the task; only the checkbox on the left selects (and brings up the bulk bar).
        selection.setActive(task.id);
        if (!open) openTask(task.id, seedThis());
      }}
      className={`cv-row group flex min-h-row cursor-pointer items-center gap-3 border-b border-zinc-100 px-3 py-1 ${
        dropBefore ? "shadow-[inset_0_2px_0_var(--color-accent-500)]" : ""
      } ${
        selected ? "bg-accent-50" : open ? "bg-accent-50/60" : "hover:bg-zinc-50"
      } ${selection.cursor === task.id ? "shadow-[inset_2px_0_0_var(--color-accent-500)]" : ""} ${
        dragging ? "opacity-40" : ""
      } ${onDragStart ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      {task.canEdit ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => undefined}
          onClick={(e) => {
            e.stopPropagation();
            selection.toggle(task.id, e.shiftKey);
          }}
          aria-label={`Select “${task.title}”`}
          className={`-mr-1 size-3.5 shrink-0 rounded border-zinc-300 accent-accent-600 ${
            selected || selecting ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          }`}
        />
      ) : (
        // A task the viewer can only read (Viewer / Commenter in its projects): nothing to select or tick.
        <span aria-hidden className="-mr-1 size-3.5 shrink-0" />
      )}
      <ExpandToggle
        expandable={expandable}
        expanded={expanded}
        title={task.title}
        onToggle={() => onToggleExpanded?.()}
        className="-mr-1"
      />
      {/* My tasks are assigned to the viewer: an approval task they don't approve is theirs to send. */}
      <RowCompleteControl
        task={task}
        completed={done}
        readOnly={!task.canEdit}
        assignedToMe
        blocked={blocked}
        seed={seedThis}
        onToggle={() => onToggle(task)}
      />
      <RowTitle
        taskId={task.id}
        title={task.title}
        bareTitle={bareTaskTitle(task.title, task.requestLabel)}
        after={<MoreTaskNumbers numbers={task.taskNumbers} />}
        done={done}
        canEdit={task.canEdit}
        open={open}
        seed={seedThis}
        onRename={(title) => onRename(task, title)}
        onEditingChange={setRenaming}
      />
      {task.kind === "approval" && task.approvalStatus ? (
        <ApprovalStatusBadge status={task.approvalStatus} paused={task.approvalPaused} />
      ) : null}
      {(task.subtaskCount ?? 0) > 0 ? (
        <span
          className="hidden shrink-0 items-center gap-1 text-xs tabular-nums text-zinc-500 sm:inline-flex"
          title={`${task.subtaskDoneCount ?? 0} of ${task.subtaskCount} subtasks done`}
        >
          {task.subtaskDoneCount ?? 0}/{task.subtaskCount}
          <span className="sr-only"> subtasks done</span>
        </span>
      ) : null}
      {task.parentTitle ? (
        <span className="hidden max-w-40 shrink-0 truncate text-xs text-zinc-500 md:inline" title={`Subtask of ${task.parentTitle}`}>
          <span className="sr-only">Subtask of </span>
          <span aria-hidden>in </span>
          {task.parentTitle}
        </span>
      ) : null}
      {task.projectId ? (
        <Link
          href={`/projects/${task.projectId}/list`}
          draggable={false}
          className="chip hidden max-w-40 shrink-0 truncate hover:bg-zinc-200 hover:text-zinc-900 sm:inline-flex"
        >
          <FolderClosed className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{task.projectName}</span>
        </Link>
      ) : (
        <span
          className="chip hidden shrink-0 sm:inline-flex"
          title="Private: only you and its assignee can see it, until it’s added to a project"
        >
          <Lock className="size-3 shrink-0" aria-hidden />
          Private
        </span>
      )}
      <span className="flex w-20 shrink-0 justify-end">
        <InlineDateCell
          taskTitle={task.title}
          column="due-only"
          dueOn={task.dueOn}
          canEdit={task.canEdit}
          display={task.dueOn ? <MyDueDate dueOn={task.dueOn} done={done} today={today} /> : <EmptyCellHint kind="date" hidden={!task.canEdit} />}
          onChange={(edit, close) => onDueChange(task, edit, close)}
        />
      </span>
    </li>
  );
}

type MySubtaskHandlers = {
  toggle: (subtask: SubtaskItem) => void;
  rename: (subtask: SubtaskItem, title: string) => void;
  assign: (subtask: SubtaskItem, assigneeId: string | null) => void;
  dates: (subtask: SubtaskItem, edit: DateEdit, close: () => void) => void;
  expand: (id: string) => void;
};

type MySubtaskProps = {
  trees: SubtaskTrees;
  profiles: Profile[];
  openTaskId: string | null;
  handlers: MySubtaskHandlers;
  today: string | null;
  viewer: { id: string; name: string };
};

// A subtask row sits under its parent's completion control, 1.5rem further in per level.
const MY_SUBTASK_BASE_REM = 2.125;

// An open row's subtasks (Oct 27 notes, batch 6): every level, indented, each expandable when it has
// subtasks of its own, edited in place (complete, rename, assignee, dates) when the viewer can edit the
// task they belong to. They aren't selected or dragged.
function MySubtaskRows({ task, trees, ...rest }: { task: MyTask } & MySubtaskProps) {
  const rootId = myTaskRootId(task);
  const bare = bareTaskTitle(task.title, task.requestLabel);
  if (trees.isLoading(rootId)) {
    return (
      <li role="status" className="flex min-h-row items-center border-b border-zinc-100 text-xs text-zinc-400" style={{ paddingLeft: `${MY_SUBTASK_BASE_REM + 1.5}rem` }}>
        Loading subtasks…
      </li>
    );
  }
  const rows = flattenSubtaskRows(task.id, bare, trees.childrenOf, trees.isExpanded);
  if (rows.length === 0) {
    // A subtask whose own subtasks this page can't load (it only loads trees by their top-level task).
    return (
      <li className="flex min-h-row items-center border-b border-zinc-100 text-xs text-zinc-500" style={{ paddingLeft: `${MY_SUBTASK_BASE_REM + 1.5}rem` }}>
        <TaskLink taskId={task.id} seedData={seedFromTitle(task.id, task.title)} className="hover:underline">
          Open the task to see its subtasks
        </TaskLink>
      </li>
    );
  }
  return (
    <>
      {rows.map((row) => (
        <MySubtaskRow key={row.item.id} row={row} parent={task} trees={trees} {...rest} />
      ))}
    </>
  );
}

function MySubtaskRow({
  row,
  parent,
  profiles,
  openTaskId,
  handlers,
  today,
}: { row: FlatSubtaskRow; parent: MyTask } & MySubtaskProps) {
  const { item: subtask, depth, parentTitle } = row;
  const openTask = useOpenTask();
  // A subtask's access is its top-level task's: the row's own permission decides.
  const canEdit = parent.canEdit;
  const done = Boolean(subtask.completedAt);
  const blocked = blockedCount(subtask);
  const open = openTaskId === subtask.id;
  const assignee = subtask.assigneeId ? profiles.find((p) => p.id === subtask.assigneeId) : undefined;
  const seed = () =>
    seedFromSubtask(subtask, { title: parentTitle, projectName: parent.projectName }, {
      canEdit,
      personName: (id) => {
        const person = profiles.find((p) => p.id === id);
        return person ? displayName(person) : null;
      },
    });
  return (
    <li
      data-subtask-row={subtask.id}
      onClick={(e) => {
        if (rowClickOpens(e) !== "row") return;
        if (!open) openTask(subtask.id, seed());
      }}
      className={`cv-row group flex min-h-row cursor-pointer items-center gap-2 border-b border-zinc-100 py-1 pr-3 ${
        open ? "bg-accent-50/60" : "hover:bg-zinc-50"
      }`}
      style={{ paddingLeft: `${MY_SUBTASK_BASE_REM + depth * 1.5}rem` }}
    >
      <ExpandToggle expandable={row.hasChildren} expanded={row.expanded} title={subtask.title} onToggle={() => handlers.expand(subtask.id)} />
      <RowCompleteControl
        task={subtask}
        completed={done}
        readOnly={!canEdit}
        blocked={blocked}
        size="sm"
        seed={seed}
        onToggle={() => handlers.toggle(subtask)}
      />
      <RowTitle
        taskId={subtask.id}
        title={displayTaskTitle(subtask.title, subtask.requestLabel)}
        bareTitle={subtask.title}
        done={done}
        canEdit={canEdit}
        open={open}
        seed={seed}
        subtask
        onRename={(title) => handlers.rename(subtask, title)}
      />
      {subtask.subtaskCount > 0 ? (
        <span
          className="inline-flex shrink-0 items-center text-xs tabular-nums text-zinc-500"
          title={`${subtask.subtaskDoneCount} of ${subtask.subtaskCount} subtasks done`}
        >
          {subtask.subtaskDoneCount}/{subtask.subtaskCount}
        </span>
      ) : null}
      <span className="flex shrink-0 items-center">
        <InlineAssigneeCell
          taskTitle={subtask.title}
          assignee={assignee}
          people={profiles}
          canEdit={canEdit && profiles.length > 0}
          showName={false}
          onChange={(assigneeId) => handlers.assign(subtask, assigneeId)}
        />
      </span>
      <span className="flex w-20 shrink-0 justify-end">
        <InlineDateCell
          taskTitle={subtask.title}
          column="due"
          startOn={subtask.startOn}
          dueOn={subtask.dueOn}
          milestone={subtask.kind === "milestone"}
          canEdit={canEdit}
          display={subtask.dueOn ? <MyDueDate dueOn={subtask.dueOn} done={done} today={today} /> : <EmptyCellHint kind="date" hidden={!canEdit} />}
          onChange={(edit, close) => handlers.dates(subtask, edit, close)}
        />
      </span>
    </li>
  );
}

// One approval waiting on the viewer (Oct 27 notes, batch 6): opens the task, with its project, due
// date, and round.
function AwaitingRow({ item, openTaskId }: { item: AwaitingApproval; openTaskId: string | null }) {
  const openTask = useOpenTask();
  const approvalAction = useApprovalAction();
  // An approval task's round waits on the viewer: its control is Approve (opens the decision in the pane,
  // Oct 29 notes, batch 7). Other requests (approval subtasks) are decided in the pane's Approvals list.
  const decides = item.isApprovalTask && item.roundNumber !== null;
  const title = displayTaskTitle(item.title, item.requestLabel);
  const seed = () =>
    seedFromTitle(item.taskId, bareTaskTitle(item.title, item.requestLabel), {
      requestLabel: item.requestLabel,
      dueOn: item.dueOn,
      projectName: item.projectName ?? (item.projectId ? undefined : "Private"),
      kind: item.isApprovalTask ? "approval" : undefined,
      // Waiting on the viewer's decision: the pane's button is Approve (Oct 29 notes, batch 7).
      completeMode: decides ? "approve" : undefined,
    });
  const prefetch = useTaskPrefetch(item.taskId, seed);
  const open = openTaskId === item.taskId;
  return (
    <li
      data-awaiting-row={item.taskId}
      onPointerEnter={prefetch.onPointerEnter}
      onPointerLeave={prefetch.onPointerLeave}
      onClick={(e) => {
        if (rowClickOpens(e) !== "row") return;
        if (!open) openTask(item.taskId, seed());
      }}
      className={`group flex min-h-row cursor-pointer items-center gap-3 border-b border-zinc-100 px-3 py-1 ${
        open ? "bg-accent-50/60" : "hover:bg-zinc-50"
      }`}
    >
      {decides ? (
        <span className="ml-[1.375rem] inline-flex shrink-0">
          <ApprovalToggle mode="approve" title={title} onAction={() => approvalAction(item.taskId, "decide", seed())} />
        </span>
      ) : (
        <span
          aria-hidden
          className="ml-[1.375rem] inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-amber-700"
        >
          <ThumbsUp className="size-[62%]" strokeWidth={2.5} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <TaskLink
          taskId={item.taskId}
          seed={seed}
          aria-current={open ? "true" : undefined}
          className="min-w-0 truncate text-sm text-zinc-900 hover:underline"
        >
          <span className="sr-only">Approve: </span>
          {title}
        </TaskLink>
        <MoreTaskNumbers numbers={item.taskNumbers} />
      </span>
      {item.roundNumber ? <span className="chip shrink-0">Round {item.roundNumber}</span> : null}
      {item.projectId ? (
        <Link
          href={`/projects/${item.projectId}/list`}
          className="chip hidden max-w-40 shrink-0 truncate hover:bg-zinc-200 hover:text-zinc-900 sm:inline-flex"
        >
          <FolderClosed className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{item.projectName}</span>
        </Link>
      ) : null}
      <span className="flex w-20 shrink-0 justify-end" title={`Sent ${dayLabel(item.sentAt.slice(0, 10), Number(item.sentAt.slice(0, 4)))}`}>
        {item.dueOn ? <DueDate task={{ dueOn: item.dueOn, completedAt: null }} /> : null}
      </span>
    </li>
  );
}
