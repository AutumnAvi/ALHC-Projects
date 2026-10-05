"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useState, type DragEvent, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import { displayName } from "@/components/avatar";
import { useServerAction } from "@/components/toast";
import { updateTask } from "@/lib/actions";
import { addDays, isOverdue, useToday } from "@/lib/dates";
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

const DRAG_TYPE = "application/x-alhc-task";
const LABEL_WIDTH = 256;
const labelCell = { width: LABEL_WIDTH, minWidth: LABEL_WIDTH };

export function TimelineView({ sections, tasks, profiles, fields, config, openTaskId }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const today = useToday();
  const taskHref = useTaskHref();
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const [, run] = useServerAction();
  const [trayDragging, setTrayDragging] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

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

  function dayAt(clientX: number) {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const index = Math.floor((clientX - rect.left) / dayWidth);
    return index >= 0 && index < days ? index : null;
  }

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!trayDragging) return;
      const index = dayAt(e.clientX);
      if (index === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (index !== dropDay) setDropDay(index);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const task = optimisticTasks.find((t) => t.id === e.dataTransfer.getData(DRAG_TYPE));
      const index = dayAt(e.clientX);
      if (task && index !== null) reschedule(task, { startOn: null, dueOn: addDays(start, index) });
      setTrayDragging(null);
      setDropDay(null);
    },
  };

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

        <div key={`${zoom}-${start}`} className="relative min-h-0 flex-1 overflow-auto rounded-lg border border-zinc-200 bg-white">
          <div className="relative min-h-full" style={{ width: LABEL_WIDTH + width }} {...dropProps}>
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
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, task.id);
                  e.dataTransfer.effectAllowed = "move";
                  setTrayDragging(task.id);
                }}
                onDragEnd={() => {
                  setTrayDragging(null);
                  setDropDay(null);
                }}
                aria-current={openTaskId === task.id ? "true" : undefined}
                className={`flex min-w-0 items-center gap-1.5 rounded-md border bg-white px-1.5 py-1.5 text-xs shadow-xs hover:border-zinc-300 ${
                  openTaskId === task.id ? "border-accent-500 ring-2 ring-accent-100" : "border-zinc-200"
                } ${trayDragging === task.id ? "opacity-40" : ""}`}
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
    </div>
  );
}

type Drag = { mode: DragMode; originX: number; delta: number; moved: boolean };

function TimelineBar({
  task,
  href,
  open,
  overdue,
  windowStart,
  days,
  dayWidth,
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
  onCommit: (dates: Dates) => void;
  onReveal: (date: string) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
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
  const canResize = width >= 16;
  const labelInside = width >= task.title.length * 6.5 + 20;
  const tone = completed
    ? "bg-zinc-200 text-zinc-500"
    : span.openEnded
      ? "border border-dashed border-accent-500 bg-accent-50 text-accent-700"
      : overdue
        ? "bg-red-500 text-white"
        : "bg-accent-500 text-white";

  function onPointerDown(e: PointerEvent<HTMLAnchorElement>) {
    if (e.button !== 0) return;
    const edge = (e.target as HTMLElement).dataset.edge;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ mode: edge === "start" || edge === "end" ? edge : "move", originX: e.clientX, delta: 0, moved: false });
  }

  function onPointerMove(e: PointerEvent<HTMLAnchorElement>) {
    if (!drag) return;
    const dx = e.clientX - drag.originX;
    const delta = Math.round(dx / dayWidth);
    const moved = drag.moved || Math.abs(dx) > 3;
    if (delta !== drag.delta || moved !== drag.moved) setDrag({ ...drag, delta, moved });
  }

  function onPointerUp() {
    if (!drag) return;
    if (drag.moved) suppressClick.current = true;
    if (drag.delta !== 0) onCommit(draggedDates(task, drag.mode, drag.delta));
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
        onPointerCancel={() => setDrag(null)}
        className={`group absolute top-1.5 flex h-6 touch-pan-y items-center rounded-md text-xs select-none ${tone} ${
          clippedStart ? "rounded-l-none" : ""
        } ${clippedEnd ? "rounded-r-none" : ""} ${open ? "ring-2 ring-accent-200 ring-offset-1" : ""} ${
          drag?.moved ? "z-10 cursor-grabbing shadow-md" : "cursor-grab"
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
