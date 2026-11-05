// Big move 1: the views area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getViewer } from "../auth/queries";
import { type ApiContext, read } from "../core/context";
import { maybe, rows } from "../core/db";
import type { MetricBucket } from "./model";
import { type ColumnWidths, parseColumnWidths } from "../../column-widths";
import { isUuid } from "../../ids";
import { toProjectView } from "../../row-mappers";
import {
  type DashboardWidget,
  isFixedTab,
  isWidgetKind,
  NO_VIEW_SETTINGS,
  parseFilters,
  parseViewConfig,
  type ProjectView,
  type ProjectViewSettings,
  toJson,
  type ViewConfig,
  type ViewFilters,
} from "../../views";

// ---------------------------------------------------------------------------------------------
// Views & Insights: saved views, filtering, dashboard widgets + metrics
// ---------------------------------------------------------------------------------------------


export const listProjectViews = read(async (ctx: ApiContext, projectId: string): Promise<ProjectView[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("project_views")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "views").map(toProjectView);
});

export const getProjectView = read(async (ctx: ApiContext, viewId: string): Promise<ProjectView | null> => {
  const supabase = ctx.db;
  const row = maybe(
    await supabase.from("project_views").select("*").eq("id", viewId).is("deleted_at", null).maybeSingle(),
    "view",
  );
  return row ? toProjectView(row) : null;
});

// The project's hidden tabs and default view (project Viewers+ read it; nothing set = everything shown).
export const getProjectViewSettings = read(async (ctx: ApiContext, projectId: string): Promise<ProjectViewSettings> => {
  const supabase = ctx.db;
  // Nov 2 notes (batch 15, 117): hidden view tabs; a database without the update has no such column.
  const withViews = await supabase
    .from("project_view_settings")
    .select("default_view_id, hidden_tabs, hidden_view_ids")
    .eq("project_id", projectId)
    .maybeSingle();
  if (!withViews.error) {
    const row = withViews.data;
    if (!row) return NO_VIEW_SETTINGS;
    return {
      defaultViewId: row.default_view_id,
      hiddenTabs: (row.hidden_tabs ?? []).filter(isFixedTab),
      hiddenViewIds: row.hidden_view_ids ?? [],
    };
  }
  const row = maybe(
    await supabase
      .from("project_view_settings")
      .select("default_view_id, hidden_tabs")
      .eq("project_id", projectId)
      .maybeSingle(),
    "tab settings",
  );
  if (!row) return NO_VIEW_SETTINGS;
  return { defaultViewId: row.default_view_id, hiddenTabs: (row.hidden_tabs ?? []).filter(isFixedTab), hiddenViewIds: [] };
});

// Ids of the project's tasks that match a view filter, evaluated by filter_project_tasks() under RLS.
export async function filterProjectTaskIds(
  ctx: ApiContext, projectId: string,
  filters: ViewFilters,
  timeZone: string,
): Promise<Set<string>> {
  const supabase = ctx.db;
  const result = await supabase.rpc("filter_project_tasks", {
    target_project: projectId,
    filters: toJson(filters),
    tz: timeZone,
  });
  return new Set(rows(result, "filtered tasks").map((r) => r.task_id));
}

export const listDashboardWidgets = read(async (ctx: ApiContext, projectId: string): Promise<DashboardWidget[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("dashboard_widgets")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "dashboard widgets").flatMap((row) =>
    isWidgetKind(row.kind)
      ? [
          {
            id: row.id,
            projectId: row.project_id,
            kind: row.kind,
            title: row.title,
            filters: parseFilters(row.filters),
            sortOrder: row.sort_order,
          },
        ]
      : [],
  );
});

export async function projectMetrics(
  ctx: ApiContext, projectId: string,
  filters: ViewFilters,
  groupBy: "none" | "section" | "assignee",
  timeZone: string,
): Promise<MetricBucket[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("project_metrics", {
    target_project: projectId,
    filters: toJson(filters),
    group_by: groupBy,
    tz: timeZone,
  });
  return rows(result, "metrics").map((r) => ({ bucket: r.bucket, count: Number(r.task_count) }));
}

// The viewer's own List column widths for a project (list_column_widths, own rows only by RLS).
export const getListColumnWidths = read(async (ctx: ApiContext, projectId: string): Promise<ColumnWidths> => {
  if (!isUuid(projectId)) return {};
  const supabase = ctx.db;
  const { data } = await supabase.from("list_column_widths").select("widths").eq("project_id", projectId).maybeSingle();
  return parseColumnWidths(data?.widths);
});

// Oct 26 notes (batch 4): the List groups (sections, assignees, …) the viewer collapsed in a project, kept
// per person (list_collapsed_groups, own rows). Empty on a database without this release.
export const getListCollapsedGroups = read(async (ctx: ApiContext, projectId: string): Promise<string[]> => {
  if (!isUuid(projectId)) return [];
  const supabase = ctx.db;
  const { data, error } = await supabase
    .from("list_collapsed_groups")
    .select("group_keys")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) return [];
  return (data?.group_keys ?? []).filter((key): key is string => typeof key === "string");
});

// Nov 2 notes (batch 14, 94): the viewer's own version of a shared view ("Save for me"), or null. A
// database without this release has no table: null (everyone sees the view as saved).
export const getViewPersonalConfig = read(async (ctx: ApiContext, viewId: string): Promise<ViewConfig | null> => {
  if (!isUuid(viewId)) return null;
  const supabase = ctx.db;
  const { user } = await getViewer(ctx);
  if (!user) return null;
  const { data, error } = await supabase
    .from("project_view_personal_configs")
    .select("config")
    .eq("view_id", viewId)
    .eq("profile_id", user.id)
    .maybeSingle();
  if (error || !data?.config) return null;
  return parseViewConfig(data.config);
});

export const getProjectShowCompleted = read(async (ctx: ApiContext, projectId: string): Promise<boolean | null> => {
  if (!isUuid(projectId)) return null;
  const supabase = ctx.db;
  const { user } = await getViewer(ctx);
  if (!user) return null;
  const { data, error } = await supabase
    .from("project_person_settings")
    .select("show_completed")
    .eq("project_id", projectId)
    .eq("profile_id", user.id)
    .maybeSingle();
  if (error) return null;
  return data?.show_completed ?? null;
});
