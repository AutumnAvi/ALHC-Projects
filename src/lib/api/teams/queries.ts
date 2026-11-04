// Big move 1: the teams area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getViewer } from "@/lib/api/auth/queries";
import { type ApiContext, read } from "@/lib/api/core/context";
import { maybe, rows } from "@/lib/api/core/db";
import { visibleTaskNumbers } from "@/lib/api/numbers/queries";
import { browseProjects } from "@/lib/api/projects/queries";
import type { Team, TeamRow } from "@/lib/api/teams/model";
import { isWorkspaceAdmin } from "@/lib/api/workspace/queries";
import { isUuid } from "@/lib/ids";
import { bareTaskTitle, numbersLedBy } from "@/lib/request-numbers";
import { hasRole, isProjectRole } from "@/lib/roles";
import {
  type CuratedWorkItem,
  isTeamRole,
  parseTeamAccessStatus,
  TEAM_CALENDAR_LIMIT,
  type TeamAccessStatus,
  type TeamCalendarTask,
  type TeamJoinRequest,
  type TeamRole,
} from "@/lib/teams";

const TEAM_COLUMNS =
  "id, name, description, created_at, team_members!team_members_team_id_fkey(profile_id, role, created_at, deleted_at, profile:profiles!team_members_profile_id_fkey(email, full_name))";

function toTeam(row: TeamRow): Team {
  const roleOrder = (role: TeamRole) => (role === "lead" ? 0 : 1);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    members: row.team_members
      .filter((m) => m.deleted_at === null && isTeamRole(m.role))
      .map((m) => ({
        profileId: m.profile_id,
        role: m.role as TeamRole,
        name: m.profile?.full_name?.trim() || m.profile?.email || "Unknown",
        email: m.profile?.email ?? "",
        addedAt: m.created_at,
      }))
      .sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.name.localeCompare(b.name)),
  };
}

export const listTeams = read(async (ctx: ApiContext): Promise<Team[]> => {
  const supabase = ctx.db;
  const result = await supabase.from("teams").select(TEAM_COLUMNS).is("deleted_at", null).order("name");
  return rows(result, "teams").map((row) => toTeam(row as TeamRow));
});

export const getTeam = read(async (ctx: ApiContext, teamId: string): Promise<Team | null> => {
  const supabase = ctx.db;
  const result = await supabase.from("teams").select(TEAM_COLUMNS).eq("id", teamId).is("deleted_at", null).maybeSingle();
  const row = maybe(result, "team");
  return row ? toTeam(row as TeamRow) : null;
});

export const canManageTeam = read(async (ctx: ApiContext, teamId: string): Promise<boolean> => {
  const supabase = ctx.db;
  return maybe(await supabase.rpc("can_manage_team", { target_team: teamId }), "team role") === true;
});

// Oct 26 notes (batch 4): what the viewer sees on a team link. "member" = they can see inside (a member
// or a workspace admin); anything unknown, an error, or a database without this release's update is
// "missing": the plain Not found.
export const getTeamAccessStatus = read(async (ctx: ApiContext, teamId: string): Promise<TeamAccessStatus> => {
  if (!isUuid(teamId)) return "missing";
  const supabase = ctx.db;
  const { data, error } = await supabase.rpc("team_access_status", { target_team: teamId });
  // A database without this release has no team_access_status: teams were open to everyone there, so a
  // team that exists opens as before (a preview deployed ahead of the migration keeps working).
  if (error?.code === "PGRST202") return (await getTeam(ctx, teamId)) ? "member" : "missing";
  return error ? "missing" : parseTeamAccessStatus(data);
});

// Teams the viewer can see inside (RLS hides everyone else's memberships): every team for a workspace
// admin, else the teams they're on. Share and Add a team offer only these.
export const listViewableTeamIds = read(async (ctx: ApiContext): Promise<Set<string>> => {
  const [admin, teams, mine] = await Promise.all([isWorkspaceAdmin(ctx), listTeams(ctx), listMyTeamIds(ctx)]);
  return admin ? new Set(teams.map((t) => t.id)) : mine;
});

// Open requests to join a team (RLS: the team's leads and workspace admins, and each requester). Empty
// without this release's database.
export const listTeamJoinRequests = read(async (ctx: ApiContext, teamId: string): Promise<TeamJoinRequest[]> => {
  const supabase = ctx.db;
  const { data, error } = await supabase
    .from("team_join_requests")
    .select("id, requester_id, created_at")
    .eq("team_id", teamId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(100);
  if (error || !data?.length) return [];
  const people = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .in("id", [...new Set(data.map((r) => r.requester_id))]);
  const byId = new Map((people.data ?? []).map((p) => [p.id, p] as const));
  return data.map((r) => {
    const person = byId.get(r.requester_id);
    return {
      id: r.id,
      profileId: r.requester_id,
      name: person?.full_name?.trim() || person?.email || "Someone",
      email: person?.email ?? "",
      requestedAt: r.created_at,
    };
  });
});

// Teams the viewer is in (active), for the New project team picker; the default team is always
// offered too (anyone may put a project there).
export const listMyTeamIds = read(async (ctx: ApiContext): Promise<Set<string>> => {
  const { user } = await getViewer(ctx);
  if (!user) return new Set();
  const supabase = ctx.db;
  const result = await supabase.from("team_members").select("team_id").eq("profile_id", user.id).is("deleted_at", null);
  return new Set(rows(result, "your teams").map((r) => r.team_id));
});

// A team's Curated work in order, only the items the viewer can open (RLS). Null on a database without
// 20261012050000_asana_parity_5.sql.
export const listTeamCuratedWork = read(async (ctx: ApiContext, teamId: string): Promise<CuratedWorkItem[] | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("team_curated_work")
    .select(
      "id, project_id, portfolio_id, sort_order, project:projects(id, name, description, status, archived_at, deleted_at), portfolio:portfolios(id, name, notes, deleted_at)",
    )
    .eq("team_id", teamId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  if (result.error && ["PGRST205", "42P01", "PGRST200"].includes(result.error.code ?? "")) return null;
  return rows(result, "curated work").flatMap((row): CuratedWorkItem[] => {
    if (row.project && !row.project.deleted_at) {
      return [
        {
          id: row.id,
          kind: "project",
          targetId: row.project.id,
          name: row.project.name,
          description: row.project.description,
          status: row.project.status,
          archived: row.project.archived_at !== null,
          sortOrder: row.sort_order,
        },
      ];
    }
    if (row.portfolio && !row.portfolio.deleted_at) {
      return [
        {
          id: row.id,
          kind: "portfolio",
          targetId: row.portfolio.id,
          name: row.portfolio.name,
          description: row.portfolio.notes,
          status: null,
          archived: false,
          sortOrder: row.sort_order,
        },
      ];
    }
    return [];
  });
});

// Tasks due from `from` to `to` (local days, inclusive) in the team's projects the viewer is a member
// of — the team Calendar. Public-to-team projects the viewer hasn't joined and private projects of
// others are never read (browse_projects only lists the former, with no role, and RLS hides tasks).
// Top-level tasks only (subtasks have no memberships); a multi-homed task shows once, under its first
// team project.
export async function listTeamCalendarTasks(
  ctx: ApiContext, teamId: string,
  from: string,
  to: string,
): Promise<{ tasks: TeamCalendarTask[]; projectCount: number; capped: boolean }> {
  const projects = (await browseProjects(ctx, teamId)).filter((p) => p.myRole !== null);
  if (projects.length === 0) return { tasks: [], projectCount: 0, capped: false };
  const byId = new Map(projects.map((p) => [p.projectId, p] as const));
  const supabase = ctx.db;
  // Tasks whose span (start date, else due date, through the due date) touches the visible weeks.
  const result = await supabase
    .from("task_projects")
    .select("project_id, created_at, task:tasks!inner(id, title, start_on, due_on, completed_at, assignee_id, kind, deleted_at)")
    .in("project_id", [...byId.keys()])
    .is("deleted_at", null)
    .is("task.deleted_at", null)
    .gte("task.due_on", from)
    .or(`start_on.lte.${to},due_on.lte.${to}`, { referencedTable: "task" })
    .order("project_id")
    .limit(TEAM_CALENDAR_LIMIT);
  const tasks = new Map<string, TeamCalendarTask>();
  const list = rows(result, "team calendar");
  // A task in several of the team's projects is labelled with the first one it was added to (Oct 29
  // notes, 55b: the stable rule).
  const ordered = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.project_id.localeCompare(b.project_id));
  for (const row of ordered) {
    const t = row.task;
    if (!t.due_on) continue;
    const project = byId.get(row.project_id);
    // The viewer's own role in the project (an archived project caps everyone at Viewer); a task in
    // several of the team's projects is editable through any of them. The database decides on save.
    const canEdit = Boolean(project && !project.archived && hasRole(isProjectRole(project.myRole) ? project.myRole : null, "editor"));
    const seen = tasks.get(t.id);
    if (seen) {
      if (canEdit) seen.canEdit = true;
      continue;
    }
    tasks.set(t.id, {
      id: t.id,
      title: t.title,
      startOn: t.start_on && t.start_on <= t.due_on ? t.start_on : null,
      dueOn: t.due_on,
      completedAt: t.completed_at,
      assigneeId: t.assignee_id,
      kind: t.kind,
      projectId: row.project_id,
      projectName: project?.name ?? "Project",
      canEdit,
      requestLabel: null,
    });
  }
  // Oct 26 notes (batch 4): the number is drawn as a tiny badge after the name, so the bar keeps the
  // bare name (a label baked into an older title is taken off) and the label travels next to it.
  // Oct 29 notes (55b): the bar's project's own number first, else the first number the viewer can read
  // (stable order) — named with its own project (numberProjectName), so the badge never pairs one
  // project's number with another's name — and the rest for "+N".
  const numbers = await visibleTaskNumbers(ctx, [...tasks.keys()]);
  for (const task of tasks.values()) {
    const taskNumbers = numbers.get(task.id) ?? [];
    const ordered = numbersLedBy(taskNumbers, task.projectId);
    const lead = ordered[0];
    task.requestLabel = lead?.label ?? null;
    task.taskNumbers = ordered;
    task.numberProjectName = lead && lead.projectId && lead.projectId !== task.projectId ? lead.projectName : null;
    task.title = bareTaskTitle(task.title, taskNumbers[0]?.label ?? null);
  }
  const sorted = [...tasks.values()].sort(
    (a, b) => (a.startOn ?? a.dueOn).localeCompare(b.startOn ?? b.dueOn) || a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title),
  );
  return { tasks: sorted, projectCount: projects.length, capped: list.length >= TEAM_CALENDAR_LIMIT };
}
