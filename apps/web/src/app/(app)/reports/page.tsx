import type { Metadata } from "next";
import { ExportLink, IntervalToggle, PrintButton } from "@/components/reports/report-chrome";
import { ReportFiltersBar } from "@/components/reports/report-filters";
import {
  BarsOrEmpty,
  HiddenProjectsNote,
  OverdueTable,
  ReportCard,
  StatTiles,
  statusBars,
} from "@/components/reports/report-blocks";
import {
  MAX_SECTION_BARS,
  assigneeBars,
  loadReportContext,
  overdueRows,
  projectBars,
  sectionBars,
} from "@/components/reports/load-report";
import { ScheduleEmailButton } from "@/components/reports/schedule-email";
import { SeriesChart } from "@/components/reports/series-chart";
import { requireMember } from "@/lib/auth";
import {
  countHiddenWorkspaceProjects,
  listActivePeople,
  reportCompletedSeries,
  reportOverdueTasks,
  tagsEnabled,
  workspaceReport,
} from "@/lib/data";
import { EMPTY_COUNTS, RECENT_DAYS } from "@alhc/core/portfolios";
import {
  describeReportFilters,
  filtersFromParams,
  filtersToParams,
  isDefaultWindow,
  isSeriesInterval,
  withDefaultWindow,
  withoutReportTags,
} from "@alhc/core/reports";
import { softRead } from "@alhc/core/api/core/soft-read";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@alhc/core/workload";

export const metadata: Metadata = { title: "Reports" };

const OVERDUE_SHOWN = 25;

// Workspace report over every project the viewer can read. Filters live in the URL (shareable; the
// CSV links reuse them). Every number comes from SECURITY INVOKER RPCs; unreadable projects are only
// a count.
export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const params = await searchParams;
  // Oct 26 notes (batch 3): no tag filter while the workspace's tags are switched off.
  const timeZone = await getViewerTimeZone();
  const today = todayIn(timeZone);
  // The URL's filters (what a schedule saves: never a fixed date window it didn't ask for) and what the
  // page runs with (Nov 2 notes, batch 13: 30 days centered on today unless the URL says otherwise).
  const urlFilters = withoutReportTags(filtersFromParams(params), await tagsEnabled());
  const filters = withDefaultWindow(urlFilters, params, today);
  const interval = isSeriesInterval(params.int) ? params.int : "week";

  // Nov 3 notes (batch 19, 144): one wave of reads (the overdue list no longer waits for the rest), and the
  // side reads (hidden count, schedule-email people) never take the page down.
  const [context, totals, byProject, byAssignee, bySection, series, hidden, member, people, overdueTasks] =
    await Promise.all([
      loadReportContext(timeZone),
      workspaceReport(filters, "none", timeZone),
      workspaceReport(filters, "project", timeZone),
      workspaceReport(filters, "assignee", timeZone),
      workspaceReport(filters, "section", timeZone),
      reportCompletedSeries(filters, interval, timeZone),
      softRead("reports hidden count", countHiddenWorkspaceProjects(), 0),
      requireMember(),
      softRead("reports people", listActivePeople(), []),
      reportOverdueTasks(filters, timeZone),
    ]);
  const sections = await sectionBars(bySection, context);
  const overdue = overdueRows(overdueTasks, context);
  const counts = totals[0] ?? EMPTY_COUNTS;
  const query = filtersToParams(filters);
  const exportHref = (table: string, extra?: Record<string, string>) => {
    const p = new URLSearchParams(query);
    p.set("table", table);
    for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
    return `/export/report?${p.toString()}`;
  };
  const summary = describeReportFilters(filters, context.projects, context.people, context.tags);
  const aroundToday = isDefaultWindow(filters, today);

  return (
    <div className="space-y-5 bg-zinc-50/50 px-gutter py-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <ReportFiltersBar
          filters={filters}
          projects={context.projects}
          people={context.people}
          tags={context.tags}
          today={today}
        />
        <div className="flex items-center gap-2">
          <ScheduleEmailButton
            available
            report="overview"
            filters={urlFilters}
            filterSummary={describeReportFilters(urlFilters, context.projects, context.people, context.tags)}
            people={people}
            meId={member.id}
          />
          <ExportLink href={exportHref("breakdown")} />
          <PrintButton />
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        <span className="font-medium text-zinc-700">
          {summary.length ? summary.join(" · ") : "Every task in every project you can open."}
        </span>
        {aroundToday ? " (30 days centered on today; tasks due or completed in that window)." : null} Overdue means
        incomplete and due before today in your time zone. Subtasks count through their top-level task’s projects when
        included.
      </p>
      <HiddenProjectsNote count={hidden} />

      <StatTiles counts={counts} />

      <div className="grid gap-4 lg:grid-cols-3">
        <ReportCard
          id="report-series"
          title={`Completed per ${interval}`}
          subtitle={`Local ${interval === "week" ? "weeks (starting Sunday)" : "days"} in your time zone${
            filters.from || filters.to ? ", within the date range" : `; the last ${interval === "week" ? "12 weeks" : "30 days"}`
          } · ${counts.completedRecent.toLocaleString("en-US")} in the last ${RECENT_DAYS} days`}
          wide
          actions={
            <>
              <IntervalToggle value={interval} />
              <ExportLink href={exportHref("series", { int: interval })} label="CSV" variant="ghost" />
            </>
          }
        >
          {series.length ? (
            <SeriesChart data={series} interval={interval} caption={`Tasks completed per ${interval}`} />
          ) : (
            <p className="py-8 text-center text-sm text-zinc-500">No dates in range.</p>
          )}
        </ReportCard>
        <ReportCard id="report-status" title="Tasks by status" subtitle={`${counts.total.toLocaleString("en-US")} tasks`}>
          <BarsOrEmpty data={statusBars(counts)} caption="Tasks by status" />
        </ReportCard>
      </div>

      <ReportCard
        id="report-overdue"
        title={`Overdue (${overdue.length}${overdue.length === 200 ? "+" : ""})`}
        subtitle="Oldest due date first"
        actions={<ExportLink href={exportHref("overdue")} label="CSV" variant="ghost" />}
      >
        <OverdueTable rows={overdue} caption="Overdue tasks, oldest due date first" limit={OVERDUE_SHOWN} />
      </ReportCard>

      <section aria-labelledby="report-breakdowns" className="space-y-3">
        <h2 id="report-breakdowns" className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Breakdowns
        </h2>
        <div className="grid gap-4 lg:grid-cols-3">
          <ReportCard id="report-project" title="Tasks by project">
            <BarsOrEmpty data={projectBars(byProject, context)} caption="Tasks by project" tone="blue" />
          </ReportCard>
          <ReportCard id="report-assignee" title="Tasks by assignee">
            <BarsOrEmpty data={assigneeBars(byAssignee, context)} caption="Tasks by assignee" tone="violet" />
          </ReportCard>
          <ReportCard
            id="report-section"
            title="Tasks by section"
            subtitle={sections.more > 0 ? `The ${MAX_SECTION_BARS} largest; ${sections.more} more in the CSV` : undefined}
          >
            <BarsOrEmpty data={sections.bars} caption="Tasks by section" tone="teal" />
          </ReportCard>
        </div>
      </section>
    </div>
  );
}
