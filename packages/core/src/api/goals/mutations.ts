// Big move 1: the goals area's writes (goals, their links, and status updates). Every function takes the
// caller's ApiContext first, validates its own input, writes only through ctx.db (RLS decides who edits a
// goal: its owner, a lead of its team, or a workspace admin), and throws ApiError on any refusal; no
// Next.js here.
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { ApiError, invalid } from "../core/errors";
import { id, optionalId, optionalIsoDate, optionalText, text } from "../core/validate";
import type { GoalInput, GoalLinkTarget, GoalPatch } from "./model";
import { getWorkspace } from "../workspace/queries";
import { isGoalStatus, isProgressMode } from "../../goals";
import type { TablesInsert, TablesUpdate } from "../../supabase/database.types";

const GOAL_NOT_ALLOWED = "Only the goal’s owner, a lead of its team, or a workspace admin can change it";

function goalPeriod(start: unknown, end: unknown) {
  const periodStart = optionalIsoDate(start, "Start date");
  const periodEnd = optionalIsoDate(end, "End date");
  if (periodStart && periodEnd && periodStart > periodEnd) throw invalid("The period must start before it ends");
  return { period_start: periodStart, period_end: periodEnd };
}

// Answers the new goal's id.
// AI builder round 5: `opts.workspaceId` = the Testing data pilot workspace.
export async function createGoal(ctx: ApiContext, input: GoalInput, opts: { workspaceId?: string | null } = {}): Promise<string> {
  const workspace = opts.workspaceId ? { id: id(opts.workspaceId, "workspace") } : await getWorkspace(ctx);
  if (!workspace) throw new ApiError("failed", "No workspace is available");
  const mode = input.progressMode ?? "manual";
  if (!isProgressMode(mode)) throw invalid("Choose how progress is measured");
  const supabase = ctx.db;
  const owner = optionalId(input.ownerId, "owner");
  const inserted = await supabase
    .from("goals")
    .insert({
      workspace_id: workspace.id,
      title: text(input.title, "Goal title", { max: 200 }),
      parent_id: optionalId(input.parentId, "parent goal"),
      team_id: optionalId(input.teamId, "team"),
      ...(owner ? { owner_id: owner } : {}),
      ...goalPeriod(input.periodStart, input.periodEnd),
      progress_mode: mode,
    })
    .select("id")
    .single();
  check(inserted, "You can only create goals you own, goals for a team you lead, or any goal as a workspace admin");
  return inserted.data!.id;
}

export async function updateGoal(ctx: ApiContext, goalId: string, patch: GoalPatch): Promise<void> {
  const update: TablesUpdate<"goals"> = {};
  if (patch.title !== undefined) update.title = text(patch.title, "Goal title", { max: 200 });
  if (patch.notes !== undefined) update.notes = optionalText(patch.notes, 10000);
  if (patch.parentId !== undefined) update.parent_id = optionalId(patch.parentId, "parent goal");
  if (patch.teamId !== undefined) update.team_id = optionalId(patch.teamId, "team");
  if (patch.ownerId !== undefined) update.owner_id = optionalId(patch.ownerId, "owner");
  if (patch.periodStart !== undefined || patch.periodEnd !== undefined) {
    const period = goalPeriod(patch.periodStart, patch.periodEnd);
    if (patch.periodStart !== undefined) update.period_start = period.period_start;
    if (patch.periodEnd !== undefined) update.period_end = period.period_end;
  }
  if (patch.progressMode !== undefined) {
    if (!isProgressMode(patch.progressMode)) throw invalid("Choose how progress is measured");
    update.progress_mode = patch.progressMode;
  }
  if (patch.manualProgress !== undefined) {
    const value = Math.round(Number(patch.manualProgress));
    if (!Number.isFinite(value) || value < 0 || value > 100) throw invalid("Progress is a number from 0 to 100");
    update.manual_progress = value;
  }
  const supabase = ctx.db;
  checkUpdated(await supabase.from("goals").update(update).eq("id", id(goalId)).select("id"), GOAL_NOT_ALLOWED);
}

export async function deleteGoal(ctx: ApiContext, goalId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("goals").update({ deleted_at: nowIso() }).eq("id", id(goalId)).select("id"),
    GOAL_NOT_ALLOWED,
  );
}

export async function linkGoal(ctx: ApiContext, goalId: string, target: GoalLinkTarget): Promise<void> {
  const supabase = ctx.db;
  const row: TablesInsert<"goal_links"> =
    "projectId" in target
      ? { goal_id: id(goalId), project_id: id(target.projectId, "project") }
      : { goal_id: id(goalId), portfolio_id: id(target.portfolioId, "portfolio") };
  const result = await supabase.from("goal_links").insert(row);
  if (result.error?.code === "23505") throw invalid("That’s already linked to this goal");
  check(result, "You can link only goals you can edit, and only projects or portfolios you can open");
}

export async function unlinkGoal(ctx: ApiContext, linkId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("goal_links").update({ deleted_at: nowIso() }).eq("id", id(linkId)).select("id"),
    GOAL_NOT_ALLOWED,
  );
}

// Posting an update also sets the goal's status (trigger).
export async function postGoalStatusUpdate(
  ctx: ApiContext,
  goalId: string,
  status: string,
  body: string | null,
): Promise<void> {
  if (!isGoalStatus(status)) throw invalid("Choose a status");
  const supabase = ctx.db;
  check(
    await supabase.from("goal_status_updates").insert({ goal_id: id(goalId), status, body: optionalText(body, 5000) }),
    GOAL_NOT_ALLOWED,
  );
}

export async function deleteGoalStatusUpdate(ctx: ApiContext, updateId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("goal_status_updates").update({ deleted_at: nowIso() }).eq("id", id(updateId)).select("id"),
    "Only the author can delete a status update",
  );
}
