"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { CalendarOff, EyeOff, FolderClosed } from "lucide-react";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import {
  ZOOMS,
  daysBetween,
  dayWidthOf,
  headerTiers,
  isZoom,
  spanLabel,
  spanOf,
  stepAnchor,
  visibleWindow,
  weekday,
  windowLabel,
  type Zoom,
} from "@/components/project/timeline-scale";
import { PeriodNav, Segmented, TRAY_EMPTY, TRAY_HEADING, VIEW_BODY, VIEW_HINT, ViewLoading, trayClass } from "@/components/project/view-chrome";
import { addDays, useToday } from "@/lib/dates";
import type { PortfolioTimelineRow } from "@/lib/data";
import { OWN_PROJECTS_LABEL, PROJECT_STATUS_LABELS, isProjectStatus } from "@/lib/portfolios";

const LABEL_WIDTH = 256;
const labelCell = { width: LABEL_WIDTH, minWidth: LABEL_WIDTH };

// Bar colour = project status (the same meaning as the status badge: accent on track, amber at risk,
// red off track, zinc complete). The status is always spelled out for screen readers too.
const BAR_CLASS = {
  on_track: "bg-accent-500 text-white",
  at_risk: "bg-amber-400 text-amber-950",
  off_track: "bg-red-500 text-white",
  complete: "bg-zinc-300 text-zinc-700",
} as const;

type Group = { key: string; label: string; href: string | null; rows: PortfolioTimelineRow[] };

// One read-only bar per readable project: earliest start to latest due of its open tasks
// (portfolio_timeline()). Grouped by the nested portfolio each project comes from.
export function PortfolioTimeline({
  rows,
  nested,
  hiddenCount,
}: {
  rows: PortfolioTimelineRow[];
  nested: { id: string; name: string }[];
  hiddenCount: number;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const today = useToday();
  const requested = searchParams.get("d");
  const zoomParam = searchParams.get("tl");
  const zoom: Zoom = isZoom(zoomParam) ? zoomParam : "month";
  const anchor = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : today;

  function navigate(next: { d?: string | null; tl?: Zoom }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.d !== undefined) {
      if (next.d) params.set("d", next.d);
      else params.delete("d");
    }
    if (next.tl) {
      if (next.tl === "month") params.delete("tl");
      else params.set("tl", next.tl);
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }

  if (!anchor || !today) return <ViewLoading label="Loading timeline…" />;

  const dayWidth = dayWidthOf(zoom);
  const { start, days } = visibleWindow(anchor, zoom);
  const width = days * dayWidth;
  const tiers = headerTiers(start, days, zoom);
  const todayOffset = daysBetween(start, today);

  const scheduled = rows.filter((r) => r.startOn && r.dueOn);
  const unscheduled = rows.filter((r) => !r.startOn || !r.dueOn);
  const byOrder = (a: PortfolioTimelineRow, b: PortfolioTimelineRow) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  const groups: Group[] = [
    { key: "own", label: OWN_PROJECTS_LABEL, href: null, rows: scheduled.filter((r) => r.groupId === null).sort(byOrder) },
    ...nested.map((child) => ({
      key: child.id,
      label: child.name,
      href: `/portfolios/${child.id}`,
      rows: scheduled.filter((r) => r.groupId === child.id).sort(byOrder),
    })),
  ].filter((g) => g.rows.length > 0);

  return (
    <div className={VIEW_BODY}>
      <div className="flex min-w-0 flex-1 flex-col">
        <PeriodNav
          label={windowLabel(start, days)}
          prevLabel={`Earlier (${zoom})`}
          nextLabel={`Later (${zoom})`}
          onPrev={() => navigate({ d: stepAnchor(anchor, zoom, -1) })}
          onNext={() => navigate({ d: stepAnchor(anchor, zoom, 1) })}
          onToday={() => navigate({ d: null })}
        >
          <Segmented label="Timeline scale" options={ZOOMS} value={zoom} onChange={(z) => navigate({ tl: z })} />
        </PeriodNav>
        {hiddenCount > 0 ? (
          <p className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
            <EyeOff className="size-3.5 shrink-0" aria-hidden />
            {hiddenCount === 1 ? "1 project isn’t" : `${hiddenCount} projects aren’t`} shown because you’re not a member.
          </p>
        ) : null}

        <div key={`${zoom}-${start}`} className="relative min-h-0 flex-1 overflow-auto rounded-lg border border-zinc-200 bg-white">
          <div className="relative min-h-full" style={{ width: LABEL_WIDTH + width }}>
            <div aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: LABEL_WIDTH, width }}>
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
              {todayOffset >= 0 && todayOffset < days ? (
                <div className="absolute inset-y-0 w-px bg-accent-500" style={{ left: (todayOffset + 0.5) * dayWidth }} />
              ) : null}
            </div>

            <div className="sticky top-0 z-20 flex border-b border-zinc-200 bg-white">
              <div
                className="sticky left-0 z-10 flex items-end border-r border-zinc-200 bg-white px-3 pb-1.5 text-xs font-medium text-zinc-500"
                style={labelCell}
              >
                Project
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
                  {tiers.bottom.map((seg) => (
                    <span
                      key={seg.key}
                      className={`absolute inset-y-0 truncate border-l border-zinc-100 pt-1 text-2xs tabular-nums ${
                        zoom === "week" ? "text-center" : "px-1"
                      } ${zoom === "week" && seg.offset === todayOffset ? "font-semibold text-accent-700" : "text-zinc-500"}`}
                      style={{ left: seg.offset * dayWidth, width: seg.length * dayWidth }}
                    >
                      {seg.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {groups.length === 0 ? (
              <p className="sticky left-0 max-w-md px-3 py-6 text-sm text-zinc-500">
                No project here has open tasks with dates yet. Give tasks a start or due date and their project shows up
                as a bar.
              </p>
            ) : null}

            {groups.map((group) => (
              <section key={group.key} aria-label={group.label}>
                <div className="relative flex h-8 items-end border-b border-zinc-200 bg-zinc-50/80">
                  <div className="sticky left-0 z-10 flex items-center gap-2 px-3 pb-1.5" style={labelCell}>
                    {group.href ? (
                      <Link href={group.href} className="truncate text-xs font-semibold text-zinc-700 hover:underline">
                        {group.label}
                      </Link>
                    ) : (
                      <span className="truncate text-xs font-semibold text-zinc-700">{group.label}</span>
                    )}
                    <span className="text-xs tabular-nums text-zinc-400">{group.rows.length}</span>
                  </div>
                </div>
                <ul>
                  {group.rows.map((row) => (
                    <ProjectRow
                      key={row.id}
                      row={row}
                      windowStart={start}
                      days={days}
                      dayWidth={dayWidth}
                      onReveal={(date) => navigate({ d: date })}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
        <p className={VIEW_HINT}>
          Each bar runs from the earliest start to the latest due date of the project’s open tasks, coloured by the
          project’s status. Projects of nested portfolios are grouped under them.
        </p>
      </div>

      <aside aria-label="Projects without dates" className={trayClass()}>
        <h3 className={TRAY_HEADING}>
          <CalendarOff className="size-4 text-zinc-500" aria-hidden />
          No dates
          <span className="text-xs font-normal tabular-nums text-zinc-400">{unscheduled.length}</span>
        </h3>
        <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
          {unscheduled.map((row) => (
            <li key={row.id}>
              <Link
                href={`/projects/${row.id}`}
                className="flex min-w-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-1.5 py-1.5 text-xs shadow-xs hover:border-zinc-300"
              >
                <FolderClosed className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-zinc-800">{row.name}</span>
                <span className="shrink-0 text-zinc-400 tabular-nums">{row.openTasks} open</span>
              </Link>
            </li>
          ))}
          {unscheduled.length === 0 ? (
            <li className={TRAY_EMPTY}>Every project here has open tasks with dates.</li>
          ) : null}
        </ul>
      </aside>
    </div>
  );
}

function ProjectRow({
  row,
  windowStart,
  days,
  dayWidth,
  onReveal,
}: {
  row: PortfolioTimelineRow;
  windowStart: string;
  days: number;
  dayWidth: number;
  onReveal: (date: string) => void;
}) {
  const span = spanOf(row)!;
  const from = daysBetween(windowStart, span.start);
  const to = daysBetween(windowStart, span.end);
  const status = isProjectStatus(row.status) ? row.status : "on_track";
  const href = `/projects/${row.id}`;
  const outside = to < 0 || from >= days;
  const left = Math.max(from, 0) * dayWidth;
  const barWidth = Math.max((Math.min(to + 1, days) - Math.max(from, 0)) * dayWidth, 4);
  const labelInside = barWidth >= row.name.length * 6.5 + 20;

  return (
    <li className="relative flex h-9 border-b border-zinc-100">
      <div className="sticky left-0 z-10 flex items-center gap-2 border-r border-zinc-200 bg-white px-3" style={labelCell}>
        <Link href={href} className="min-w-0 flex-1 truncate text-sm text-zinc-900 hover:underline">
          {row.name}
          <span className="sr-only">
            , {spanLabel(span)}, {PROJECT_STATUS_LABELS[status]}, {row.openTasks} open tasks
          </span>
        </Link>
        <span aria-hidden>
          <ProjectStatusBadge status={row.status} note={row.statusNote} />
        </span>
      </div>
      <div className="relative" style={{ width: days * dayWidth }}>
        {outside ? (
          <div className={`absolute inset-0 flex items-center ${to < 0 ? "justify-start" : "justify-end"}`}>
            <button
              type="button"
              onClick={() => onReveal(span.start)}
              aria-label={`Show “${row.name}” (${spanLabel(span)}) on the timeline`}
              className="sticky mx-1 rounded bg-white/90 px-1.5 py-0.5 text-xs whitespace-nowrap text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              style={to < 0 ? { left: LABEL_WIDTH } : { right: 0 }}
            >
              {to < 0 ? `‹ ${spanLabel(span)}` : `${spanLabel(span)} ›`}
            </button>
          </div>
        ) : (
          <>
            <Link
              href={href}
              tabIndex={-1}
              aria-hidden
              title={`${row.name} · ${spanLabel(span)} · ${PROJECT_STATUS_LABELS[status]} · ${row.openTasks} open tasks`}
              className={`absolute top-1.5 flex h-6 items-center rounded-md text-xs ${BAR_CLASS[status]} ${
                from < 0 ? "rounded-l-none" : ""
              } ${to >= days ? "rounded-r-none" : ""}`}
              style={{ left, width: barWidth }}
            >
              {labelInside ? <span className="min-w-0 flex-1 truncate px-2">{row.name}</span> : null}
            </Link>
            {!labelInside ? (
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 -translate-y-1/2 truncate pl-1.5 text-xs whitespace-nowrap text-zinc-600"
                style={{ left: left + barWidth, maxWidth: 240 }}
              >
                {row.name}
              </span>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}
