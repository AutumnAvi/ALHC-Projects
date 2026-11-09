// Big move 1: the teams area's writes (teams, their members and join requests, curated work, and the
// group invite into a project). Every function takes the caller's ApiContext first, validates its own
// input, writes only through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no
// Next.js here.
import { ORDER_STEP } from "../core/constants";
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { ApiError, NEEDS_DATABASE_UPDATE, invalid } from "../core/errors";
import { email, id, optionalText, text } from "../core/validate";
import { inviteByEmail, type InviteOutcome } from "../members/invite";
import { DEFAULT_ROLES_MISSING } from "../members/model";
import { getWorkspace } from "../workspace/queries";
import { PERSON_DEFAULT_ROLE } from "../../roles";
import { isTeamProjectRole, isTeamRole, parseTeamInviteResult, type TeamInviteResult } from "../../teams";

const TEAM_NOT_ALLOWED = "Only the team’s leads and workspace admins can change it";

function teamRole(value: unknown): string {
  if (!isTeamRole(value)) throw invalid("Choose lead or member");
  return value;
}

// ---------------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------------

// A new team (the creator becomes its first lead). Answers the new team's id.
// AI builder round 5: `opts.workspaceId` = the Testing data pilot workspace.
export async function createTeam(ctx: ApiContext, input: { name: unknown; description: unknown }, opts: { workspaceId?: string | null } = {}): Promise<string> {
  const name = text(input.name, "Team name", { max: 100 });
  const workspace = opts.workspaceId ? { id: id(opts.workspaceId, "workspace") } : await getWorkspace(ctx);
  if (!workspace) throw new ApiError("failed", "No workspace is available");
  const supabase = ctx.db;
  const inserted = await supabase
    .from("teams")
    .insert({ workspace_id: workspace.id, name, description: optionalText(input.description, 2000) })
    .select("id")
    .single();
  check(inserted, TEAM_NOT_ALLOWED);
  return inserted.data!.id;
}

// ---------------------------------------------------------------------------------------------
// Team curated work (Asana parity, batch 5): the team Overview's pinned projects and portfolios.
// Team members, leads, and workspace admins curate (can_curate_team); only work the person can open
// can be pinned, and each item shows only to people who can open it (RLS).
// ---------------------------------------------------------------------------------------------

const CURATE_NOT_ALLOWED = "Only people on this team (and workspace admins) can change its curated work";

export async function addTeamCuratedWork(
  ctx: ApiContext,
  teamId: string,
  target: { projectId: string } | { portfolioId: string },
): Promise<void> {
  const team = id(teamId, "team");
  const supabase = ctx.db;
  const last = await supabase
    .from("team_curated_work")
    .select("sort_order")
    .eq("team_id", team)
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last.error && ["PGRST205", "42P01"].includes(last.error.code ?? "")) throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  check(last);
  const result = await supabase.from("team_curated_work").insert({
    team_id: team,
    ...("projectId" in target ? { project_id: id(target.projectId, "project") } : { portfolio_id: id(target.portfolioId, "portfolio") }),
    sort_order: (last.data?.sort_order ?? 0) + ORDER_STEP,
  });
  // Already curated: nothing to do.
  if (result.error?.code === "23505") return;
  check(result, CURATE_NOT_ALLOWED);
}

export async function removeTeamCuratedWork(ctx: ApiContext, itemId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("team_curated_work").update({ deleted_at: nowIso() }).eq("id", id(itemId)).is("deleted_at", null).select("id"),
    CURATE_NOT_ALLOWED,
  );
}

// Reorder: the app sends a midpoint between the visible neighbours (hidden items keep their places).
export async function moveTeamCuratedWork(ctx: ApiContext, itemId: string, sortOrder: number): Promise<void> {
  if (!Number.isFinite(sortOrder)) throw invalid("Invalid position");
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("team_curated_work").update({ sort_order: sortOrder }).eq("id", id(itemId)).select("id"),
    CURATE_NOT_ALLOWED,
  );
}

export async function updateTeam(
  ctx: ApiContext,
  teamId: string,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  const update: { name?: string; description?: string | null } = {};
  if (patch.name !== undefined) update.name = text(patch.name, "Team name", { max: 100 });
  if (patch.description !== undefined) update.description = optionalText(patch.description, 2000);
  const supabase = ctx.db;
  checkUpdated(await supabase.from("teams").update(update).eq("id", id(teamId)).select("id"), TEAM_NOT_ALLOWED);
}

export async function deleteTeam(ctx: ApiContext, teamId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("teams").update({ deleted_at: nowIso() }).eq("id", id(teamId)).select("id"),
    TEAM_NOT_ALLOWED,
  );
}

// ---------------------------------------------------------------------------------------------
// Team members and join requests
// ---------------------------------------------------------------------------------------------

// Adds someone by email (add_team_member). `emailConfigured`: whether this deployment can send email
// (the caller's to know).
export async function addTeamMember(
  ctx: ApiContext,
  teamId: string,
  address: string,
  memberRole: string,
  options: { emailConfigured: boolean },
): Promise<InviteOutcome> {
  const team = id(teamId);
  const memberEmail = email(address);
  const memberRoleValue = teamRole(memberRole);
  return inviteByEmail(
    ctx,
    memberEmail,
    { column: "team_id", id: team },
    (supabase) => supabase.rpc("add_team_member", { target_team: team, member_email: memberEmail, member_role: memberRoleValue }),
    { notAllowed: TEAM_NOT_ALLOWED, emailConfigured: options.emailConfigured },
  );
}

export async function changeTeamMemberRole(ctx: ApiContext, teamId: string, profileId: string, memberRole: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("update_team_member_role", {
      target_team: id(teamId),
      target_profile: id(profileId, "person"),
      new_role: teamRole(memberRole),
    }),
    TEAM_NOT_ALLOWED,
  );
}

// Removes someone (leads and workspace admins), or the caller themselves (leave).
export async function removeTeamMember(ctx: ApiContext, teamId: string, profileId: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("remove_team_member", { target_team: id(teamId), target_profile: id(profileId, "person") }),
    TEAM_NOT_ALLOWED,
  );
}

// Oct 26 notes (batch 4): "You're not part of this team" → Join team (the workspace's default team:
// joined at once, status "member") or Request to join (every other team: "requested"). The database
// decides; its rate limits come back as the message.
export async function requestTeamJoin(ctx: ApiContext, teamId: string): Promise<{ status?: string }> {
  const supabase = ctx.db;
  const { data, error } = await supabase.rpc("request_team_join", { target_team: id(teamId, "team") });
  if (error?.code === "PGRST202") throw invalid("Joining a team needs this release’s database update");
  if (error?.code === "P0002") throw invalid("This team doesn’t exist any more");
  check({ error });
  return { status: typeof data === "string" ? data : undefined };
}

// A team's leads and workspace admins add someone who asked (as a member or a lead) or decline.
export async function decideTeamJoinRequest(
  ctx: ApiContext,
  requestId: string,
  decision: "approve" | "decline",
  memberRole: string = "member",
): Promise<{ status?: string }> {
  if (decision !== "approve" && decision !== "decline") throw invalid("Add or decline the request");
  const role = teamRole(memberRole);
  const supabase = ctx.db;
  const { data, error } = await supabase.rpc("decide_team_join_request", {
    target_request: id(requestId, "request"),
    decision,
    member_role: role,
  });
  if (error?.code === "P0002") throw invalid("This request isn’t there any more, or you can’t decide it");
  check({ error }, TEAM_NOT_ALLOWED);
  return { status: typeof data === "string" ? data : undefined };
}

// ---------------------------------------------------------------------------------------------
// Group invite
// ---------------------------------------------------------------------------------------------

// Group invite: every team member who isn't in the project yet joins it with one role, as ordinary
// project members. People already in the project keep their role; anyone who can't be added is
// skipped with a reason.
export async function addTeamToProject(
  ctx: ApiContext,
  projectId: string,
  teamId: string,
  memberRole: string,
): Promise<{ result: TeamInviteResult }> {
  if (!isTeamProjectRole(memberRole) && memberRole !== PERSON_DEFAULT_ROLE) {
    throw invalid("Choose admin, editor, commenter, viewer, or each person’s default");
  }
  const supabase = ctx.db;
  const response = await supabase.rpc("add_team_to_project", {
    target_project: id(projectId),
    target_team: id(teamId, "team"),
    member_role: memberRole,
  });
  if (memberRole === PERSON_DEFAULT_ROLE && response.error?.code === "23514" && /Choose admin/.test(response.error.message)) {
    throw invalid(DEFAULT_ROLES_MISSING);
  }
  check(response);
  return { result: parseTeamInviteResult(response.data) };
}
