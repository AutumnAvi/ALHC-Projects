// Big move 1: the reports area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "../core/context";
import { maybe, rows, rpcMissing } from "../core/db";
import type { AllProjectsRow, OverdueTask, ReportRow, SectionLabel, SeriesPoint } from "./model";
import { tagsEnabled } from "../tags/queries";
import { isReportKind, isScheduleFrequency, type ReportSchedule } from "../../email-schedules";
import { EMPTY_COUNTS, type PortfolioCounts } from "../../portfolios";
import {
  isPersonalWidgetKind,
  isSeriesInterval,
  parseReportFilters,
  type PersonalDashboard,
  type PersonalWidget,
  type ReportFilters,
  reportFiltersJson,
  type SeriesInterval,
  withoutReportTags,
} from "../../reports";

export async function workspaceReport(
  ctx: ApiContext, filters: ReportFilters,
  groupBy: "none" | "project" | "assignee" | "section",
  timeZone: string,
): Promise<ReportRow[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("workspace_report", {
    filters: reportFiltersJson(withoutReportTags(filters, await tagsEnabled(ctx))),
    group_by: groupBy,
    tz: timeZone,
  });
  return rows(result, "report").map((r) => ({
    bucket: r.bucket,
    projectId: r.project_id,
    total: Number(r.task_count),
    completed: Number(r.completed_count),
    incomplete: Number(r.incomplete_count),
    overdue: Number(r.overdue_count),
    completedRecent: Number(r.completed_recent_count),
  }));
}

export type ReportGroups = { none: ReportRow[]; project: ReportRow[]; assignee: ReportRow[]; section: ReportRow[] };

type ReportRowJson = {
  bucket: string | null;
  project_id: string | null;
  task_count: number | string;
  completed_count: number | string;
  incomplete_count: number | string;
  overdue_count: number | string;
  completed_recent_count: number | string;
};

function toReportRow(r: ReportRowJson): ReportRow {
  return {
    bucket: r.bucket,
    projectId: r.project_id,
    total: Number(r.task_count),
    completed: Number(r.completed_count),
    incomplete: Number(r.incomplete_count),
    overdue: Number(r.overdue_count),
    completedRecent: Number(r.completed_recent_count),
  };
}

// Nov 12 notes (batch 40, item 3): Reports → Overview's four groupings from one scan
// (workspace_report_groups: workspace_report's rules, one jsonb value). Before that function is
// deployed, the four workspace_report calls.
export async function workspaceReportGroups(ctx: ApiContext, filters: ReportFilters, timeZone: string): Promise<ReportGroups> {
  const json = reportFiltersJson(withoutReportTags(filters, await tagsEnabled(ctx)));
  const result = await ctx.db.rpc("workspace_report_groups", { filters: json, tz: timeZone });
  if (!rpcMissing(result.error)) {
    const value = (maybe(result, "report") ?? {}) as Partial<Record<keyof ReportGroups, ReportRowJson[]>>;
    const list = (key: keyof ReportGroups) => (Array.isArray(value[key]) ? value[key] : []).map(toReportRow);
    return { none: list("none"), project: list("project"), assignee: list("assignee"), section: list("section") };
  }
  const [none, project, assignee, section] = await Promise.all([
    workspaceReport(ctx, filters, "none", timeZone),
    workspaceReport(ctx, filters, "project", timeZone),
    workspaceReport(ctx, filters, "assignee", timeZone),
    workspaceReport(ctx, filters, "section", timeZone),
  ]);
  return { none, project, assignee, section };
}

export async function workspaceTotals(ctx: ApiContext, filters: ReportFilters, timeZone: string): Promise<PortfolioCounts> {
  const [row] = await workspaceReport(ctx, filters, "none", timeZone);
  return row ?? EMPTY_COUNTS;
}

export async function reportCompletedSeries(
  ctx: ApiContext, filters: ReportFilters,
  interval: SeriesInterval,
  timeZone: string,
): Promise<SeriesPoint[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("report_completed_series", {
    filters: reportFiltersJson(withoutReportTags(filters, await tagsEnabled(ctx))),
    bucket_interval: interval,
    tz: timeZone,
  });
  return rows(result, "completed series").map((r) => ({ start: r.bucket_start, count: Number(r.completed_count) }));
}

export async function reportOverdueTasks(ctx: ApiContext, filters: ReportFilters, timeZone: string, max = 200): Promise<OverdueTask[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("report_overdue_tasks", {
    filters: reportFiltersJson(withoutReportTags(filters, await tagsEnabled(ctx))),
    tz: timeZone,
    max_results: max,
  });
  return rows(result, "overdue tasks").map((r) => ({
    taskId: r.task_id,
    title: r.title,
    projectId: r.project_id,
    assigneeId: r.assignee_id,
    dueOn: r.due_on,
    daysOverdue: Number(r.days_overdue),
    parentTaskId: r.parent_task_id,
  }));
}

export async function allProjectsReport(ctx: ApiContext, timeZone: string): Promise<AllProjectsRow[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("all_projects_report", { tz: timeZone });
  return rows(result, "all-projects report").map((r) => ({
    id: r.project_id,
    name: r.name,
    status: r.status,
    statusNote: r.status_note,
    counts: {
      total: Number(r.task_count),
      completed: Number(r.completed_count),
      incomplete: Number(r.incomplete_count),
      overdue: Number(r.overdue_count),
      completedRecent: Number(r.completed_recent_count),
    },
  }));
}

// How many active projects the viewer can't read (a number only; never names or ids).
export const countHiddenWorkspaceProjects = read(async (ctx: ApiContext): Promise<number> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("workspace_hidden_project_count");
  return Number(maybe(result, "hidden projects") ?? 0);
});

// Names of sections (by id) the viewer can read, for report labels.
export async function listSectionLabels(ctx: ApiContext, ids: string[]): Promise<Map<string, SectionLabel>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const supabase = ctx.db;
  const result = await supabase.from("sections").select("id, name, project_id").in("id", unique);
  return new Map(rows(result, "sections").map((s) => [s.id, { id: s.id, name: s.name, projectId: s.project_id }]));
}

export const listPersonalDashboards = read(async (ctx: ApiContext): Promise<PersonalDashboard[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("personal_dashboards")
    .select("id, name, sort_order, created_at")
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "dashboards").map((d) => ({
    id: d.id,
    name: d.name,
    sortOrder: d.sort_order,
    createdAt: d.created_at,
  }));
});

export const getPersonalDashboard = read(async (ctx: ApiContext, dashboardId: string): Promise<PersonalDashboard | null> => {
  const supabase = ctx.db;
  const row = maybe(
    await supabase
      .from("personal_dashboards")
      .select("id, name, sort_order, created_at")
      .eq("id", dashboardId)
      .is("deleted_at", null)
      .maybeSingle(),
    "dashboard",
  );
  return row ? { id: row.id, name: row.name, sortOrder: row.sort_order, createdAt: row.created_at } : null;
});

export const listPersonalWidgets = read(async (ctx: ApiContext, dashboardId: string): Promise<PersonalWidget[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("personal_dashboard_widgets")
    .select("*")
    .eq("dashboard_id", dashboardId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "dashboard widgets").flatMap((w) =>
    isPersonalWidgetKind(w.kind)
      ? [
          {
            id: w.id,
            dashboardId: w.dashboard_id,
            kind: w.kind,
            title: w.title,
            filters: parseReportFilters(w.filters),
            interval: isSeriesInterval(w.series_interval) ? w.series_interval : "week",
            sortOrder: w.sort_order,
          },
        ]
      : [],
  );
});

// The viewer's own scheduled report emails (owner-only RLS), newest first; removed ones left out. Null on
// a database without the migration.
export const listReportSchedules = read(async (ctx: ApiContext): Promise<ReportSchedule[] | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("report_schedules")
    .select(
      "id, name, report, filters, frequency, weekday, month_day, send_hour, time_zone, recipients, paused_at, next_run_at, last_run_at, last_sent_at, last_sent_count, created_at",
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  return rows(result, "scheduled report emails").map((r) => ({
    id: r.id,
    name: r.name,
    report: isReportKind(r.report) ? r.report : "overview",
    filters: parseReportFilters(r.filters),
    frequency: isScheduleFrequency(r.frequency) ? r.frequency : "weekly",
    weekday: r.weekday,
    monthDay: r.month_day,
    hour: r.send_hour,
    timeZone: r.time_zone,
    recipients: r.recipients,
    pausedAt: r.paused_at,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastSentAt: r.last_sent_at,
    lastSentCount: r.last_sent_count,
    createdAt: r.created_at,
  }));
});
