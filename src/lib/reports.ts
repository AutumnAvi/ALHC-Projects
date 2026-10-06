// Workspace report vocabulary shared by server and client code. The report filter mirrors
// validate_report_filters() in supabase/migrations/20261006090000_reporting_export.sql; the database
// rejects anything else (check_violation), so the parser here drops invalid parts instead.

import type { Json } from "@/lib/supabase/database.types";
import { isIsoDate } from "@/lib/views";
import { isUuid } from "@/lib/ids";

export const REPORT_STATUSES = [
  { value: "all", label: "Any status" },
  { value: "open", label: "Open" },
  { value: "completed", label: "Completed" },
  { value: "overdue", label: "Overdue" },
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number]["value"];

export function isReportStatus(value: unknown): value is ReportStatus {
  return REPORT_STATUSES.some((s) => s.value === value);
}

// `projects` empty or absent = every project you can read; a listed project you can't read adds
// nothing (it never widens the set). `from`/`to` are local days: a task is in the range when its due
// date or completion day is. Subtasks count through their root task's projects and section.
export type ReportFilters = {
  projects?: string[];
  assignees?: (string | null)[];
  from?: string;
  to?: string;
  status?: ReportStatus;
  include_subtasks?: boolean;
};

export type SeriesInterval = "day" | "week";
export const isSeriesInterval = (value: unknown): value is SeriesInterval => value === "day" || value === "week";

export const MAX_FILTER_ITEMS = 100;

export function parseReportFilters(value: unknown): ReportFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: ReportFilters = {};
  if (Array.isArray(raw.projects)) {
    const projects = [...new Set(raw.projects.filter(isUuid).map((p) => p.toLowerCase()))].slice(0, MAX_FILTER_ITEMS);
    if (projects.length) out.projects = projects;
  }
  if (Array.isArray(raw.assignees)) {
    const assignees = raw.assignees
      .filter((a): a is string | null => a === null || a === "me" || isUuid(a))
      .map((a) => (typeof a === "string" ? a.toLowerCase() : a));
    const unique = [...new Set(assignees)].slice(0, MAX_FILTER_ITEMS);
    if (unique.length) out.assignees = unique;
  }
  if (isIsoDate(raw.from)) out.from = raw.from;
  if (isIsoDate(raw.to)) out.to = raw.to;
  if (out.from && out.to && out.from > out.to) delete out.from;
  if (isReportStatus(raw.status) && raw.status !== "all") out.status = raw.status;
  if (raw.include_subtasks === true) out.include_subtasks = true;
  return out;
}

export function reportFiltersJson(filters: ReportFilters): Json {
  return JSON.parse(JSON.stringify(parseReportFilters(filters))) as Json;
}

// URL state for /reports (and the export links that reproduce it):
//   p=<id>,<id>   projects      a=<id|me|none>,…  assignees      from / to = YYYY-MM-DD
//   status=open|completed|overdue                  sub=1 = include subtasks
type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function param(params: Params, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

export function filtersFromParams(params: Params): ReportFilters {
  const list = (key: string) =>
    (param(params, key) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return parseReportFilters({
    projects: list("p"),
    assignees: list("a").map((a) => (a === "none" ? null : a)),
    from: param(params, "from"),
    to: param(params, "to"),
    status: param(params, "status"),
    include_subtasks: param(params, "sub") === "1",
  });
}

export function filtersToParams(filters: ReportFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.projects?.length) params.set("p", filters.projects.join(","));
  if (filters.assignees?.length) params.set("a", filters.assignees.map((a) => a ?? "none").join(","));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  if (filters.include_subtasks) params.set("sub", "1");
  return params;
}

export function hasReportFilters(filters: ReportFilters) {
  return Object.keys(parseReportFilters(filters)).length > 0;
}

// Personal dashboard widgets (personal_dashboard_widgets.kind; mirrors the CHECK).
export const PERSONAL_WIDGET_KINDS = [
  { value: "count", label: "Number" },
  { value: "by_section", label: "Bar chart by section" },
  { value: "by_assignee", label: "Bar chart by assignee" },
  { value: "by_project", label: "Bar chart by project" },
  { value: "completed_series", label: "Completed over time" },
  { value: "overdue_list", label: "Overdue list" },
] as const;
export type PersonalWidgetKind = (typeof PERSONAL_WIDGET_KINDS)[number]["value"];

export function isPersonalWidgetKind(value: unknown): value is PersonalWidgetKind {
  return PERSONAL_WIDGET_KINDS.some((k) => k.value === value);
}

export type PersonalDashboard = { id: string; name: string; sortOrder: number; createdAt: string };

export type PersonalWidget = {
  id: string;
  dashboardId: string;
  kind: PersonalWidgetKind;
  title: string;
  filters: ReportFilters;
  interval: SeriesInterval;
  sortOrder: number;
};

export const DEFAULT_WIDGET_TITLES: Record<PersonalWidgetKind, string> = {
  count: "Open tasks",
  by_section: "Tasks by section",
  by_assignee: "Tasks by assignee",
  by_project: "Tasks by project",
  completed_series: "Completed per week",
  overdue_list: "Overdue tasks",
};

// Bucket labels for the completed-over-time series.
export function seriesLabel(bucketStart: string, interval: SeriesInterval): string {
  const [y, m, d] = bucketStart.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return interval === "week" ? `Week of ${label}` : label;
}

// Plain-language summary of a filter (shown in print and on widgets).
export function describeReportFilters(
  filters: ReportFilters,
  projects: { id: string; name: string }[],
  people: { id: string; name: string }[],
): string[] {
  const parts: string[] = [];
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const peopleNames = new Map(people.map((p) => [p.id, p.name]));
  if (filters.projects?.length) {
    const names = filters.projects.map((id) => projectNames.get(id)).filter(Boolean);
    const hidden = filters.projects.length - names.length;
    parts.push(`Projects: ${[...names, ...(hidden ? [`${hidden} you can’t open`] : [])].join(", ")}`);
  }
  if (filters.assignees?.length) {
    parts.push(
      `Assignees: ${filters.assignees
        .map((a) => (a === null ? "Unassigned" : a === "me" ? "Me" : (peopleNames.get(a) ?? "Former member")))
        .join(", ")}`,
    );
  }
  if (filters.from || filters.to) parts.push(`Due or completed ${filters.from ?? "…"} – ${filters.to ?? "…"}`);
  if (filters.status) parts.push(`Status: ${REPORT_STATUSES.find((s) => s.value === filters.status)?.label}`);
  if (filters.include_subtasks) parts.push("Subtasks included");
  return parts;
}
