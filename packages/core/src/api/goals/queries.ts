// Big move 1: the goals area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getViewer } from "../auth/queries";
import { type ApiContext, read } from "../core/context";
import { isMissingColumn, maybe, rows } from "../core/db";
import { GOAL_COLUMNS, type GoalLink, type GoalStatusUpdate, toGoal } from "./model";
import { getWorkspace, isWorkspaceAdmin } from "../workspace/queries";
import { type Goal, type GoalProgress, type GoalViewer, isGoalStatus } from "../../goals";

// Nov 2 notes (batch 13, note 88): the workspace's Goals switch (Admin console → Organization; off by
// default). Off hides Goals from the sidebar, the Create menu, project and team Overviews, and the Goals
// pages say they're turned off; goals, links, and status updates are kept. Without this release's
// database goals stay on as before.
export const goalsEnabled = read(async (ctx: ApiContext): Promise<boolean> => {
  const workspace = await getWorkspace(ctx);
  if (!workspace) return false;
  const supabase = ctx.db;
  const { data, error } = await supabase.from("workspaces").select("goals_enabled").eq("id", workspace.id).maybeSingle();
  if (error) {
    if (isMissingColumn(error)) return true;
    throw new Error(`Failed to load the Goals setting: ${error.message}`);
  }
  return data?.goals_enabled ?? false;
});

export const listGoals = read(async (ctx: ApiContext): Promise<Goal[]> => {
  const supabase = ctx.db;
  const result = await supabase.from("goals").select(GOAL_COLUMNS).is("deleted_at", null).order("created_at");
  return rows(result, "goals").map(toGoal);
});

export const getGoal = read(async (ctx: ApiContext, goalId: string): Promise<Goal | null> => {
  const supabase = ctx.db;
  const result = await supabase.from("goals").select(GOAL_COLUMNS).eq("id", goalId).is("deleted_at", null).maybeSingle();
  const row = maybe(result, "goal");
  return row ? toGoal(row) : null;
});

export const listGoalProgress = read(async (ctx: ApiContext): Promise<Map<string, GoalProgress>> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("goal_progress", {});
  return new Map(
    rows(result, "goal progress").map((r) => [
      r.goal_id,
      {
        progress: r.progress === null ? null : Number(r.progress),
        taskCount: r.task_count === null ? null : Number(r.task_count),
        completedCount: r.completed_count === null ? null : Number(r.completed_count),
        hiddenProjects: Number(r.hidden_project_count ?? 0),
        subGoalCount: Number(r.sub_goal_count ?? 0),
      },
    ]),
  );
});

// What the viewer needs to know to show edit controls (the database decides for real).
export const getGoalViewer = read(async (ctx: ApiContext): Promise<GoalViewer> => {
  const { user } = await getViewer(ctx);
  if (!user) return { id: "", isWorkspaceAdmin: false, leadTeamIds: [] };
  const supabase = ctx.db;
  const [admin, leads] = await Promise.all([
    isWorkspaceAdmin(ctx),
    supabase.from("team_members").select("team_id").eq("profile_id", user.id).eq("role", "lead").is("deleted_at", null),
  ]);
  return {
    id: user.id,
    isWorkspaceAdmin: admin,
    leadTeamIds: rows(leads, "team leads").map((r) => r.team_id),
  };
});

// Links the viewer can see (RLS hides links to projects and portfolios they can't open).
export const listGoalLinks = read(async (ctx: ApiContext, goalId: string): Promise<GoalLink[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("goal_links")
    .select(
      "id, project_id, portfolio_id, project:projects!goal_links_project_id_fkey(id, name, status, status_updated_at, deleted_at), portfolio:portfolios!goal_links_portfolio_id_fkey(id, name, deleted_at)",
    )
    .eq("goal_id", goalId)
    .is("deleted_at", null)
    .order("created_at");
  return rows(result, "goal links").flatMap((r): GoalLink[] => {
    if (r.project && r.project.deleted_at === null) {
      return [
        {
          id: r.id,
          kind: "project",
          targetId: r.project.id,
          name: r.project.name,
          status: r.project.status,
          statusSet: r.project.status_updated_at !== null,
        },
      ];
    }
    if (r.portfolio && r.portfolio.deleted_at === null) {
      return [{ id: r.id, kind: "portfolio", targetId: r.portfolio.id, name: r.portfolio.name, status: null, statusSet: false }];
    }
    return [];
  });
});

export const listGoalStatusUpdates = read(async (ctx: ApiContext, goalId: string): Promise<GoalStatusUpdate[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("goal_status_updates")
    .select("id, status, body, author_id, created_at, author:profiles!goal_status_updates_author_id_fkey(email, full_name)")
    .eq("goal_id", goalId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  return rows(result, "status updates").map((r) => ({
    id: r.id,
    status: isGoalStatus(r.status) ? r.status : "on_track",
    body: r.body,
    authorId: r.author_id,
    authorName: r.author?.full_name?.trim() || r.author?.email || "Someone",
    createdAt: r.created_at,
  }));
});
