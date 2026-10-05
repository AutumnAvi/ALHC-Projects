"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import { displayName } from "@/components/avatar";
import { useCan } from "@/components/project/project-access";
import { useServerAction } from "@/components/toast";
import { updateTask } from "@/lib/actions";
import { addDays, formatDueDate, isOverdue, useToday } from "@/lib/dates";
import type { Profile, ProjectTask, Section } from "@/lib/data";
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

type Props = {
  projectId: string;
  sections: Section[];
  tasks: ProjectTask[];
  profiles: Profile[];
  fields: FieldDef[];
  config: ViewConfig;
  openTaskId: string | null;
};

const LABEL_WIDTH = 256;
const labelCell = { width: LABEL_WIDTH, minWidth: LABEL_WIDTH };

export function TimelineView({ sections, tasks, profiles, fields, config, openTaskId }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const today = useToday();
  const taskHref = useTaskHref();
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const [, run] = useServerAction();
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
  const profilesById = new Map(profiles.map((p) => [p.id, p]));

  function navigate(next: { d?: string | null; tl?: Zoom }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.d !== undefined) {
      if (next.d) params.set("d", next.d);
      else params.delete("d");
    }
    if (next.tl) {
      if (next.tl === "week") params.delete("tl");
      else params.set("tl", next.tl);
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }

  function reschedule(task: ProjectTask, dates: Dates) {
    if (task.startOn === dates.startOn && task.dueOn === dates.dueOn) return;
    run(
      () => updateTask(task.id, dates),
      () => applyChange({ type: "dates", taskId: task.id, ...dates }),
    );
  }

  if (!anchor || !today) {
    return <p className="px-6 py-6 text-sm text-zinc-400">Loading timeline…</p>;
  }

  const dayWidth = dayWidthOf(zoom);
  const { start, days } = visibleWindow(anchor, zoom);
  const width = days * dayWidth;
  const tiers = headerTiers(start, days, zoom);
  const todayOffset = daysBetween(start, today);
  const label = windowLabel(start, days);

  const scheduled = optimisticTasks.filter((t) => t.startOn || t.dueOn);
  const tray = optimisticTasks.filter((t) => !t.startOn && !t.dueOn && !t.completedAt);
  const groups = groupTasks(scheduled, config, { sections, profilesById, fields }).filter((g) => g.tasks.length > 0);
  const showGroups = groupOf(config) !== "none";

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
    <div className="flex min-h-0 flex-1 gap-4 px-6 py-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-base font-semibold text-zinc-900" aria-live="polite">
            {label}
          </h2>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => navigate({ d: stepAnchor(anchor, zoom, -1) })}
              aria-label={`Earlier (${zoom})`}
              className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => navigate({ d: stepAnchor(anchor, zoom, 1) })}
              aria-label={`Later (${zoom})`}
              className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => navigate({ d: null })}
            className="rounded-md border border-zinc-200 px-2 py-0.5 text-sm text-zinc-700 hover:border-zinc-300"
          >
            Today
          </button>
          <div role="group" aria-label="Timeline scale" className="ml-auto inline-flex rounded-md border border-zinc-200 p-0.5">
            {ZOOMS.map((z) => (
              <button
                key={z.value}
                type="button"
                aria-pressed={zoom === z.value}
                onClick={() => navigate({ tl: z.value })}
                className="rounded px-2 py-0.5 text-sm text-zinc-600 aria-pressed:bg-zinc-900 aria-pressed:text-white"
              >
                {z.label}
              </button>
            ))}
          </div>
        </div>

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
                        className={`absolute inset-y-0 truncate border-l border-zinc-100 pt-1 text-[11px] tabular-nums ${
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
                              , {spanLabel(span)}
                              {overdue ? ", overdue" : ""}
                              {completed ? ", completed" : ""}
                              {assignee ? `, assigned to ${displayName(assignee)}` : ""}
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
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Bars run from start to due date. Drag a bar to move it, drag either end to change its start or due date,
          or drag an unscheduled task onto a day to give it a due date.
        </p>
      </div>

      <aside
        aria-label="Unscheduled tasks"
        className="hidden w-64 shrink-0 flex-col rounded-xl bg-zinc-100/70 p-2 md:flex"
      >
        <h3 className="flex items-center gap-1.5 px-1 pb-2 text-sm font-semibold text-zinc-900">
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
            <li className="px-1 text-xs text-zinc-500">Every incomplete task in this view has a start or due date.</li>
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
    const mode: DragMode = edge === "start" || edge === "end" ? edge : "move";
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

  return (
    <>
      <Link
        href={href}
        scroll={false}
        draggable={false}
        tabIndex={-1}
        aria-hidden
        title={`${task.title} · ${spanLabel(span)}`}
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
          className="pointer-events-none absolute -top-4 z-20 rounded bg-zinc-900 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-white tabular-nums"
          style={{ left }}
        >
          {spanLabel(span)}
        </span>
      ) : null}
    </>
  );
}
