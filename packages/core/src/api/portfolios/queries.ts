// Big move 1: the portfolios area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "../core/context";
import { isMissingColumn, maybe, rows } from "../core/db";
import type {
  Portfolio,
  PortfolioChild,
  PortfolioField,
  PortfolioMember,
  PortfolioMilestone,
  PortfolioProject,
  PortfolioReportRow,
  PortfolioTimelineRow,
  RollupProject,
} from "./model";
import { PROJECT_COLUMNS } from "../projects/model";
import { parseOptions } from "../../fields";
import { isPortfolioFieldType } from "../../portfolios";
import { isPortfolioRole, type PortfolioRole } from "../../roles";
import type { Json } from "../../supabase/database.types";

export const listPortfolios = read(async (ctx: ApiContext): Promise<Portfolio[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("portfolios")
    .select("id, name, notes, created_at")
    .is("deleted_at", null)
    .order("name")
    .order("created_at");
  return rows(result, "portfolios");
});

export const getPortfolio = read(async (ctx: ApiContext, portfolioId: string): Promise<Portfolio | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("portfolios")
    .select("id, name, notes, created_at")
    .eq("id", portfolioId)
    .is("deleted_at", null)
    .maybeSingle();
  return maybe(result, "portfolio");
});

// The viewer's role in a portfolio, or null when they are not a member.
export const getPortfolioRole = read(async (ctx: ApiContext, portfolioId: string): Promise<PortfolioRole | null> => {
  const supabase = ctx.db;
  const role = maybe(await supabase.rpc("portfolio_role", { target_portfolio: portfolioId }), "portfolio role");
  return isPortfolioRole(role) ? role : null;
});

export const listPortfolioMembers = read(async (ctx: ApiContext, portfolioId: string): Promise<PortfolioMember[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("portfolio_members")
    .select(
      "profile_id, role, created_at, profile:profiles!portfolio_members_profile_id_fkey!inner(email, full_name, avatar_url)",
    )
    .eq("portfolio_id", portfolioId)
    .is("deleted_at", null)
    .order("created_at");
  return rows(result, "portfolio members")
    .filter((m) => isPortfolioRole(m.role))
    .map((m) => ({
      profileId: m.profile_id,
      role: m.role as PortfolioRole,
      email: m.profile.email,
      fullName: m.profile.full_name,
      avatarUrl: m.profile.avatar_url,
      addedAt: m.created_at,
    }));
});

// Active projects of a portfolio that the viewer can read, in portfolio order.
export const listPortfolioProjects = read(async (ctx: ApiContext, portfolioId: string): Promise<PortfolioProject[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("portfolio_projects")
    .select(`sort_order, created_at, project:projects!portfolio_projects_project_id_fkey!inner(${PROJECT_COLUMNS})`)
    .eq("portfolio_id", portfolioId)
    .is("deleted_at", null)
    .is("project.deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "portfolio projects").map((row) => ({ ...row.project, portfolioSortOrder: row.sort_order }));
});

// How many of the portfolio's projects the viewer isn't a member of (left out of every number).
export const countHiddenPortfolioProjects = read(async (ctx: ApiContext, portfolioId: string): Promise<number> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("portfolio_hidden_project_count", { target_portfolio: portfolioId });
  return Number(maybe(result, "hidden projects") ?? 0);
});

export async function portfolioReport(
  ctx: ApiContext, portfolioId: string,
  groupBy: "none" | "project" | "assignee",
  timeZone: string,
): Promise<PortfolioReportRow[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("portfolio_report", {
    target_portfolio: portfolioId,
    group_by: groupBy,
    tz: timeZone,
  });
  return rows(result, "portfolio report").map((r) => ({
    bucket: r.bucket,
    total: Number(r.task_count),
    completed: Number(r.completed_count),
    incomplete: Number(r.incomplete_count),
    overdue: Number(r.overdue_count),
    completedRecent: Number(r.completed_recent_count),
  }));
}

// Progress for every portfolio the viewer can read (sidebar), keyed by portfolio id.
export const listPortfolioProgress = read(
  async (ctx: ApiContext): Promise<Map<string, { total: number; completed: number }>> => {
    const supabase = ctx.db;
    const result = await supabase.rpc("list_portfolio_progress");
    return new Map(
      rows(result, "portfolio progress").map((r) => [
        r.portfolio_id,
        { total: Number(r.task_count), completed: Number(r.completed_count) },
      ]),
    );
  },
);

// Nested portfolios the viewer can see, in order.
export const listPortfolioChildren = read(async (ctx: ApiContext, portfolioId: string): Promise<PortfolioChild[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("portfolio_children")
    .select("sort_order, created_at, child:portfolios!portfolio_children_child_id_fkey!inner(id, name)")
    .eq("parent_id", portfolioId)
    .is("deleted_at", null)
    .is("child.deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "nested portfolios").map((r) => ({ id: r.child.id, name: r.child.name, sortOrder: r.sort_order }));
});

// Every readable project of the portfolio and its visible nested portfolios, once each.
export const listPortfolioRollupProjects = read(async (ctx: ApiContext, portfolioId: string): Promise<RollupProject[]> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("portfolio_rollup_projects", { target_portfolio: portfolioId });
  return rows(result, "portfolio rollup").map((r) => ({
    id: r.project_id,
    name: r.name,
    status: r.status,
    statusNote: r.status_note,
    portfolioId: r.portfolio_id,
    groupId: r.group_id,
    sortOrder: r.sort_order,
  }));
});

export async function portfolioTimeline(ctx: ApiContext, portfolioId: string): Promise<PortfolioTimelineRow[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("portfolio_timeline", { target_portfolio: portfolioId });
  return rows(result, "portfolio timeline").map((r) => ({
    id: r.project_id,
    name: r.name,
    status: r.status,
    statusNote: r.status_note,
    portfolioId: r.portfolio_id,
    groupId: r.group_id,
    sortOrder: r.sort_order,
    startOn: r.start_on,
    dueOn: r.due_on,
    openTasks: Number(r.open_task_count),
  }));
}

// Open milestones of every readable project in the rollup (direct or nested), for the portfolio Timeline.
export async function listPortfolioMilestones(ctx: ApiContext, portfolioId: string): Promise<PortfolioMilestone[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("portfolio_milestones", { target_portfolio: portfolioId });
  return rows(result, "portfolio milestones").map((r) => ({
    projectId: r.project_id,
    taskId: r.task_id,
    title: r.title,
    dueOn: r.due_on,
  }));
}

export const listPortfolioFields = read(async (ctx: ApiContext, portfolioId: string): Promise<PortfolioField[]> => {
  const supabase = ctx.db;
  const toField = (f: { id: string; name: string; field_type: string; options: Json; sort_order: number; number_prefix?: string | null }) =>
    isPortfolioFieldType(f.field_type)
      ? [
          {
            id: f.id,
            name: f.name,
            fieldType: f.field_type,
            options: parseOptions(f.options),
            sortOrder: f.sort_order,
            numberPrefix: f.number_prefix ?? null,
          },
        ]
      : [];
  const result = await supabase
    .from("portfolio_fields")
    .select("id, name, field_type, options, sort_order, number_prefix")
    .eq("portfolio_id", portfolioId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  if (isMissingColumn(result.error)) {
    // Before 20261029010000_oct29_batch7_a.sql there is no symbol column.
    const older = await supabase
      .from("portfolio_fields")
      .select("id, name, field_type, options, sort_order")
      .eq("portfolio_id", portfolioId)
      .is("deleted_at", null)
      .order("sort_order")
      .order("created_at");
    return rows(older, "portfolio fields").flatMap(toField);
  }
  return rows(result, "portfolio fields").flatMap(toField);
});

// Values by project id, then field id. RLS leaves out projects the viewer can't read.
export const listPortfolioFieldValues = read(
  async (ctx: ApiContext, portfolioId: string): Promise<Record<string, Record<string, Json>>> => {
    const supabase = ctx.db;
    const result = await supabase
      .from("portfolio_field_values")
      .select("project_id, field_id, value")
      .eq("portfolio_id", portfolioId)
      .not("value", "is", null);
    const out: Record<string, Record<string, Json>> = {};
    for (const r of rows(result, "portfolio field values")) {
      if (r.value === null) continue;
      (out[r.project_id] ??= {})[r.field_id] = r.value;
    }
    return out;
  },
);
