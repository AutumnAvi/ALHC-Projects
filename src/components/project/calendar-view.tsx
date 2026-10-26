"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, type DragEvent } from "react";
import { Inbox } from "lucide-react";
import { CALENDAR_DRAG_TYPE, CalendarGrid, type CalendarDrag, type CalendarItem } from "@/components/calendar/calendar-grid";
import { SyncCalendarButton } from "@/components/calendar/sync-calendar-dialog";
import { useProjectPermissions } from "@/components/project/project-access";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { useDependencyShift } from "@/components/task/dependency-shift";
import { TaskLink } from "@/components/task/task-link";
import { calendarVisibleDays, type CalendarMode } from "@/lib/date-input";
import { addDays, useToday } from "@/lib/dates";
import type { Profile, ProjectTask, Section } from "@/lib/data";
import type { FieldDef } from "@/lib/fields";
import type { Tag } from "@/lib/tags";
import type { TaskSeed } from "@/lib/task-seed";
import { displayTaskTitle } from "@/lib/request-numbers";
import { isIsoDate } from "@/lib/views";
import { Assignee } from "./task-meta";
import { useProjectTaskSeeds } from "./task-seeds";
import { useProjectTasks } from "./use-project-tasks";
import { PeriodNav, Segmented, TRAY_EMPTY, TRAY_HEADING, VIEW_BODY, VIEW_HINT, ViewLoading, trayClass } from "./view-chrome";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const CAL_MODES = [
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

function shiftMonth(date: string, delta: number) {
  const [y, m] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
}

function periodLabel(anchor: string, mode: "month" | "week") {
  const [y, m] = anchor.split("-").map(Number);
  if (mode === "month") return `${MONTHS[m - 1]} ${y}`;
  const start = addDays(anchor, -weekday(anchor));
  const end = addDays(start, 6);
  const fmt = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${Number(d.slice(8))}`;
  return `${fmt(start)} – ${fmt(end)}, ${end.slice(0, 4)}`;
}

export function CalendarView({
  projectId,
  tasks,
  profiles,
  projectName = null,
  sections = [],
  tags = [],
  fields = [],
  windowed = false,
  today: todayFromServer = null,
  anchor: anchorFromServer = null,
  mode: modeFromServer = "month",
  days: daysFromServer = null,
}: {
  projectId: string;
  tasks: ProjectTask[];
  profiles: Profile[];
  // What the task pane's preview shows for a clicked bar.
  projectName?: string | null;
  sections?: Section[];
  tags?: Tag[];
  fields?: FieldDef[];
  // The server already loaded this window. Changing month or week asks it for the next one.
  // Without the schedule function, the full list is here and the window stays in the browser.
  windowed?: boolean;
  today?: string | null;
  anchor?: string | null;
  mode?: CalendarMode;
  days?: string[] | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [navigating, startTransition] = useTransition();
  const clientToday = useToday();
  // The task whose pane is open (instant: no server render on open / close; Oct 19 notes).
  const openTaskId = useOpenTaskId();
  const seeds = useProjectTaskSeeds({ profiles, tags, sections, fields, projectName });
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const shift = useDependencyShift();
  const canEdit = useProjectPermissions().canEdit;
  const [drag, setDrag] = useState<CalendarDrag | null>(null);
  const [overTray, setOverTray] = useState(false);

  const requested = searchParams.get("d");
  const mode: CalendarMode = windowed ? modeFromServer : searchParams.get("cal") === "week" ? "week" : "month";
  const anchor = windowed ? anchorFromServer : isIsoDate(requested) ? requested : clientToday;
  const today = windowed ? (todayFromServer ?? anchor) : clientToday;
  const profilesById = new Map(profiles.map((p) => [p.id, p]));

  function navigate(next: { d?: string | null; cal?: "month" | "week" }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.d !== undefined) {
      if (next.d) params.set("d", next.d);
      else params.delete("d");
    }
    if (next.cal) {
      if (next.cal === "week") params.set("cal", "week");
      else params.delete("cal");
    }
    const query = params.toString();
    const url = query ? `${pathname}?${query}` : pathname;
    // A windowed calendar only has this month or week's tasks, so the next range is loaded
    // on the server. The full-list fallback keeps the change in the address bar.
    if (windowed && (next.d !== undefined || next.cal !== undefined)) {
      startTransition(() => router.replace(url, { scroll: false }));
    } else {
      window.history.replaceState(null, "", url);
    }
  }

  // The task pane's path: a later date can push dependent tasks, so useDependencyShift asks first (and
  // offers Undo); the move shows at once and rolls back if the database refuses it.
  function changeDates(taskId: string, dates: { startOn: string | null; dueOn: string | null }) {
    const task = optimisticTasks.find((t) => t.id === taskId);
    if (!task || (task.startOn === dates.startOn && task.dueOn === dates.dueOn)) return;
    shift.changeDates(task, dates, {
      onOptimistic: (moves) =>
        moves.forEach((m) => applyChange({ type: "dates", taskId: m.taskId, startOn: m.startOn, dueOn: m.dueOn })),
    });
  }

  const items: CalendarItem[] = optimisticTasks.flatMap((task) => {
    if (!task.dueOn) return [];
    const completed = Boolean(task.completedAt);
    const overdue = Boolean(today && !completed && task.dueOn < today);
    const milestone = task.kind === "milestone";
    return [
      {
        id: task.id,
        title: displayTaskTitle(task.title, task.requestLabel),
        startOn: task.startOn && task.startOn < task.dueOn && !milestone ? task.startOn : null,
        dueOn: task.dueOn,
        completed,
        milestone,
        overdue,
        canEdit,
        open: openTaskId === task.id,
        seed: () => seeds.task(task),
        dotClass: completed ? "bg-green-500" : overdue ? "bg-red-500" : milestone ? "bg-accent-600" : "bg-zinc-300",
        tooltip: displayTaskTitle(task.title, task.requestLabel),
      },
    ];
  });
  const tray = optimisticTasks.filter((t) => !t.dueOn && !t.completedAt);

  const days = windowed ? daysFromServer : anchor ? calendarVisibleDays(anchor, mode) : null;

  if (!anchor || !days || days.length === 0) {
    return <ViewLoading label="Loading calendar…" />;
  }

  const step = (delta: number) =>
    navigate({ d: mode === "week" ? addDays(anchor, delta * 7) : shiftMonth(anchor, delta) });

  return (
    <div className={VIEW_BODY} aria-busy={navigating}>
      {shift.dialog}
      <div className={`flex min-w-0 flex-1 flex-col ${navigating ? "opacity-60 transition-opacity" : ""}`}>
        <PeriodNav
          label={periodLabel(anchor, mode)}
          prevLabel={mode === "week" ? "Previous week" : "Previous month"}
          nextLabel={mode === "week" ? "Next week" : "Next month"}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onToday={() => navigate({ d: null })}
        >
          <div className="flex items-center gap-1">
            <SyncCalendarButton scope="project" targetId={projectId} />
            <Segmented
              label="Calendar range"
              options={CAL_MODES}
              value={mode}
              onChange={(m) => navigate({ cal: m })}
            />
          </div>
        </PeriodNav>

        <CalendarGrid
          key={`${mode}-${days[0]}`}
          days={days}
          month={mode === "month" ? anchor.slice(0, 7) : null}
          today={today}
          items={items}
          drag={drag}
          onDragChange={setDrag}
          onChange={(item, dates) => changeDates(item.id, dates)}
          onDropExternal={(taskId, day) => {
            const task = optimisticTasks.find((t) => t.id === taskId);
            if (task) changeDates(taskId, { startOn: task.startOn && task.startOn <= day ? task.startOn : null, dueOn: day });
          }}
          label={`Tasks, ${periodLabel(anchor, mode)}`}
          tall={mode === "week"}
        />
        <p className={VIEW_HINT}>
          {canEdit
            ? "Drag a task to another day to move it (its start date moves too), drag its left or right end to change its start or due date, or use its calendar button. Drop it on “No due date” to clear it."
            : "Tasks run from their start date to their due date. Your role in this project lets you view them, not move them."}
        </p>
      </div>

      <aside
        onDragOver={(e: DragEvent) => {
          if (!drag || drag.mode === "external") return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!overTray) setOverTray(true);
        }}
        onDragLeave={() => setOverTray(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          const current = drag;
          setDrag(null);
          setOverTray(false);
          if (!current || current.mode === "external") return;
          const task = optimisticTasks.find((t) => t.id === current.id);
          if (task) changeDates(task.id, { startOn: task.startOn, dueOn: null });
        }}
        aria-label="Tasks without a due date"
        className={trayClass(overTray)}
      >
        <h3 className={TRAY_HEADING}>
          <Inbox className="size-4 text-zinc-500" aria-hidden />
          No due date
          <span className="text-xs font-normal tabular-nums text-zinc-400">{tray.length}</span>
        </h3>
        <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
          {tray.map((task) => (
            <CalendarChip
              key={task.id}
              task={task}
              assignee={task.assigneeId ? profilesById.get(task.assigneeId) : undefined}
              open={openTaskId === task.id}
              seed={() => seeds.task(task)}
              dragging={drag?.id === task.id}
              draggable={canEdit}
              onDragStart={(e: DragEvent) => {
                e.dataTransfer.setData(CALENDAR_DRAG_TYPE, task.id);
                e.dataTransfer.effectAllowed = "move";
                setDrag({ id: task.id, mode: "external" });
              }}
              onDragEnd={() => setDrag(null)}
            />
          ))}
          {tray.length === 0 ? (
            <p className={TRAY_EMPTY}>Every incomplete task in this view has a due date.</p>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function CalendarChip({
  task,
  assignee,
  open,
  seed,
  dragging,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  task: ProjectTask;
  assignee: Profile | undefined;
  open: boolean;
  seed: () => TaskSeed;
  dragging: boolean;
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  return (
    <TaskLink
      taskId={task.id}
      seed={seed}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      aria-current={open ? "true" : undefined}
      title={displayTaskTitle(task.title, task.requestLabel)}
      className={`flex min-w-0 items-center gap-1.5 rounded-md border bg-white px-1.5 py-1.5 text-xs shadow-xs hover:border-zinc-300 ${
        open ? "border-accent-500 ring-2 ring-accent-100" : "border-zinc-200"
      } ${dragging ? "opacity-40" : ""} ${draggable ? "cursor-grab" : ""}`}
    >
      <span
        aria-hidden
        className={`size-2 shrink-0 ${task.kind === "milestone" ? "rotate-45 rounded-[1px] bg-accent-600" : "rounded-full bg-zinc-300"}`}
      />
      <span className="min-w-0 flex-1 truncate text-zinc-800">
        {displayTaskTitle(task.title, task.requestLabel)}
        {task.kind === "milestone" ? <span className="sr-only"> (milestone)</span> : null}
      </span>
      <Assignee profile={assignee} />
    </TaskLink>
  );
}
