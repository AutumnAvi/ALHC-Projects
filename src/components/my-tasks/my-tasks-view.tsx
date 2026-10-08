"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, type DragEvent, type ReactNode } from "react";
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
  Trash2,
} from "lucide-react";
import { BulkBar, useBulkEdit, type BulkContext } from "@/components/bulk/bulk-bar";
import { useTaskSelection, type TaskSelection } from "@/components/bulk/use-task-selection";
import { CompleteToggle, kindToggleLabel } from "@/components/complete-toggle";
import { MenuItem, Popover } from "@/components/popover";
import { useTaskHref } from "@/components/project/shared";
import { Segmented } from "@/components/project/view-chrome";
import { scrollRowIntoView, useListKeys } from "@/components/shortcuts/keyboard";
import { useServerAction } from "@/components/toast";
import { EmptyState, SkeletonRows } from "@/components/ui";
import {
  createMyTaskSection,
  createPrivateTask,
  deleteMyTaskSection,
  placeMyTask,
  placeMyTaskSection,
  renameMyTaskSection,
  setTaskCompleted,
} from "@/lib/actions";
import { addDays, formatDueDate, useToday } from "@/lib/dates";
import type { MyTask } from "@/lib/data";
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

export function MyTasksView({
  open,
  completed,
  openTaskId,
  bulk,
  layout: initialLayout,
  sections,
  placements: savedPlacements,
}: {
  open: MyTask[];
  completed: MyTask[];
  openTaskId: string | null;
  bulk: Omit<BulkContext, "project">;
  layout: MyTasksLayout;
  sections: MyTaskSection[];
  placements: Record<string, MyTaskPlacement>;
}) {
  const router = useRouter();
  const taskHref = useTaskHref();
  const today = useToday();
  const [, run] = useServerAction();
  const bulkEdit = useBulkEdit();
  const [layout, setLayout] = useState<MyTasksLayout>(initialLayout);
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

  const bySections = layout === "sections" && orderedSections.length > 0;
  const isDone = (task: MyTask) => toggled.get(task.id) ?? Boolean(task.completedAt);
  const toggle = (task: MyTask) => {
    const next = !isDone(task);
    run(
      () => setTaskCompleted(task.id, next),
      () => setToggled({ id: task.id, completed: next }),
    );
  };

  function chooseLayout(next: MyTasksLayout) {
    setLayout(next);
    document.cookie = `${MY_TASKS_LAYOUT_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }

  const openGroups: Group[] = bySections
    ? groupBySection(open, orderedSections, placements)
    : today === null
      ? []
      : groupByDue(open, today);
  const groups: Group[] = [
    ...openGroups,
    ...(completed.length > 0 ? [{ key: "completed", title: "Recently completed", tasks: completed }] : []),
  ];
  const tasksById = new Map([...open, ...completed].map((t) => [t.id, t]));
  const selection = useTaskSelection(
    groups.flatMap((g) => g.tasks.map((t) => t.id)),
    groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.tasks.map((t) => t.id)),
  );
  const targets = () => {
    if (selection.selected.length) return selection.selected;
    const one = openTaskId && tasksById.has(openTaskId) ? openTaskId : selection.active;
    return one ? [one] : [];
  };

  useListKeys({
    move(delta) {
      const next = selection.move(delta);
      if (next) requestAnimationFrame(() => scrollRowIntoView(next));
    },
    open() {
      const id = selection.active ?? (selection.selected.length === 1 ? selection.selected[0] : null);
      if (id) router.push(taskHref(id), { scroll: false });
    },
    escape() {
      if (openTaskId || selection.selected.length === 0) return false;
      selection.clear();
      return true;
    },
    complete() {
      const ids = targets();
      if (ids.length === 0) return;
      const next = !ids.every((id) => {
        const task = tasksById.get(id);
        return task ? isDone(task) : true;
      });
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

  const rowProps = { openTaskId, today, isDone, onToggle: toggle, selection, selecting: selection.selected.length > 0 };
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
      <Segmented label="Group My Tasks by" options={LAYOUTS} value={layout} onChange={chooseLayout} />
    </div>
  );
  // In the due-date layout there are no sections to add into: the row sits above the groups.
  const topAddRow =
    topAdd !== null && !bySections ? (
      <ul className="mt-3 border-y border-zinc-100">
        <MyAddTaskRow key={`top-${topAdd}`} sectionId={null} defaultOpen onClose={() => setTopAdd(null)} />
      </ul>
    ) : null;

  // With sections, an empty My Tasks still shows them (with their "Add task…" rows), like Asana.
  if (open.length === 0 && completed.length === 0 && !bySections) {
    return (
      <>
        {toolbar}
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
                {group.tasks.map((task, i) => (
                  <MyTaskRow
                    key={task.id}
                    task={task}
                    {...rowProps}
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
                  />
                ))}
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
            {group.tasks.map((task) => (
              <MyTaskRow key={task.id} task={task} {...rowProps} />
            ))}
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
        selected={selection.selected}
        completedCount={selection.selected.filter((id) => {
          const task = tasksById.get(id);
          return task ? isDone(task) : false;
        }).length}
        context={bySections ? { ...bulk, mySections: orderedSections.map(({ id, name }) => ({ id, name })) } : bulk}
        bulk={bulkEdit}
        onClear={selection.clear}
      />
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
                onClick={() => {
                  close();
                  if (window.confirm(`Delete “${section.name}”? Its tasks move to Recently assigned.`)) {
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

function MyTaskRow({
  task,
  openTaskId,
  today,
  isDone,
  onToggle,
  selection,
  selecting,
  dragging = false,
  dropBefore = false,
  onDragStart,
  onDragEnd,
  onDragOver,
}: {
  task: MyTask;
  openTaskId: string | null;
  today: string | null;
  isDone: (task: MyTask) => boolean;
  onToggle: (task: MyTask) => void;
  selection: TaskSelection;
  selecting: boolean;
  dragging?: boolean;
  dropBefore?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: DragEvent<HTMLLIElement>) => void;
}) {
  const router = useRouter();
  const taskHref = useTaskHref();
  const done = isDone(task);
  const open = openTaskId === task.id;
  const overdue = Boolean(task.dueOn && today && !done && task.dueOn < today);
  const selected = selection.isSelected(task.id);

  return (
    <li
      data-task-row={task.id}
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onClick={(e) => {
        const control = (e.target as HTMLElement).closest("a, button, input, select, textarea, label");
        if (control) {
          // The title link opens the task too (⌘/Ctrl-click: a new tab, the browser's own behaviour).
          if (control.tagName === "A") selection.setActive(task.id);
          return;
        }
        // Clicking a row opens the task; only the checkbox on the left selects (and brings up the bulk bar).

        selection.setActive(task.id);
        if (!open) router.push(taskHref(task.id), { scroll: false });
      }}
      className={`group flex min-h-row cursor-pointer items-center gap-3 border-b border-zinc-100 px-3 py-1 ${
        dropBefore ? "shadow-[inset_0_2px_0_var(--color-accent-500)]" : ""
      } ${
        selected ? "bg-accent-50" : open ? "bg-accent-50/60" : "hover:bg-zinc-50"
      } ${selection.active === task.id ? "shadow-[inset_2px_0_0_var(--color-accent-500)]" : ""} ${
        dragging ? "opacity-40" : ""
      } ${onDragStart ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
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
      <CompleteToggle
        kind={task.kind}
        completed={done}
        onToggle={() => onToggle(task)}
        label={kindToggleLabel(task.kind, task.title, done)}
      />
      <Link
        href={taskHref(task.id)}
        scroll={false}
        draggable={false}
        data-task-link=""
        aria-current={open ? "true" : undefined}
        className={`min-w-0 flex-1 truncate text-sm hover:underline ${done ? "text-zinc-400 line-through" : "text-zinc-900"}`}
      >
        {task.title}
      </Link>
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
      <span className={`w-16 shrink-0 text-right text-xs tabular-nums ${overdue ? "font-medium text-red-600" : "text-zinc-500"}`}>
        {task.dueOn ? formatDueDate(task.dueOn, today ? Number(today.slice(0, 4)) : undefined) : ""}
      </span>
    </li>
  );
}
