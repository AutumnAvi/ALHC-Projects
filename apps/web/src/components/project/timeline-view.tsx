"use client";

import type { Tag } from "@alhc/core/tags";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition, type MouseEvent, type PointerEvent } from "react";
import { Inbox, Keyboard, Route, Spline } from "lucide-react";
import { displayName } from "@alhc/core/people";
import { useProjectPermissions } from "@/components/project/project-access";
import { useDependencyShift } from "@/components/task/dependency-shift";
import {
  TIMELINE_DRAG_KEYS,
  dependentCount,
  planTimelineDrag,
  prerequisiteCount,
  timelineDragHint,
  timelineDragHow,
  type TimelineDragHow,
} from "@alhc/core/dependency-plan";
import { DEPENDENCY_SHIFT_OPTIONS, type DependencyShiftMode, type ShiftMove } from "@alhc/core/dependencies";
import { DEFAULT_WORK_WEEK } from "@alhc/core/workdays";
import { EMPTY_CRITICAL_PATH, slackLabel, type CriticalPath, type TaskSchedule } from "@alhc/core/critical-path";
import { dependencyConflict, fromPredecessorStart, toSuccessorFinish } from "@alhc/core/dependencies";
import { addDays, formatDueDate, isOverdue, useToday } from "@/lib/dates";
import type { Profile } from "@alhc/core/api/people/model";
import type { ProjectDependency, ProjectTask } from "@alhc/core/api/tasks/model";
import type { Section } from "@alhc/core/api/projects/model";
import { bareTaskTitle, displayTaskTitle } from "@alhc/core/request-numbers";
import { TaskNumberBadge } from "@/components/task/task-number";
import { useNotify, useServerAction } from "@/components/toast";
import { loadProjectCriticalPath, removeTaskDependency, setTaskDependency } from "@/lib/actions/dependencies";
import { OPTION_COLOR_CLASSES, type FieldDef } from "@alhc/core/fields";
import { groupOf, isIsoDate, type ViewConfig } from "@alhc/core/views";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { TaskLink } from "@/components/task/task-link";
import type { TaskSeed } from "@/lib/task-seed";
import { useProjectTaskSeeds } from "./task-seeds";
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
import {
  BAND_ROWS,
  arrowInView,
  frameThrottle,
  layoutSlots,
  sameBand,
  viewportBand,
  visibleSlots,
  type Band,
} from "./timeline-layout";
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
  // What the task pane's preview shows for a clicked bar.
  projectName?: string | null;
  dependencies?: ProjectDependency[];
  // Slack per dated task of the whole project (not just this view), from project_critical_path(). Null:
  // not worked out on the server (the switch is off), so the chart asks for it after it paints.
  criticalPath?: CriticalPath | null;
  tags?: Tag[];
  // The server already loaded this scale. Moving the window asks it for the next one.
  // Without the schedule function, every scheduled task is here and the window stays in the browser.
  windowed?: boolean;
  today?: string | null;
  anchor?: string | null;
  zoom?: Zoom;
  // Nov 2 notes (batch 16, 125): the project's Settings → Dependencies and the workspace's workweek. Since
  // Nov 3 notes (batch 19, 148) Timeline drags pick what dependents do with keys (timelineDragHow) instead
  // of the setting, which still applies to date changes elsewhere (named in the hint); the workweek plans
  // the dependents drawn while dragging and right after the drop (the database's answer wins).
  shiftMode?: DependencyShiftMode | null;
  workWeek?: readonly number[];
};

const LABEL_WIDTH = 256;
// Row geometry (Tailwind h-* with border-box borders), used to place dependency arrows.
const HEADER_HEIGHT = 49;
const GROUP_HEIGHT = 32;
const ROW_HEIGHT = 36;
const labelCell = { width: LABEL_WIDTH, minWidth: LABEL_WIDTH };
// The earlier / later buttons' tooltips: how far one step goes (stepAnchor).
const ZOOM_STEP_LABEL: Record<Zoom, string> = { week: "by a week", month: "by a month", quarter: "by a quarter" };

export function TimelineView({
  projectId,
  sections,
  tasks,
  profiles,
  fields,
  config,
  projectName = null,
  dependencies = [],
  criticalPath: criticalPathProp = null,
  tags = [],
  windowed = false,
  today: todayFromServer = null,
  anchor: anchorFromServer = null,
  zoom: zoomFromServer = "week",
  shiftMode = null,
  workWeek = DEFAULT_WORK_WEEK,
}: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [navigating, startTransition] = useTransition();
  const clientToday = useToday();
  // The task whose pane is open (instant: no server render on open / close; Oct 19 notes).
  const openTaskId = useOpenTaskId();
  const seeds = useProjectTaskSeeds({ profiles, tags, sections, fields, projectName });
  const [optimisticTasks, applyChange] = useProjectTasks(projectId, tasks);
  const shift = useDependencyShift();
  const canEdit = useProjectPermissions().canEdit;
  const [trayDragging, setTrayDragging] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [dropDay, setDropDay] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Nov 12 (batch 39, item 4): the scrolled band (timeline-layout.ts), not the raw scroll position, so
  // scrolling re-renders only when the rows to draw change, and at most once per frame.
  const [viewport, setViewport] = useState<Band>({ top: 0, bottom: BAND_ROWS * ROW_HEIGHT * 4 });
  const [draggedId, setDraggedId] = useState<string | null>(null);
  // Nov 3 notes (batch 19, 148): the bar being dragged, how far, and the keys held — the dependents that
  // would move are drawn where they'd go, and the arrows follow.
  const [dragState, setDragState] = useState<BarDrag | null>(null);
  const trayDrag = useRef<{ taskId: string; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressTrayClick = useRef(false);
  // Oct 26 notes (batch 4): Draw dependencies. While it's on, dragging from one task (its bar or its row)
  // to another makes the second one blocked by the first (finish-to-start); Esc or the button stops it.
  const contentRef = useRef<HTMLDivElement>(null);
  const [linking, setLinking] = useState(false);
  // Nov 3 notes (batch 19, 148): the drag keys legend under the toolbar.
  const [showKeys, setShowKeys] = useState(false);
  const [link, setLink] = useState<{ fromId: string; x1: number; y1: number; x2: number; y2: number; overId: string | null } | null>(null);
  const [, runLink] = useServerAction();
  const notify = useNotify();
  // Nov 2 notes (batch 15, 116): dependency lines are selectable (click; Delete / Backspace removes the
  // selected one) and show a small × on hover — while drawing too. Removed lines vanish at once.
  const [selectedDep, setSelectedDep] = useState<string | null>(null);
  const [hoverDep, setHoverDepNow] = useState<string | null>(null);
  // Leaving a line waits a moment, so the pointer can reach its ×.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function setHoverDep(next: string | null) {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (next) setHoverDepNow(next);
    else hoverTimer.current = setTimeout(() => setHoverDepNow(null), 300);
  }
  const [removedDeps, setRemovedDeps] = useState<ReadonlySet<string>>(() => new Set());

  function removeDependency(depId: string) {
    // Kept so Undo can make the same link again (type and lag included; flaw audit C44).
    const removed = dependencies.find((d) => d.id === depId) ?? null;
    setSelectedDep(null);
    setHoverDepNow(null);
    setRemovedDeps((current) => new Set(current).add(depId));
    runLink(async () => {
      const result = await removeTaskDependency(depId);
      if (result.error) {
        setRemovedDeps((current) => {
          const next = new Set(current);
          next.delete(depId);
          return next;
        });
      } else {
        notify(
          "Dependency removed",
          removed
            ? {
                label: "Undo",
                onClick: () =>
                  runLink(async () => {
                    const undone = await setTaskDependency(removed.predecessorId, removed.successorId, removed.kind, removed.lagDays);
                    if (!undone.error) notify("Dependency restored");
                    return undone;
                  }),
              }
            : undefined,
        );
      }
      return result;
    });
  }

  useEffect(() => {
    if (!selectedDep) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (document.querySelector("[role='dialog'], [role='alertdialog']")) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (selectedDep) removeDependency(selectedDep);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelectedDep(null);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => {
    if (!linking) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // A dialog, a confirm, or a popover on top handles its own Escape first.
      if (document.querySelector("[role='dialog'], [role='alertdialog']")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setLink(null);
      setLinking(false);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [linking]);

  const requested = searchParams.get("d");
  const zoomParam = searchParams.get("tl");
  const zoom: Zoom = windowed ? zoomFromServer : isZoom(zoomParam) ? zoomParam : "week";
  const anchor = windowed ? anchorFromServer : isIsoDate(requested) ? requested : clientToday;
  const today = windowed ? (todayFromServer ?? anchor) : clientToday;
  const showCritical = searchParams.get("cp") === "1";
  const profilesById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  // Nov 12 (batch 39, item 4): the critical path the server didn't work out (switch off) is asked for once
  // the chart has painted, and again after each refresh of the tasks or links (the bars' slack tooltips
  // and the switch read the same numbers as before).
  const [loadedCriticalPath, setLoadedCriticalPath] = useState<CriticalPath | null>(null);
  useEffect(() => {
    if (criticalPathProp) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void loadProjectCriticalPath(projectId)
        .then((result) => {
          if (!cancelled && result.data) setLoadedCriticalPath(result.data);
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [criticalPathProp, projectId, tasks, dependencies]);
  const criticalPath = criticalPathProp ?? loadedCriticalPath ?? EMPTY_CRITICAL_PATH;

  // Rows and their positions: once per change of the tasks, the view, or the grouping — never on scroll.
  const layout = useMemo(() => {
    const scheduledTasks = optimisticTasks.filter((t) => t.startOn || t.dueOn);
    const trayTasks = optimisticTasks.filter((t) => !t.startOn && !t.dueOn && !t.completedAt);
    const taskGroups = groupTasks(scheduledTasks, config, { sections, profilesById, fields, tags }).filter((g) => g.tasks.length > 0);
    const grouped = groupOf(config) !== "none";
    return {
      tray: trayTasks,
      groups: taskGroups,
      ...layoutSlots<ProjectTask, (typeof taskGroups)[number]>(taskGroups, grouped, { header: HEADER_HEIGHT, group: GROUP_HEIGHT, row: ROW_HEIGHT }),
      tasksById: new Map(optimisticTasks.map((t) => [t.id, t] as const)),
    };
  }, [optimisticTasks, config, sections, profilesById, fields, tags]);

  // The dependency arrows while nothing is being dragged: once per change of the tasks, links, window, or
  // critical path — not on scroll (while a bar is dragged they follow it, worked out as it moves).
  const windowAt = anchor ? visibleWindow(anchor, zoom) : null;
  const windowStart = windowAt?.start ?? null;
  const windowDays = windowAt?.days ?? 0;
  const restingArrows = useMemo(
    () =>
      windowStart === null || dragState
        ? null
        : buildArrows({
            dependencies,
            removed: removedDeps,
            tasksById: layout.tasksById,
            rowCenter: layout.rowCenter,
            placed: (task) => task,
            start: windowStart,
            days: windowDays,
            dayWidth: dayWidthOf(zoom),
            criticalPath,
            showCritical,
          }),
    [windowStart, windowDays, zoom, dragState, dependencies, removedDeps, layout, criticalPath, showCritical],
  );

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
    const url = query ? `${pathname}?${query}` : pathname;
    // A windowed timeline only has tasks in this scale, so the next range is loaded on the server.
    // Critical path is already here, and the full-list fallback keeps every change in the address bar.
    if (windowed && (next.d !== undefined || next.tl !== undefined)) {
      startTransition(() => router.replace(url, { scroll: false }));
    } else {
      window.history.replaceState(null, "", url);
    }
  }

  // What the page knows, for planning the dependents drawn while dragging and right after the drop.
  function planTasks() {
    return new Map(
      optimisticTasks.map((t) => [
        t.id,
        { id: t.id, title: t.title, startOn: t.startOn, dueOn: t.dueOn, kind: t.kind, completed: Boolean(t.completedAt), canEdit },
      ]),
    );
  }

  // Nov 4 notes (batch 20, 152): both directions — the tasks it depends on (upstream) and the ones that
  // depend on it (and on every upstream task that moves).
  function dragPlan(moves: ShiftMove[], how: TimelineDragHow) {
    const live = dependencies.filter((d) => !removedDeps.has(d.id));
    return planTimelineDrag({ tasks: planTasks(), links: live, moves, how, workWeek });
  }

  function planFor(moves: ShiftMove[], how: TimelineDragHow) {
    const { upstream, downstream } = dragPlan(moves, how);
    return [...upstream, ...downstream];
  }

  function upstreamFor(moves: ShiftMove[], how: TimelineDragHow) {
    return dragPlan(moves, how).upstream;
  }

  // Nov 3 notes (batch 19, 148): on the Timeline the keys held when the bar is dropped decide what the tasks
  // that depend on it do — a plain drag moves only this task, Shift moves them along by the same amount, Alt
  // pushes them only as far as their links need (timelineDragHow). The bar moves at once; the database's
  // answer wins.
  function reschedule(task: ProjectTask, dates: Dates, how: TimelineDragHow) {
    if (task.startOn === dates.startOn && task.dueOn === dates.dueOn) return;
    shift.moveWith(task, dates, how, {
      onOptimistic: (moves) => moves.forEach((m) => applyChange({ type: "dates", ...m })),
      projectId,
      planFor,
      upstreamFor,
    });
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const next = viewportBand(el.scrollTop, el.clientHeight, BAND_ROWS * ROW_HEIGHT);
      setViewport((current) => (sameBand(current, next) ? current : next));
    };
    update();
    const frame = frameThrottle(update, {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle),
    });
    el.addEventListener("scroll", frame.schedule, { passive: true });
    const observer = new ResizeObserver(frame.schedule);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", frame.schedule);
      observer.disconnect();
      frame.cancel();
    };
  }, [anchor, zoom, today]);

  if (!anchor || !today) {
    return <ViewLoading label="Loading timeline…" />;
  }

  const dayWidth = dayWidthOf(zoom);
  const { start, days } = visibleWindow(anchor, zoom);
  const width = days * dayWidth;
  const tiers = headerTiers(start, days, zoom);
  const todayOffset = daysBetween(start, today);
  const label = windowLabel(start, days);

  // Vertical centre of every row, in content coordinates (below the sticky header): `layout` above. Arrows
  // use these positions even when the row itself is outside the painted window.
  const { tray, groups, rowCenter, slots, contentHeight, tasksById } = layout;
  // The band holds the viewport; twelve rows more on each side, as before.
  const viewTop = viewport.top - ROW_HEIGHT * 12;
  const viewBottom = viewport.bottom + ROW_HEIGHT * 12;
  const pinned = new Set<string>();
  if (draggedId) pinned.add(draggedId);
  if (openTaskId) pinned.add(openTaskId);
  const shownSlots = visibleSlots(slots, viewTop, viewBottom, pinned);
  // While a bar is dragged: where it would go, and where its dependents would go with the keys held.
  const dragged = dragState ? tasksById.get(dragState.taskId) : undefined;
  const dragDates = dragged && dragState && dragState.delta !== 0 ? draggedDates(dragged, dragState.mode, dragState.delta) : null;
  const previews = new Map<string, Dates>();
  const movingUpstream: string[] = [];
  const movingDownstream: string[] = [];
  if (dragged && dragState && dragDates) {
    try {
      const plan = dragPlan([{ taskId: dragged.id, ...dragDates }], dragState.how);
      for (const [rows, names] of [
        [plan.upstream, movingUpstream],
        [plan.downstream, movingDownstream],
      ] as const) {
        for (const row of rows) {
          if (row.status !== "move") continue;
          previews.set(row.taskId, { startOn: row.newStart, dueOn: row.newDue });
          names.push(row.title);
        }
      }
    } catch {
      previews.clear();
      movingUpstream.length = 0;
      movingDownstream.length = 0;
    }
  }
  const liveLinks = dependencies.filter((d) => !removedDeps.has(d.id));
  const dependents = dragged ? dependentCount(dragged.id, liveLinks) : 0;
  const prerequisites = dragged ? prerequisiteCount(dragged.id, liveLinks) : 0;
  const placed = (task: ProjectTask): ProjectTask => {
    if (dragDates && task.id === dragged?.id) return { ...task, ...dragDates };
    const preview = previews.get(task.id);
    return preview ? { ...task, ...preview } : task;
  };
  const builtArrows =
    restingArrows ??
    buildArrows({ dependencies, removed: removedDeps, tasksById, rowCenter, placed, start, days, dayWidth, criticalPath, showCritical });
  // Nov 12 (batch 39, item 4): only the lines on (or passing through) the drawn band; the selected one stays.
  const arrows = builtArrows.filter((arrow) => arrow.id === selectedDep || arrowInView(arrow.y1, arrow.y2, viewTop, viewBottom));

  function dayAt(clientX: number, clientY: number) {
    const box = scrollRef.current?.getBoundingClientRect();
    const rect = gridRef.current?.getBoundingClientRect();
    if (!box || !rect) return null;
    if (clientY < box.top || clientY > box.bottom || clientX < box.left + LABEL_WIDTH || clientX > box.right) return null;
    const index = Math.floor((clientX - rect.left) / dayWidth);
    return index >= 0 && index < days ? index : null;
  }

  // Where the pointer is, in the timeline's content coordinates, and which task row it's over.
  function linkPoint(clientX: number, clientY: number) {
    const rect = contentRef.current?.getBoundingClientRect();
    const row = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-timeline-task]");
    return {
      x: rect ? clientX - rect.left : 0,
      y: rect ? clientY - rect.top : 0,
      overId: row?.dataset.timelineTask ?? null,
    };
  }

  const linkHandlers = linking
    ? {
        onPointerDownCapture: (e: PointerEvent<HTMLDivElement>) => {
          if (e.button !== 0) return;
          const row = (e.target as HTMLElement).closest<HTMLElement>("[data-timeline-task]");
          const fromId = row?.dataset.timelineTask;
          if (!fromId) return;
          // The line starts here instead of a bar drag or opening the pane.
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          const point = linkPoint(e.clientX, e.clientY);
          setLink({ fromId, x1: point.x, y1: rowCenter.get(fromId) ?? point.y, x2: point.x, y2: point.y, overId: null });
        },
        onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
          if (!link) return;
          const point = linkPoint(e.clientX, e.clientY);
          setLink({ ...link, x2: point.x, y2: point.y, overId: point.overId && point.overId !== link.fromId ? point.overId : null });
        },
        onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
          if (!link) return;
          const { overId } = linkPoint(e.clientX, e.clientY);
          const fromId = link.fromId;
          setLink(null);
          if (!overId || overId === fromId) return;
          const from = tasksById.get(fromId);
          const to = tasksById.get(overId);
          // Drawing a link that's already there would reset its type and lag: leave it as it is.
          if (dependencies.some((d) => d.predecessorId === fromId && d.successorId === overId)) {
            if (from && to) {
              notify(`“${bareTaskTitle(to.title, to.requestLabel)}” already waits on “${bareTaskTitle(from.title, from.requestLabel)}”`);
            }
            return;
          }
          runLink(async () => {
            const result = await setTaskDependency(fromId, overId);
            if (!result.error && from && to) {
              notify(`“${bareTaskTitle(to.title, to.requestLabel)}” is now blocked by “${bareTaskTitle(from.title, from.requestLabel)}”`);
            }
            return result;
          });
        },
        onPointerCancel: () => setLink(null),
        // No pane opens and no link is followed while drawing (dependency lines stay clickable).
        onClickCapture: (e: MouseEvent<HTMLDivElement>) => {
          if ((e.target as Element).closest("[data-dependency-line]")) return;
          e.preventDefault();
          e.stopPropagation();
        },
      }
    : {};

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
          if (index !== null) reschedule(task, { startOn: null, dueOn: addDays(start, index) }, timelineDragHow(e));
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
    <div className={VIEW_BODY} aria-busy={navigating}>
      {shift.dialog}
      <div className={`relative flex min-w-0 flex-1 flex-col ${navigating ? "opacity-60 transition-opacity" : ""}`}>
        <PeriodNav
          label={label}
          prevLabel={`Earlier ${ZOOM_STEP_LABEL[zoom]}`}
          nextLabel={`Later ${ZOOM_STEP_LABEL[zoom]}`}
          onPrev={() => navigate({ d: stepAnchor(anchor, zoom, -1) })}
          onNext={() => navigate({ d: stepAnchor(anchor, zoom, 1) })}
          onToday={() => navigate({ d: null })}
        >
          <div className="flex items-center gap-2">
            {canEdit ? (
              <button
                type="button"
                aria-pressed={showKeys}
                aria-label="Drag keys"
                onClick={() => setShowKeys(!showKeys)}
                data-tooltip="Drag: only this task · Shift+drag: linked tasks (before and after it) move along · Alt+drag: they move only as needed · Esc: cancel"
                className={`btn-icon ${showKeys ? "bg-zinc-100 text-zinc-900" : ""}`}
              >
                <Keyboard className="size-4" aria-hidden />
              </button>
            ) : null}
            {canEdit ? (
              <button
                type="button"
                aria-pressed={linking}
                onClick={() => {
                  setLink(null);
                  setLinking(!linking);
                }}
                data-tooltip={linking ? "Stop drawing (Esc)" : "Drag from one task to another to make the second wait on the first"}
                className={`btn-secondary ${linking ? "border-accent-600 bg-accent-600 text-white hover:bg-accent-700" : ""}`}
              >
                <Spline className="size-4" aria-hidden />
                Draw dependencies
              </button>
            ) : null}
            {/* Nov 2 notes (batch 15, 116): a show / hide switch, not a mode — it only highlights the chain
                the dependencies already make. Drawing (the button before it) always makes ordinary links. */}
            <button
              type="button"
              role="switch"
              aria-checked={showCritical}
              onClick={() => navigate({ cp: !showCritical })}
              data-tooltip="Highlight the longest chain of dependencies ending at the project’s last due date. It’s calculated, not drawn."
              className="btn-ghost gap-2"
            >
              <span
                aria-hidden
                className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${showCritical ? "bg-zinc-900" : "bg-zinc-300"}`}
              >
                <span className={`size-3 rounded-full bg-white shadow transition-transform ${showCritical ? "translate-x-3.5" : "translate-x-0.5"}`} />
              </span>
              <Route className="size-4" aria-hidden />
              Show critical path
            </button>
            <Segmented label="Timeline scale" options={ZOOMS} value={zoom} onChange={(z) => navigate({ tl: z })} />
          </div>
        </PeriodNav>
        {showKeys && canEdit ? (
          <div className="mb-2 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-xs text-zinc-600" role="note" aria-label="Drag keys">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {TIMELINE_DRAG_KEYS.map((k) => (
                <div key={k.keys} className="contents">
                  <dt>
                    <kbd className="rounded border border-zinc-300 bg-zinc-50 px-1 font-sans text-2xs text-zinc-700">{k.keys}</kbd>
                  </dt>
                  <dd>{k.what}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1.5 text-zinc-500">
              Hold the key when you let go (you can press or release it while dragging; the tasks that would move are
              outlined). On the Timeline the keys decide; elsewhere date changes follow this project’s Settings →
              Dependencies{shiftMode ? ` (${DEPENDENCY_SHIFT_OPTIONS[shiftMode].label})` : ""}.
            </p>
          </div>
        ) : null}
        {linking ? (
          <p className="mb-2 rounded-md bg-accent-50 px-2.5 py-1.5 text-xs text-accent-900" role="status">
            Drawing dependencies: drag from a task (its bar or its row) to the task that has to wait for it. The second
            one becomes blocked by the first. Click a line to select it (Delete removes it), or use its ×. Press Esc
            or the button again to stop.
            {showCritical ? " Lines you draw are ordinary dependencies; the critical path is worked out from them." : ""}
          </p>
        ) : null}
        {showCritical ? (
          <p className="mb-2 text-xs text-zinc-500" role="status">
            Showing the critical path, worked out from the dependencies (you can’t draw it): outlined bars are the
            chain of dependencies that ends at the project’s last due date with no slack. Other bars are faded; hover a bar for its slack. Counts every task in this project you can
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
          <div
            ref={contentRef}
            className={`relative min-h-full ${linking ? "cursor-crosshair select-none [&_*]:cursor-crosshair" : ""}`}
            style={{ width: LABEL_WIDTH + width, minHeight: contentHeight }}
            onPointerDown={(e) => {
              if (selectedDep && !(e.target as Element).closest("[data-dependency-line]")) setSelectedDep(null);
            }}
            {...linkHandlers}
          >
            <div
              ref={gridRef}
              aria-hidden
              className="pointer-events-none absolute inset-y-0"
              style={{ left: LABEL_WIDTH, width }}
            >
              {zoom === "week"
                ? Array.from({ length: days }, (_, i) => i)
                    // Days outside the workspace's workweek (Sun–Thu here: Fri and Sat; flaw audit C23).
                    .filter((i) => !workWeek.includes(weekday(addDays(start, i))))
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
                Name
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
                {canEdit
                  ? "No scheduled tasks match this view. Set a start or due date in the task pane, or drag an unscheduled task onto a day."
                  : "No scheduled tasks match this view."}
              </p>
            ) : null}

            {shownSlots.map((slot) =>
              slot.group ? (
                <div
                  key={slot.key}
                  className="absolute right-0 left-0 flex h-8 items-end border-b border-zinc-200 bg-zinc-50/80"
                  style={{ top: slot.top }}
                >
                  <div className="sticky left-0 z-10 flex items-center gap-2 px-3 pb-1.5" style={labelCell}>
                    {slot.group.color ? (
                      <span className={`truncate rounded-full px-2 py-0.5 text-xs font-medium ${OPTION_COLOR_CLASSES[slot.group.color]}`}>
                        {slot.group.label}
                      </span>
                    ) : (
                      <span className="truncate text-xs font-semibold text-zinc-700">{slot.group.label}</span>
                    )}
                    <span className="text-xs tabular-nums text-zinc-400">{slot.group.tasks.length}</span>
                  </div>
                </div>
              ) : slot.task ? (
                <TimelineRow
                  key={slot.key}
                  top={slot.top}
                  task={slot.task}
                  linkTarget={link !== null && link.overId === slot.task.id}
                  linkSource={link !== null && link.fromId === slot.task.id}
                  open={openTaskId === slot.task.id}
                  today={today}
                  width={width}
                  start={start}
                  days={days}
                  dayWidth={dayWidth}
                  canEdit={canEdit}
                  showCritical={showCritical}
                  schedule={criticalPath.tasks[slot.task.id]}
                  assignee={slot.task.assigneeId ? profilesById.get(slot.task.assigneeId) : undefined}
                  seed={() => seeds.task(slot.task!)}
                  preview={previews.get(slot.task.id) ?? null}
                  onCommit={(dates, how) => reschedule(slot.task!, dates, how)}
                  onReveal={(date) => navigate({ d: date })}
                  onDragging={setDraggedId}
                  onDragChange={setDragState}
                />
              ) : null,
            )}

            {arrows.length > 0 ? (
              <DependencyArrows
                arrows={arrows}
                width={width}
                height={contentHeight}
                editable={canEdit}
                selectedId={selectedDep}
                hoverId={hoverDep}
                onSelect={setSelectedDep}
                onHover={setHoverDep}
                onRemove={removeDependency}
              />
            ) : null}
            {link ? (
              <svg aria-hidden className="pointer-events-none absolute inset-0 z-30" width={LABEL_WIDTH + width} height={contentHeight}>
                <line
                  x1={link.x1}
                  y1={link.y1}
                  x2={link.x2}
                  y2={link.y2}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  className={link.overId ? "stroke-accent-600" : "stroke-zinc-400"}
                />
                <circle cx={link.x1} cy={link.y1} r={4} className="fill-accent-600" />
              </svg>
            ) : null}
          </div>
        </div>
        {dragState && dragged ? (
          <p
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute bottom-12 left-1/2 z-40 w-max max-w-[min(90%,40rem)] -translate-x-1/2 rounded-md bg-zinc-900/90 px-3 py-1.5 text-center text-xs text-white shadow-lg"
          >
            {timelineDragHint(dragState.how, { prerequisites, dependents, movingUpstream, movingDownstream })}
          </p>
        ) : null}
        <p className={VIEW_HINT}>
          {canEdit ? (
            <>
              Bars run from start to due date; diamonds are milestones on their due day. Drag a bar or diamond to move
              it, drag either end of a bar to change its start or due date, or drag an unscheduled task onto a day to
              give it a due date. A drag moves only that task: hold Shift to move its linked tasks along by the same
              amount — the tasks it depends on and the ones that depend on it — or Alt (Option) to move them only as far as
              their links need (dependents later, the tasks it depends on earlier); Esc cancels. Arrows link a
              task to the one waiting on it (red when the waiting task starts before the first one is due). Draw
              dependencies lets you drag from one task to another to link them.
            </>
          ) : (
            // Flaw audit C101: no drag instructions for people who can't drag.
            <>
              Bars run from start to due date; diamonds are milestones on their due day. Arrows link a task to the one
              waiting on it (red when the waiting task starts before the first one is due). Click a bar or a name to
              open the task.
            </>
          )}
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
              <TaskLink
                taskId={task.id}
                seed={() => seeds.task(task)}
                draggable={false}
                {...trayHandlers(task)}
                aria-current={openTaskId === task.id ? "true" : undefined}
                className={`flex min-w-0 ${canEdit ? "cursor-grab" : "cursor-pointer"} touch-pan-y items-center gap-1.5 rounded-md border bg-white px-1.5 py-1.5 text-xs shadow-xs select-none hover:border-zinc-300 ${
                  openTaskId === task.id ? "border-accent-500 ring-2 ring-accent-100" : "border-zinc-200"
                } ${trayDragging?.taskId === task.id ? "opacity-40" : ""}`}
              >
                <TaskNumberBadge label={task.requestLabel} />
                <span className="min-w-0 flex-1 truncate text-zinc-800">{bareTaskTitle(task.title, task.requestLabel)}</span>
                <Assignee profile={task.assigneeId ? profilesById.get(task.assigneeId) : undefined} />
              </TaskLink>
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

// Dependency arrows drawn over the bars. Nov 2 notes (batch 15, 116): for Editors each line is a target
// (a wide invisible stroke): hover shows a small × that removes it, a click selects it (Delete /
// Backspace removes it, Esc lets go), and Tab reaches each line too. The pane still lists dependencies for
// everyone. The sticky header and label column paint above them.
type Arrow = {
  id: string;
  path: string;
  conflict: boolean;
  tone: "normal" | "path" | "dim";
  handle: { x: number; y: number };
  label: string;
  // The rows it joins (content coordinates), to keep only the lines on screen.
  y1: number;
  y2: number;
};

// The dependency lines over the bars, in content coordinates (Nov 12, batch 39: a function of its own so
// the chart works them out once per change, not on every scroll).
type ArrowInput = {
  dependencies: readonly ProjectDependency[];
  removed: ReadonlySet<string>;
  tasksById: ReadonlyMap<string, ProjectTask>;
  rowCenter: ReadonlyMap<string, number>;
  placed: (task: ProjectTask) => ProjectTask;
  start: string;
  days: number;
  dayWidth: number;
  criticalPath: CriticalPath;
  showCritical: boolean;
};

function buildArrows(input: ArrowInput): Arrow[] {
  const { removed, tasksById, rowCenter, placed, start, days, dayWidth, criticalPath, showCritical } = input;
  return input.dependencies.flatMap((dep) => {
    if (removed.has(dep.id)) return [];
    const predTask = tasksById.get(dep.predecessorId);
    const succTask = tasksById.get(dep.successorId);
    const pred = predTask ? placed(predTask) : undefined;
    const succ = succTask ? placed(succTask) : undefined;
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
    const fromStart = fromPredecessorStart(dep.kind);
    const x1 = fromStart
      ? Math.max(daysBetween(start, a.start), 0) * dayWidth
      : Math.min(predEnd, days) * dayWidth;
    // *_to_finish links enter the successor's end (from the right).
    const toEnd = toSuccessorFinish(dep.kind);
    const x2 = toEnd ? Math.min(daysBetween(start, b.end) + 1, days) * dayWidth : Math.max(succStart, 0) * dayWidth;
    const pad = 8;
    const out = fromStart ? x1 - pad : x1 + pad;
    const path = toEnd
      ? `M${x1},${y1} H${Math.max(out, x2 + pad)} V${y2} H${x2}`
      : fromStart
      ? `M${x1},${y1} H${Math.min(out, x2 - pad)} V${y2} H${x2}`
      : x2 - x1 >= 2 * pad
        ? `M${x1},${y1} H${out} V${y2} H${x2}`
        : `M${x1},${y1} H${out} V${y1 + (y2 > y1 ? 1 : -1) * (ROW_HEIGHT / 2)} H${x2 - pad} V${y2} H${x2}`;
    const onPath = Boolean(
      criticalPath.tasks[dep.predecessorId]?.critical && criticalPath.tasks[dep.successorId]?.critical,
    );
    const conflict = dependencyConflict(pred, succ, dep.kind, dep.lagDays);
    // Where the × sits: on the line's vertical stretch, halfway between the rows.
    const handleX = toEnd ? Math.max(out, x2 + pad) : fromStart ? Math.min(out, x2 - pad) : out;
    const handleY = !toEnd && !fromStart && x2 - x1 < 2 * pad ? y1 + (y2 > y1 ? 1 : -1) * (ROW_HEIGHT / 4) : (y1 + y2) / 2;
    const label = `“${bareTaskTitle(succ.title, succ.requestLabel)}” waits on “${bareTaskTitle(pred.title, pred.requestLabel)}”`;
    return [
      { id: dep.id, path, conflict, tone: showCritical ? (onPath ? "path" : "dim") : "normal", handle: { x: handleX, y: handleY }, label, y1, y2 } as const,
    ];
  });
}

function DependencyArrows({
  arrows,
  width,
  height,
  editable,
  selectedId,
  hoverId,
  onSelect,
  onHover,
  onRemove,
}: {
  arrows: Arrow[];
  width: number;
  height: number;
  editable: boolean;
  selectedId: string | null;
  hoverId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onRemove: (id: string) => void;
}) {
  const id = useId();
  return (
    <svg
      aria-hidden={editable ? undefined : true}
      className="pointer-events-none absolute top-0 z-[5]"
      style={{ left: LABEL_WIDTH }}
      width={width}
      height={height}
    >
      <defs>
        {(["ok", "conflict", "selected"] as const).map((tone) => (
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
            <path d="M0,0 L6,3 L0,6 z" className={tone === "ok" ? "fill-zinc-400" : tone === "selected" ? "fill-accent-600" : "fill-red-400"} />
          </marker>
        ))}
      </defs>
      {arrows.map((arrow) => {
        const selected = selectedId === arrow.id;
        const hovered = hoverId === arrow.id;
        return (
          <g key={arrow.id} data-dependency-line={arrow.id}>
            <path
              d={arrow.path}
              fill="none"
              strokeWidth={selected ? 2.5 : arrow.tone === "path" ? 2 : hovered ? 2 : 1.25}
              opacity={arrow.tone === "dim" && !selected && !hovered ? 0.35 : 1}
              className={
                selected
                  ? "stroke-accent-600"
                  : arrow.conflict
                    ? "stroke-red-400"
                    : arrow.tone === "path"
                      ? "stroke-zinc-800"
                      : hovered
                        ? "stroke-zinc-600"
                        : "stroke-zinc-400"
              }
              markerEnd={`url(#${id}-${selected ? "selected" : arrow.conflict ? "conflict" : "ok"})`}
            />
            {editable ? (
              <path
                d={arrow.path}
                fill="none"
                stroke="transparent"
                strokeWidth={10}
                style={{ pointerEvents: "stroke", cursor: "pointer" }}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`Dependency: ${arrow.label}. Press Delete to remove it.`}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerEnter={() => onHover(arrow.id)}
                onPointerLeave={() => onHover(null)}
                onFocus={() => onSelect(arrow.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(selected ? null : arrow.id);
                }}
                className="outline-none"
              />
            ) : null}
            {editable && (hovered || selected) ? (
              <g
                transform={`translate(${arrow.handle.x}, ${arrow.handle.y})`}
                style={{ pointerEvents: "all", cursor: "pointer" }}
                role="button"
                aria-label={`Remove the dependency: ${arrow.label}`}
                onPointerEnter={() => onHover(arrow.id)}
                onPointerLeave={() => onHover(null)}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(arrow.id);
                }}
              >
                <title>Remove this dependency</title>
                <circle r={8} className="fill-white stroke-zinc-400" strokeWidth={1} />
                <path d="M-3,-3 L3,3 M3,-3 L-3,3" className="stroke-zinc-700" strokeWidth={1.5} strokeLinecap="round" />
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function TimelineRow({
  top,
  task,
  linkTarget = false,
  linkSource = false,
  open,
  today,
  width,
  start,
  days,
  dayWidth,
  canEdit,
  showCritical,
  schedule,
  assignee,
  seed,
  preview,
  onCommit,
  onReveal,
  onDragging,
  onDragChange,
}: {
  top: number;
  task: ProjectTask;
  // Draw dependencies: the row the line starts from / is over.
  linkTarget?: boolean;
  linkSource?: boolean;
  open: boolean;
  today: string;
  width: number;
  start: string;
  days: number;
  dayWidth: number;
  canEdit: boolean;
  showCritical: boolean;
  schedule: TaskSchedule | undefined;
  assignee: Profile | undefined;
  seed: () => TaskSeed;
  // Where this task would go with the bar being dragged elsewhere (its dependents move with it).
  preview: Dates | null;
  onCommit: (dates: Dates, how: TimelineDragHow) => void;
  onReveal: (date: string) => void;
  onDragging: (taskId: string | null) => void;
  onDragChange: (drag: BarDrag | null) => void;
}) {
  const completed = Boolean(task.completedAt);
  const overdue = isOverdue(task.dueOn, today, completed);
  const span = spanOf(task)!;
  return (
    <div
      data-timeline-task={task.id}
      className={`absolute right-0 left-0 flex h-9 border-b border-zinc-100 ${linkTarget ? "bg-accent-50 ring-2 ring-inset ring-accent-400" : linkSource ? "bg-accent-50/60" : ""}`}
      style={{ top }}
    >
      <div
        className={`sticky left-0 z-10 flex items-center gap-2 border-r border-zinc-200 px-3 ${
          open || linkTarget || linkSource ? "bg-accent-50" : "bg-white"
        }`}
        style={labelCell}
      >
        <TaskNumberBadge label={task.requestLabel} />
        <TaskLink
          taskId={task.id}
          seed={seed}
          aria-current={open ? "true" : undefined}
          className={`min-w-0 flex-1 truncate text-sm hover:underline ${
            completed ? "text-zinc-400 line-through" : "text-zinc-900"
          }`}
        >
          {bareTaskTitle(task.title, task.requestLabel)}
          <span className="sr-only">
            {task.kind === "milestone" ? ", milestone" : ""}, {spanLabel(span)}
            {overdue ? ", overdue" : ""}
            {completed ? ", completed" : ""}
            {task.blockedBy > 0 && !completed ? `, blocked by ${task.blockedBy}` : ""}
            {assignee ? `, assigned to ${displayName(assignee)}` : ""}
            {schedule ? `, ${slackLabel(schedule)}` : ""}
          </span>
        </TaskLink>
        <span aria-hidden>
          <Assignee profile={assignee} />
        </span>
      </div>
      <div className="relative" style={{ width }}>
        <TimelineBar
          task={task}
          seed={seed}
          open={open}
          overdue={overdue}
          windowStart={start}
          days={days}
          dayWidth={dayWidth}
          canEdit={canEdit}
          schedule={schedule}
          highlight={showCritical ? (schedule?.critical ? "critical" : "dim") : null}
          preview={preview}
          onCommit={onCommit}
          onReveal={onReveal}
          onDragging={(active) => onDragging(active ? task.id : null)}
          onDragChange={(drag) => onDragChange(drag ? { taskId: task.id, ...drag } : null)}
        />
      </div>
    </div>
  );
}

type Drag = { mode: DragMode; delta: number; moved: boolean; how: TimelineDragHow };
// What the view knows about the bar being dragged (Nov 3 notes, batch 19, 148).
type BarDrag = { taskId: string; mode: DragMode; delta: number; how: TimelineDragHow };

function TimelineBar({
  task,
  seed,
  open,
  overdue,
  windowStart,
  days,
  dayWidth,
  canEdit,
  schedule,
  highlight,
  preview = null,
  onCommit,
  onReveal,
  onDragging,
  onDragChange,
}: {
  task: ProjectTask;
  seed: () => TaskSeed;
  open: boolean;
  overdue: boolean;
  windowStart: string;
  days: number;
  dayWidth: number;
  canEdit: boolean;
  schedule: TaskSchedule | undefined;
  highlight: "critical" | "dim" | null;
  preview?: Dates | null;
  onCommit: (dates: Dates, how: TimelineDragHow) => void;
  onReveal: (date: string) => void;
  onDragging?: (active: boolean) => void;
  onDragChange?: (drag: Omit<BarDrag, "taskId"> | null) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // Pointer-up can arrive before React renders the last move, so the gesture is tracked outside state.
  const gesture = useRef<{
    mode: DragMode;
    originX: number;
    lastX: number;
    moved: boolean;
    how: TimelineDragHow;
    el: HTMLElement;
    pointerId: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const published = useRef<string | null>(null);
  const shown = drag && drag.delta !== 0 ? draggedDates(task, drag.mode, drag.delta) : preview ? { ...task, ...preview } : task;
  const span = spanOf(shown)!;
  const from = daysBetween(windowStart, span.start);
  const to = daysBetween(windowStart, span.end);
  const completed = Boolean(task.completedAt);
  // Moving with the bar being dragged (Shift / Alt): drawn where it would go, outlined.
  const moving = !drag && preview !== null;
  const outline = moving
    ? "outline-2 outline-dashed outline-offset-1 outline-accent-700"
    : highlight === "critical"
      ? "outline-2 outline-offset-1 outline-zinc-900"
      : "";
  const faded = highlight === "dim" && !moving ? "opacity-35" : "";

  // While dragging: Shift / Alt can be pressed or let go without moving the pointer, and Esc cancels.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    function onKey(e: KeyboardEvent) {
      const g = gesture.current;
      if (!g) return;
      if (e.type === "keydown" && e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        try {
          g.el.releasePointerCapture(g.pointerId);
        } catch {
          // Already released.
        }
        // The click that follows letting go must not open the task.
        suppressClick.current = g.moved;
        cancel();
        return;
      }
      if (e.key === "Shift" || e.key === "Alt") {
        // Alt alone would focus the browser's menu bar on some systems.
        if (e.key === "Alt") e.preventDefault();
        publish(track(g.lastX, e));
      }
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  });
  if (!drag && (to < 0 || from >= days)) {
    const before = to < 0;
    // Sticky inside the full-width row so the button stays visible at the scrolled edge.
    return (
      <div className={`absolute inset-0 flex items-center ${before ? "justify-start" : "justify-end"}`}>
        <button
          type="button"
          onClick={() => onReveal(span.start)}
          aria-label={`Show “${displayTaskTitle(task.title, task.requestLabel)}” (${spanLabel(span)}) on the timeline`}
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
  const labelInside = width >= displayTaskTitle(task.title, task.requestLabel).length * 6.5 + 20;
  const tone = completed
    ? "bg-zinc-200 text-zinc-500"
    : span.openEnded
      ? "border border-dashed border-accent-500 bg-accent-50 text-accent-700"
      : overdue
        ? "bg-red-500 text-white"
        : "bg-accent-500 text-white";

  function publish(next: Drag | null) {
    setDrag((prev) =>
      prev && next && prev.delta === next.delta && prev.moved === next.moved && prev.how === next.how ? prev : next,
    );
    // The view redraws the dependents only when what it shows changes.
    const key = next && next.moved ? `${next.mode} ${next.delta} ${next.how}` : null;
    if (key === published.current) return;
    published.current = key;
    onDragChange?.(next && next.moved ? { mode: next.mode, delta: next.delta, how: next.how } : null);
  }

  function onPointerDown(e: PointerEvent<HTMLAnchorElement>) {
    suppressClick.current = false;
    if (e.button !== 0 || !canEdit) return;
    const edge = (e.target as HTMLElement).dataset.edge;
    const mode: DragMode = task.kind !== "milestone" && (edge === "start" || edge === "end") ? edge : "move";
    e.currentTarget.setPointerCapture(e.pointerId);
    const how = timelineDragHow(e);
    gesture.current = { mode, originX: e.clientX, lastX: e.clientX, moved: false, how, el: e.currentTarget, pointerId: e.pointerId };
    publish({ mode, delta: 0, moved: false, how });
    onDragging?.(true);
  }

  function track(clientX: number, keys?: { shiftKey: boolean; altKey: boolean }): Drag {
    const g = gesture.current!;
    g.lastX = clientX;
    if (keys) g.how = timelineDragHow(keys);
    const dx = clientX - g.originX;
    g.moved = g.moved || Math.abs(dx) > 3;
    return { mode: g.mode, delta: Math.round(dx / dayWidth), moved: g.moved, how: g.how };
  }

  function onPointerMove(e: PointerEvent<HTMLAnchorElement>) {
    if (!gesture.current) return;
    publish(track(e.clientX, e));
  }

  function onPointerUp(e: PointerEvent<HTMLAnchorElement>) {
    if (!gesture.current) return;
    const { mode, delta, moved, how } = track(e.clientX, e);
    gesture.current = null;
    if (moved) suppressClick.current = true;
    if (delta !== 0) onCommit(draggedDates(task, mode, delta), how);
    publish(null);
    onDragging?.(false);
  }

  function cancel() {
    gesture.current = null;
    publish(null);
    onDragging?.(false);
  }

  const suppress = (e: MouseEvent) => {
    if (suppressClick.current) {
      e.preventDefault();
      suppressClick.current = false;
      return;
    }
    // Shift and Alt are drag keys here: a click with them held isn't a new window or a download.
    if (e.shiftKey || e.altKey) e.preventDefault();
  };

  // A milestone is a diamond on its due day: drag moves it, there are no ends to resize.
  if (task.kind === "milestone") {
    const size = 14;
    const center = (Math.min(Math.max(to, 0), days - 1) + 0.5) * dayWidth;
    const fill = completed ? "bg-zinc-300" : overdue ? "bg-red-500" : "bg-accent-600";
    return (
      <>
        <TaskLink
          taskId={task.id}
          seed={seed}
          draggable={false}
          tabIndex={-1}
          aria-hidden
          title={`Milestone: ${displayTaskTitle(task.title, task.requestLabel)} · ${formatDueDate(span.end)}${schedule ? ` · ${slackLabel(schedule)}` : ""}`}
          onClick={suppress}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancel}
          className={`absolute top-1/2 flex touch-pan-y items-center justify-center select-none ${faded} ${
            drag?.moved ? "z-10 cursor-grabbing" : canEdit ? "cursor-grab" : "cursor-pointer"
          }`}
          style={{ left: center - size, width: size * 2, height: size * 2, marginTop: -size }}
        >
          <span
            className={`block rotate-45 rounded-[2px] ${fill} ${open ? "ring-2 ring-accent-200 ring-offset-1" : ""} ${outline} ${
              drag?.moved ? "shadow-lg shadow-zinc-900/20" : ""
            }`}
            style={{ width: size - 2, height: size - 2 }}
          />
        </TaskLink>
        <span
          aria-hidden
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 truncate pl-1 text-xs whitespace-nowrap ${
            completed ? "text-zinc-400 line-through" : "text-zinc-600"
          }`}
          style={{ left: center + size, maxWidth: 240 }}
        >
          {bareTaskTitle(task.title, task.requestLabel)}
          <TaskNumberBadge label={task.requestLabel} size="2xs" className="ml-1" />
        </span>
        {drag?.moved || moving ? (
          <span
            aria-hidden
            className={`pointer-events-none absolute -top-4 z-20 rounded px-1.5 py-0.5 text-2xs whitespace-nowrap tabular-nums ${
              moving ? "bg-accent-700 text-white" : "bg-zinc-900 text-white"
            }`}
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
      <TaskLink
        taskId={task.id}
        seed={seed}
        draggable={false}
        tabIndex={-1}
        aria-hidden
        title={`${displayTaskTitle(task.title, task.requestLabel)} · ${spanLabel(span)}${schedule ? ` · ${slackLabel(schedule)}` : ""}`}
        onClick={suppress}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancel}
        className={`group absolute top-1.5 flex h-6 touch-pan-y items-center rounded-md text-xs select-none ${tone} ${
          clippedStart ? "rounded-l-none" : ""
        } ${clippedEnd ? "rounded-r-none" : ""} ${open ? "ring-2 ring-accent-200 ring-offset-1" : ""} ${outline} ${faded} ${
          drag?.moved ? "z-10 cursor-grabbing shadow-lg shadow-zinc-900/20" : canEdit ? "cursor-grab" : "cursor-pointer"
        }`}
        style={{ left, width }}
      >
        {labelInside ? (
          <span className={`flex min-w-0 flex-1 items-baseline gap-1 px-2 ${completed ? "line-through" : ""}`}>
            <span className="min-w-0 truncate">{bareTaskTitle(task.title, task.requestLabel)}</span>
            <TaskNumberBadge label={task.requestLabel} size="2xs" tone="inherit" />
          </span>
        ) : null}
        {canResize && !clippedStart ? (
          <span data-edge="start" className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md group-hover:bg-black/10" />
        ) : null}
        {canResize && !clippedEnd ? (
          <span data-edge="end" className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md group-hover:bg-black/10" />
        ) : null}
      </TaskLink>
      {!labelInside ? (
        <span
          aria-hidden
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 truncate pl-1.5 text-xs whitespace-nowrap ${
            completed ? "text-zinc-400 line-through" : "text-zinc-600"
          }`}
          style={{ left: left + width, maxWidth: 240 }}
        >
          {bareTaskTitle(task.title, task.requestLabel)}
          <TaskNumberBadge label={task.requestLabel} size="2xs" className="ml-1" />
        </span>
      ) : null}
      {drag?.moved || moving ? (
        <span
          aria-hidden
          className={`pointer-events-none absolute -top-4 z-20 rounded px-1.5 py-0.5 text-2xs whitespace-nowrap tabular-nums ${
            moving ? "bg-accent-700 text-white" : "bg-zinc-900 text-white"
          }`}
          style={{ left }}
        >
          {spanLabel(span)}
        </span>
      ) : null}
    </>
  );
}
