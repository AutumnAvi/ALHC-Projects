"use client";

import type { Tag } from "@/lib/tags";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useId, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Inbox, Route } from "lucide-react";
import { displayName } from "@/components/avatar";
import { useCan } from "@/components/project/project-access";
import { useDependencyShift } from "@/components/task/dependency-shift";
import { EMPTY_CRITICAL_PATH, slackLabel, type CriticalPath, type TaskSchedule } from "@/lib/critical-path";
import { dependencyConflict } from "@/lib/dependencies";
import { addDays, formatDueDate, isOverdue, useToday } from "@/lib/dates";
import type { Profile, ProjectDependency, ProjectTask, Section } from "@/lib/data";
import { OPTION_COLOR_CLASSES, type FieldDef } from "@/lib/fields";
import { groupOf, isIsoDate, type ViewConfig } from "@/lib/views";
import { useTaskHref } from "./shared";
import { Assignee } from "./task-meta";
import {
  ZOOMS,
  daysBetween,
  dayWidthOf,
  draggedDates,
  headerTiers,
  isZoom,
  spanLabel,
  spanOf,
  stepAnchor,
  visibleWindow,
  weekday,
  windowLabel,
  type Dates,
  type DragMode,
  type Zoom,
} from "./timeline-scale";
import { useProjectTasks } from "./use-project-tasks";
import { groupTasks } from "./view-groups";
import { PeriodNav, Segmented, TRAY_EMPTY, TRAY_HEADING, VIEW_BODY, VIEW_HINT, ViewLoading, trayClass } from "./view-chrome";

type Props = {
  projectId: string;
  sections: Section[];
  tasks: ProjectTask[];
  profiles: Profile[];
  fields: FieldDef[];
  config: ViewConfig;
  openTaskId: string | null;
  dependencies?: ProjectDependency[];
  // Slack per dated task of the whole project (not just this view), from project_critical_path().
  criticalPath?: CriticalPath;
  tags?: Tag[];
};

const LABEL_WIDTH = 256;
// Row geometry (Tailwind h-* with border-box borders), used to place dependency arrows.
const HEADER_HEIGHT = 49;
const GROUP_HEIGHT = 32;
const ROW_HEIGHT = 36;
const labelCell = { width: LABEL_WIDTH, minWidth: LABEL_WIDTH };

export function TimelineView({
  sections,
  tasks,
  profiles,
  fields,
  config,
  openTaskId,
  dependencies = [],
  criticalPath = EMPTY_CRITICAL_PATH,
  tags = [],
}: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const today = useToday();
  const taskHref = useTaskHref();
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const shift = useDependencyShift();
  const canEdit = useCan("editor");
  const [trayDragging, setTrayDragging] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [dropDay, setDropDay] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trayDrag = useRef<{ taskId: string; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressTrayClick = useRef(false);

  const requested = searchParams.get("d");
  const zoomParam = searchParams.get("tl");
  const zoom: Zoom = isZoom(zoomParam) ? zoomParam : "week";
  const anchor = isIsoDate(requested) ? requested : today;
  const showCritical = searchParams.get("cp") === "1";
  const profilesById = new Map(profiles.map((p) => [p.id, p]));

  function navigate(next: { d?: string | null; tl?: Zoom; cp?: boolean }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.d !== undefined) {
      if (next.d) params.set("d", next.d);
      else params.delete("d");
    }
    if (next.tl) {
      if (next.tl === "week") params.delete("tl");
      else params.set("tl", next.tl);
    }
    if (next.cp !== undefined) {
      if (next.cp) params.set("cp", "1");
      else params.delete("cp");
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }

  // Moving a task later can push the tasks that depend on it: useDependencyShift previews that and asks
  // before anything else moves (with Undo afterwards).
  function reschedule(task: ProjectTask, dates: Dates) {
    if (task.startOn === dates.startOn && task.dueOn === dates.dueOn) return;
    shift.changeDates(task, dates, {
      onOptimistic: (moves) => moves.forEach((m) => applyChange({ type: "dates", ...m })),
    });
  }

  if (!anchor || !today) {
    return <ViewLoading label="Loading timeline…" />;
  }

  const dayWidth = dayWidthOf(zoom);
  const { start, days } = visibleWindow(anchor, zoom);
  const width = days * dayWidth;
  const tiers = headerTiers(start, days, zoom);
  const todayOffset = daysBetween(start, today);
  const label = windowLabel(start, days);

  const scheduled = optimisticTasks.filter((t) => t.startOn || t.dueOn);
  const tray = optimisticTasks.filter((t) => !t.startOn && !t.dueOn && !t.completedAt);
  const groups = groupTasks(scheduled, config, { sections, profilesById, fields, tags }).filter((g) => g.tasks.length > 0);
  const showGroups = groupOf(config) !== "none";

  // Vertical centre of each visible row, in content coordinates (below the sticky header).
  const rowCenter = new Map<string, number>();
  let contentHeight = HEADER_HEIGHT;
  for (const group of groups) {
    if (showGroups) contentHeight += GROUP_HEIGHT;
    for (const task of group.tasks) {
      rowCenter.set(task.id, contentHeight + ROW_HEIGHT / 2);
      contentHeight += ROW_HEIGHT;
    }
  }
  const tasksById = new Map(optimisticTasks.map((t) => [t.id, t] as const));
  const arrows = dependencies.flatMap((dep) => {
    const pred = tasksById.get(dep.predecessorId);
    const succ = tasksById.get(dep.successorId);
    const y1 = rowCenter.get(dep.predecessorId);
    const y2 = rowCenter.get(dep.successorId);
    if (!pred || !succ || y1 === undefined || y2 === undefined) return [];
    const a = spanOf(pred)!;
    const b = spanOf(succ)!;
    const predEnd = daysBetween(start, a.end) + 1;
    const succStart = daysBetween(start, b.start);
    // Only when both bars are at least partly inside the window.
    if (predEnd <= 0 || daysBetween(start, a.start) >= days || succStart >= days || daysBetween(start, b.end) < 0) return [];
    // Finish-to-start leaves the predecessor's end; start-to-start leaves its start (both enter the
    // successor's start). Red when the successor starts before the link (kind + lag) allows.
    const fromStart = dep.kind === "start_to_start";
    const x1 = fromStart
      ? Math.max(daysBetween(start, a.start), 0) * dayWidth
      : Math.min(predEnd, days) * dayWidth;
    const x2 = Math.max(succStart, 0) * dayWidth;
    const pad = 8;
    const out = fromStart ? x1 - pad : x1 + pad;
    const path = fromStart
      ? `M${x1},${y1} H${Math.min(out, x2 - pad)} V${y2} H${x2}`
      : x2 - x1 >= 2 * pad
        ? `M${x1},${y1} H${out} V${y2} H${x2}`
        : `M${x1},${y1} H${out} V${y1 + (y2 > y1 ? 1 : -1) * (ROW_HEIGHT / 2)} H${x2 - pad} V${y2} H${x2}`;
    const onPath = Boolean(
      criticalPath.tasks[dep.predecessorId]?.critical && criticalPath.tasks[dep.successorId]?.critical,
    );
    const conflict = dependencyConflict(pred, succ, dep.kind, dep.lagDays);
    return [{ id: dep.id, path, conflict, tone: showCritical ? (onPath ? "path" : "dim") : "normal" } as const];
  });

  function dayAt(clientX: number, clientY: number) {
    const box = scrollRef.current?.getBoundingClientRect();
    const rect = gridRef.current?.getBoundingClientRect();
    if (!box || !rect) return null;
    if (clientY < box.top || clientY > box.bottom || clientX < box.left + LABEL_WIDTH || clientX > box.right) return null;
    const index = Math.floor((clientX - rect.left) / dayWidth);
    return index >= 0 && index < days ? index : null;
  }

  function trayHandlers(task: ProjectTask) {
    return {
      onPointerDown: (e: PointerEvent<HTMLAnchorElement>) => {
        if (e.button !== 0 || !canEdit) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        trayDrag.current = { taskId: task.id, originX: e.clientX, originY: e.clientY, moved: false };
      },
      onPointerMove: (e: PointerEvent<HTMLAnchorElement>) => {
        const drag = trayDrag.current;
        if (!drag) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.originX, e.clientY - drag.originY) <= 4) return;
        drag.moved = true;
        setTrayDragging({ taskId: task.id, x: e.clientX, y: e.clientY });
        setDropDay(dayAt(e.clientX, e.clientY));
      },
      onPointerUp: (e: PointerEvent<HTMLAnchorElement>) => {
        const drag = trayDrag.current;
        trayDrag.current = null;
        if (drag?.moved) {
          suppressTrayClick.current = true;
          const index = dayAt(e.clientX, e.clientY);
          if (index !== null) reschedule(task, { startOn: null, dueOn: addDays(start, index) });
        }
        setTrayDragging(null);
        setDropDay(null);
      },
      onPointerCancel: () => {
        trayDrag.current = null;
        setTrayDragging(null);
        setDropDay(null);
      },
      onClick: (e: MouseEvent) => {
        if (suppressTrayClick.current) {
          e.preventDefault();
          suppressTrayClick.current = false;
        }
      },
    };
  }

  return (
    <div className={VIEW_BODY}>
      {shift.dialog}
      <div className="flex min-w-0 flex-1 flex-col">
        <PeriodNav
          label={label}
          prevLabel={`Earlier (${zoom})`}
          nextLabel={`Later (${zoom})`}
          onPrev={() => navigate({ d: stepAnchor(anchor, zoom, -1) })}
          onNext={() => navigate({ d: stepAnchor(anchor, zoom, 1) })}
          onToday={() => navigate({ d: null })}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-pressed={showCritical}
              onClick={() => navigate({ cp: !showCritical })}
              title="Highlight the longest chain of dependencies ending at the project’s last due date"
              className={`btn-secondary ${showCritical ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800" : ""}`}
            >
              <Route className="size-4" aria-hidden />
              Critical path
            </button>
            <Segmented label="Timeline scale" options={ZOOMS} value={zoom} onChange={(z) => navigate({ tl: z })} />
          </div>
        </PeriodNav>
        {showCritical ? (
          <p className="mb-2 text-xs text-zinc-500" role="status">
            Outlined bars are on the critical path: the chain of dependencies that ends at the project’s last due date
            with no slack. Other bars are faded; hover a bar for its slack. Counts every task in this project you can
            see, not only this view’s.
            {criticalPath.skipped > 0
              ? ` ${criticalPath.skipped === 1 ? "1 task has" : `${criticalPath.skipped} tasks have`} no due date and ${
                  criticalPath.skipped === 1 ? "isn’t" : "aren’t"
                } part of it.`
              : ""}
          </p>
        ) : null}

        <div
          key={`${zoom}-${start}`}
          ref={scrollRef}
          className="relative min-h-0 flex-1 overflow-auto rounded-lg border border-zinc-200 bg-white"
        >
          <div className="relative min-h-full" style={{ width: LABEL_WIDTH + width }}>
            <div
              ref={gridRef}
              aria-hidden
              className="pointer-events-none absolute inset-y-0"
              style={{ left: LABEL_WIDTH, width }}
            >
              {zoom === "week"
                ? Array.from({ length: days }, (_, i) => i)
                    .filter((i) => [0, 6].includes(weekday(addDays(start, i))))
                    .map((i) => (
                      <div key={i} className="absolute inset-y-0 bg-zinc-50" style={{ left: i * dayWidth, width: dayWidth }} />
                    ))
                : null}
              {tiers.bottom.map((seg) => (
                <div key={seg.key} className="absolute inset-y-0 border-l border-zinc-100" style={{ left: seg.offset * dayWidth }} />
              ))}
              {dropDay !== null ? (
                <div className="absolute inset-y-0 bg-accent-100/70" style={{ left: dropDay * dayWidth, width: dayWidth }} />
              ) : null}
              {todayOffset >= 0 && todayOffset < days ? (
                <div className="absolute inset-y-0 w-px bg-accent-500" style={{ left: (todayOffset + 0.5) * dayWidth }} />
              ) : null}
            </div>

            <div className="sticky top-0 z-20 flex border-b border-zinc-200 bg-white">
              <div
                className="sticky left-0 z-10 flex items-end border-r border-zinc-200 bg-white px-3 pb-1.5 text-xs font-medium text-zinc-500"
                style={labelCell}
              >
                Task
              </div>
              <div aria-hidden className="relative" style={{ width }}>
                <div className="relative h-6 border-b border-zinc-100">
                  {tiers.top.map((seg) => (
                    <span
                      key={seg.key}
                      className="absolute inset-y-0 truncate border-l border-zinc-200 px-1.5 pt-1 text-xs font-medium text-zinc-700"
                      style={{ left: seg.offset * dayWidth, width: seg.length * dayWidth }}
                    >
                      {seg.label}
                    </span>
                  ))}
                </div>
                <div className="relative h-6">
                  {tiers.bottom.map((seg) => {
                    const isToday = zoom === "week" && seg.offset === todayOffset;
                    return (
                      <span
                        key={seg.key}
                        className={`absolute inset-y-0 truncate border-l border-zinc-100 pt-1 text-2xs tabular-nums ${
                          zoom === "week" ? "text-center" : "px-1"
                        } ${isToday ? "font-semibold text-accent-700" : "text-zinc-500"}`}
                        style={{ left: seg.offset * dayWidth, width: seg.length * dayWidth }}
                      >
                        {seg.label}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>

            {groups.length === 0 ? (
              <p className="sticky left-0 max-w-md px-3 py-6 text-sm text-zinc-500">
                No scheduled tasks match this view. Set a start or due date in the task pane, or drag an
                unscheduled task onto a day.
              </p>
            ) : null}

            {groups.map((group) => (
              <section key={group.key} aria-label={showGroups ? group.label : "Tasks"}>
                {showGroups ? (
                  <div className="relative flex h-8 items-end border-b border-zinc-200 bg-zinc-50/80">
                    <div className="sticky left-0 z-10 flex items-center gap-2 px-3 pb-1.5" style={labelCell}>
                      {group.color ? (
                        <span className={`truncate rounded px-1.5 py-0.5 text-xs font-medium ${OPTION_COLOR_CLASSES[group.color]}`}>
                          {group.label}
                        </span>
                      ) : (
                        <span className="truncate text-xs font-semibold text-zinc-700">{group.label}</span>
                      )}
                      <span className="text-xs tabular-nums text-zinc-400">{group.tasks.length}</span>
                    </div>
                  </div>
                ) : null}
                <ul>
                  {group.tasks.map((task) => {
                    const open = openTaskId === task.id;
                    const completed = Boolean(task.completedAt);
                    const overdue = isOverdue(task.dueOn, today, completed);
                    const span = spanOf(task)!;
                    const assignee = task.assigneeId ? profilesById.get(task.assigneeId) : undefined;
                    const schedule = criticalPath.tasks[task.id];
                    return (
                      <li key={task.id} className="relative flex h-9 border-b border-zinc-100">
                        <div
                          className={`sticky left-0 z-10 flex items-center gap-2 border-r border-zinc-200 px-3 ${
                            open ? "bg-accent-50" : "bg-white"
                          }`}
                          style={labelCell}
                        >
                          <Link
                            href={taskHref(task.id)}
                            scroll={false}
                            aria-current={open ? "true" : undefined}
                            className={`min-w-0 flex-1 truncate text-sm hover:underline ${
                              completed ? "text-zinc-400 line-through" : "text-zinc-900"
                            }`}
                          >
                            {task.title}
                            <span className="sr-only">
                              {task.kind === "milestone" ? ", milestone" : ""}, {spanLabel(span)}
                              {overdue ? ", overdue" : ""}
                              {completed ? ", completed" : ""}
                              {task.blockedBy > 0 && !completed ? `, blocked by ${task.blockedBy}` : ""}
                              {assignee ? `, assigned to ${displayName(assignee)}` : ""}
                              {schedule ? `, ${slackLabel(schedule)}` : ""}
                            </span>
                          </Link>
                          <span aria-hidden>
                            <Assignee profile={assignee} />
                          </span>
                        </div>
                        <div className="relative" style={{ width }}>
                          <TimelineBar
                            task={task}
                            href={taskHref(task.id)}
                            open={open}
                            overdue={overdue}
                            windowStart={start}
                            days={days}
                            dayWidth={dayWidth}
                            canEdit={canEdit}
                            schedule={schedule}
                            highlight={showCritical ? (schedule?.critical ? "critical" : "dim") : null}
                            onCommit={(dates) => reschedule(task, dates)}
                            onReveal={(date) => navigate({ d: date })}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            {arrows.length > 0 ? (
              <DependencyArrows arrows={arrows} width={width} height={contentHeight} />
            ) : null}
          </div>
        </div>
        <p className={VIEW_HINT}>
          Bars run from start to due date; diamonds are milestones on their due day. Drag a bar or diamond to move
          it, drag either end of a bar to change its start or due date, or drag an unscheduled task onto a day to
          give it a due date. Arrows link a task to the one waiting on it
          (red when the waiting task starts before the first one is due).
        </p>
      </div>

      <aside
        aria-label="Unscheduled tasks"
        className={trayClass()}
      >
        <h3 className={TRAY_HEADING}>
          <Inbox className="size-4 text-zinc-500" aria-hidden />
          Unscheduled
          <span className="text-xs font-normal tabular-nums text-zinc-400">{tray.length}</span>
        </h3>
        <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
          {tray.map((task) => (
            <li key={task.id}>
              <Link
                href={taskHref(task.id)}
                scroll={false}
                draggable={false}
                {...trayHandlers(task)}
                aria-current={openTaskId === task.id ? "true" : undefined}
                className={`flex min-w-0 cursor-grab touch-pan-y items-center gap-1.5 rounded-md border bg-white px-1.5 py-1.5 text-xs shadow-xs select-none hover:border-zinc-300 ${
                  openTaskId === task.id ? "border-accent-500 ring-2 ring-accent-100" : "border-zinc-200"
                } ${trayDragging?.taskId === task.id ? "opacity-40" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate text-zinc-800">{task.title}</span>
                <Assignee profile={task.assigneeId ? profilesById.get(task.assigneeId) : undefined} />
              </Link>
            </li>
          ))}
          {tray.length === 0 ? (
            <li className={TRAY_EMPTY}>Every incomplete task in this view has a start or due date.</li>
          ) : null}
        </ul>
      </aside>
      {trayDragging ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs whitespace-nowrap text-zinc-800 shadow-md"
          style={{ left: trayDragging.x + 12, top: trayDragging.y + 8 }}
        >
          {optimisticTasks.find((t) => t.id === trayDragging.taskId)?.title}
          {dropDay !== null ? <span className="ml-1.5 text-zinc-500">→ due {formatDueDate(addDays(start, dropDay))}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// Dependency arrows (finish-to-start and start-to-start) drawn over the bars (pointer-transparent; the pane lists dependencies for
// keyboard and screen-reader users). The sticky header and label column paint above them.
function DependencyArrows({
  arrows,
  width,
  height,
}: {
  arrows: { id: string; path: string; conflict: boolean; tone: "normal" | "path" | "dim" }[];
  width: number;
  height: number;
}) {
  const id = useId();
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute top-0"
      style={{ left: LABEL_WIDTH }}
      width={width}
      height={height}
    >
      <defs>
        {(["ok", "conflict"] as const).map((tone) => (
          <marker
            key={tone}
            id={`${id}-${tone}`}
            viewBox="0 0 6 6"
            refX="6"
            refY="3"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6 z" className={tone === "ok" ? "fill-zinc-400" : "fill-red-400"} />
          </marker>
        ))}
      </defs>
      {arrows.map((arrow) => (
        <path
          key={arrow.id}
          d={arrow.path}
          fill="none"
          strokeWidth={arrow.tone === "path" ? 2 : 1.25}
          opacity={arrow.tone === "dim" ? 0.35 : 1}
          className={arrow.conflict ? "stroke-red-400" : arrow.tone === "path" ? "stroke-zinc-800" : "stroke-zinc-400"}
          markerEnd={`url(#${id}-${arrow.conflict ? "conflict" : "ok"})`}
        />
      ))}
    </svg>
  );
}

type Drag = { mode: DragMode; delta: number; moved: boolean };

function TimelineBar({
  task,
  href,
  open,
  overdue,
  windowStart,
  days,
  dayWidth,
  canEdit,
  schedule,
  highlight,
  onCommit,
  onReveal,
}: {
  task: ProjectTask;
  href: string;
  open: boolean;
  overdue: boolean;
  windowStart: string;
  days: number;
  dayWidth: number;
  canEdit: boolean;
  schedule: TaskSchedule | undefined;
  highlight: "critical" | "dim" | null;
  onCommit: (dates: Dates) => void;
  onReveal: (date: string) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // Pointer-up can arrive before React renders the last move, so the gesture is tracked outside state.
  const gesture = useRef<{ mode: DragMode; originX: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const shown = drag && drag.delta !== 0 ? draggedDates(task, drag.mode, drag.delta) : task;
  const span = spanOf(shown)!;
  const from = daysBetween(windowStart, span.start);
  const to = daysBetween(windowStart, span.end);
  const completed = Boolean(task.completedAt);

  if (!drag && (to < 0 || from >= days)) {
    const before = to < 0;
    // Sticky inside the full-width row so the button stays visible at the scrolled edge.
    return (
      <div className={`absolute inset-0 flex items-center ${before ? "justify-start" : "justify-end"}`}>
        <button
          type="button"
          onClick={() => onReveal(span.start)}
          aria-label={`Show “${task.title}” (${spanLabel(span)}) on the timeline`}
          className="sticky mx-1 rounded bg-white/90 px-1.5 py-0.5 text-xs whitespace-nowrap text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          style={before ? { left: LABEL_WIDTH } : { right: 0 }}
        >
          {before ? `‹ ${spanLabel(span)}` : `${spanLabel(span)} ›`}
        </button>
      </div>
    );
  }

  const clippedStart = from < 0;
  const clippedEnd = to >= days;
  const left = Math.max(from, 0) * dayWidth;
  const width = Math.max((Math.min(to + 1, days) - Math.max(from, 0)) * dayWidth, 4);
  const canResize = canEdit && width >= 16;
  const labelInside = width >= task.title.length * 6.5 + 20;
  const tone = completed
    ? "bg-zinc-200 text-zinc-500"
    : span.openEnded
      ? "border border-dashed border-accent-500 bg-accent-50 text-accent-700"
      : overdue
        ? "bg-red-500 text-white"
        : "bg-accent-500 text-white";

  function onPointerDown(e: PointerEvent<HTMLAnchorElement>) {
    if (e.button !== 0 || !canEdit) return;
    const edge = (e.target as HTMLElement).dataset.edge;
    const mode: DragMode = task.kind !== "milestone" && (edge === "start" || edge === "end") ? edge : "move";
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { mode, originX: e.clientX, moved: false };
    setDrag({ mode, delta: 0, moved: false });
  }

  function track(clientX: number) {
    const g = gesture.current!;
    const dx = clientX - g.originX;
    g.moved = g.moved || Math.abs(dx) > 3;
    return { mode: g.mode, delta: Math.round(dx / dayWidth), moved: g.moved };
  }

  function onPointerMove(e: PointerEvent<HTMLAnchorElement>) {
    if (!gesture.current) return;
    const next = track(e.clientX);
    setDrag((prev) => (prev && prev.delta === next.delta && prev.moved === next.moved ? prev : next));
  }

  function onPointerUp(e: PointerEvent<HTMLAnchorElement>) {
    if (!gesture.current) return;
    const { mode, delta, moved } = track(e.clientX);
    gesture.current = null;
    if (moved) suppressClick.current = true;
    if (delta !== 0) onCommit(draggedDates(task, mode, delta));
    setDrag(null);
  }

  const cancel = () => {
    gesture.current = null;
    setDrag(null);
  };
  const suppress = (e: MouseEvent) => {
    if (suppressClick.current) {
      e.preventDefault();
      suppressClick.current = false;
    }
  };

  // A milestone is a diamond on its due day: drag moves it, there are no ends to resize.
  if (task.kind === "milestone") {
    const size = 14;
    const center = (Math.min(Math.max(to, 0), days - 1) + 0.5) * dayWidth;
    const fill = completed ? "bg-zinc-300" : overdue ? "bg-red-500" : "bg-accent-600";
    return (
      <>
        <Link
          href={href}
          scroll={false}
          draggable={false}
          tabIndex={-1}
          aria-hidden
          title={`Milestone: ${task.title} · ${formatDueDate(span.end)}${schedule ? ` · ${slackLabel(schedule)}` : ""}`}
          onClick={suppress}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancel}
          className={`absolute top-1/2 flex touch-pan-y items-center justify-center select-none ${
            highlight === "dim" ? "opacity-35" : ""
          } ${drag?.moved ? "z-10 cursor-grabbing" : canEdit ? "cursor-grab" : "cursor-pointer"}`}
          style={{ left: center - size, width: size * 2, height: size * 2, marginTop: -size }}
        >
          <span
            className={`block rotate-45 rounded-[2px] ${fill} ${open ? "ring-2 ring-accent-200 ring-offset-1" : ""} ${
              highlight === "critical" ? "outline-2 outline-offset-1 outline-zinc-900" : ""
            } ${drag?.moved ? "shadow-md" : ""}`}
            style={{ width: size - 2, height: size - 2 }}
          />
        </Link>
        <span
          aria-hidden
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 truncate pl-1 text-xs whitespace-nowrap ${
            completed ? "text-zinc-400 line-through" : "text-zinc-600"
          }`}
          style={{ left: center + size, maxWidth: 240 }}
        >
          {task.title}
        </span>
        {drag?.moved ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -top-4 z-20 rounded bg-zinc-900 px-1.5 py-0.5 text-2xs whitespace-nowrap text-white tabular-nums"
            style={{ left: center - size }}
          >
            {formatDueDate(span.end)}
          </span>
        ) : null}
      </>
    );
  }

  return (
    <>
      <Link
        href={href}
        scroll={false}
        draggable={false}
        tabIndex={-1}
        aria-hidden
        title={`${task.title} · ${spanLabel(span)}${schedule ? ` · ${slackLabel(schedule)}` : ""}`}
        onClick={(e) => {
          if (suppressClick.current) {
            e.preventDefault();
            suppressClick.current = false;
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          gesture.current = null;
          setDrag(null);
        }}
        className={`group absolute top-1.5 flex h-6 touch-pan-y items-center rounded-md text-xs select-none ${tone} ${
          clippedStart ? "rounded-l-none" : ""
        } ${clippedEnd ? "rounded-r-none" : ""} ${open ? "ring-2 ring-accent-200 ring-offset-1" : ""} ${
          highlight === "critical" ? "outline-2 outline-offset-1 outline-zinc-900" : highlight === "dim" ? "opacity-35" : ""
        } ${
          drag?.moved ? "z-10 cursor-grabbing shadow-md" : canEdit ? "cursor-grab" : "cursor-pointer"
        }`}
        style={{ left, width }}
      >
        {labelInside ? (
          <span className={`min-w-0 flex-1 truncate px-2 ${completed ? "line-through" : ""}`}>{task.title}</span>
        ) : null}
        {canResize && !clippedStart ? (
          <span data-edge="start" className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md group-hover:bg-black/10" />
        ) : null}
        {canResize && !clippedEnd ? (
          <span data-edge="end" className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md group-hover:bg-black/10" />
        ) : null}
      </Link>
      {!labelInside ? (
        <span
          aria-hidden
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 truncate pl-1.5 text-xs whitespace-nowrap ${
            completed ? "text-zinc-400 line-through" : "text-zinc-600"
          }`}
          style={{ left: left + width, maxWidth: 240 }}
        >
          {task.title}
        </span>
      ) : null}
      {drag?.moved ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-4 z-20 rounded bg-zinc-900 px-1.5 py-0.5 text-2xs whitespace-nowrap text-white tabular-nums"
          style={{ left }}
        >
          {spanLabel(span)}
        </span>
      ) : null}
    </>
  );
}
