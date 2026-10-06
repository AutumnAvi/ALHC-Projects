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
  loadOverdueRows,
  loadReportContext,
  projectBars,
  sectionBars,
} from "@/components/reports/load-report";
import { SeriesChart } from "@/components/reports/series-chart";
import { countHiddenWorkspaceProjects, reportCompletedSeries, workspaceReport } from "@/lib/data";
import { EMPTY_COUNTS, RECENT_DAYS } from "@/lib/portfolios";
import { describeReportFilters, filtersFromParams, filtersToParams, isSeriesInterval } from "@/lib/reports";
import { getViewerTimeZone } from "@/lib/timezone";

export const metadata: Metadata = { title: "Reports" };

const OVERDUE_SHOWN = 25;

// Workspace report over every project the viewer can read. Filters live in the URL (shareable; the
// CSV links reuse them). Every number comes from SECURITY INVOKER RPCs; unreadable projects are only
// a count.
export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const params = await searchParams;
  const filters = filtersFromParams(params);
  const interval = isSeriesInterval(params.int) ? params.int : "week";
  const timeZone = await getViewerTimeZone();

  const [context, totals, byProject, byAssignee, bySection, series, hidden] = await Promise.all([
    loadReportContext(timeZone),
    workspaceReport(filters, "none", timeZone),
    workspaceReport(filters, "project", timeZone),
    workspaceReport(filters, "assignee", timeZone),
    workspaceReport(filters, "section", timeZone),
    reportCompletedSeries(filters, interval, timeZone),
    countHiddenWorkspaceProjects(),
  ]);
  const [sections, overdue] = await Promise.all([
    sectionBars(bySection, context),
    loadOverdueRows(filters, timeZone, context),
  ]);
  const counts = totals[0] ?? EMPTY_COUNTS;
  const query = filtersToParams(filters);
  const exportHref = (table: string, extra?: Record<string, string>) => {
    const p = new URLSearchParams(query);
    p.set("table", table);
    for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
    return `/export/report?${p.toString()}`;
  };
  const summary = describeReportFilters(filters, context.projects, context.people);

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-gutter py-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <ReportFiltersBar filters={filters} projects={context.projects} people={context.people} />
        <div className="flex items-center gap-2">
          <ExportLink href={exportHref("breakdown")} />
          <PrintButton />
        </div>
      </div>
      <p className="text-sm text-zinc-600">
        {summary.length ? summary.join(" · ") : "Every task in every project you can open."} Overdue means incomplete and
        due before today in your time zone. Subtasks count through their top-level task’s projects when included.
      </p>
      <HiddenProjectsNote count={hidden} />

      <StatTiles counts={counts} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ReportCard id="report-status" title="Tasks by status">
          <BarsOrEmpty data={statusBars(counts)} caption="Tasks by status" />
        </ReportCard>
        <ReportCard id="report-project" title="Tasks by project">
          <BarsOrEmpty data={projectBars(byProject, context)} caption="Tasks by project" />
        </ReportCard>
        <ReportCard id="report-assignee" title="Tasks by assignee">
          <BarsOrEmpty data={assigneeBars(byAssignee, context)} caption="Tasks by assignee" />
        </ReportCard>
        <ReportCard id="report-section" title="Tasks by section">
          <BarsOrEmpty data={sections.bars} caption="Tasks by section" />
          {sections.more > 0 ? (
            <p className="mt-2 text-xs text-zinc-500">
              The {MAX_SECTION_BARS} largest sections are shown; {sections.more} more are in the CSV.
            </p>
          ) : null}
        </ReportCard>
        <ReportCard
          id="report-series"
          title={`Completed per ${interval}`}
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
            <p className="py-6 text-center text-sm text-zinc-500">No dates in range.</p>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            Local {interval === "week" ? "weeks (starting Sunday)" : "days"} in your time zone
            {filters.from || filters.to ? ", within the date range" : `; the last ${interval === "week" ? "12 weeks" : "30 days"} by default`}.
            Completed in the last {RECENT_DAYS} days: {counts.completedRecent}.
          </p>
        </ReportCard>
        <ReportCard
          id="report-overdue"
          title={`Overdue (${overdue.length}${overdue.length === 200 ? "+" : ""})`}
          wide
          actions={<ExportLink href={exportHref("overdue")} label="CSV" variant="ghost" />}
        >
          <OverdueTable rows={overdue} caption="Overdue tasks, oldest due date first" limit={OVERDUE_SHOWN} />
        </ReportCard>
      </div>
    </div>
  );
}
