// Big move 1: the people area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getViewer } from "@/lib/api/auth/queries";
import { type ApiContext, read } from "@/lib/api/core/context";
import { maybe, rows } from "@/lib/api/core/db";
import { visibleTaskPlaces } from "@/lib/api/numbers/queries";
import type { PersonActivity, PersonProfile, PersonTask, Profile } from "@/lib/api/people/model";
import { tagsEnabled } from "@/lib/api/tags/queries";
import { isWorkspaceAdmin } from "@/lib/api/workspace/queries";
import { isUuid } from "@/lib/ids";
import { displayName, PROFILE_ACTIVITY_LIMIT, PROFILE_TASK_LIMIT } from "@/lib/people";
import { isTeamRole, type TeamRole } from "@/lib/teams";
import { listMyProjectRoles, listProjects } from "@/lib/api/projects/queries";
import type { PersonProjectAccess, PersonProjectAccessRow } from "@/lib/api/shell/model";
import { commenterRoleAllowed } from "@/lib/api/workspace/queries";
import { assignableRoles, hasRole, isProjectRole, type ProjectRole } from "@/lib/roles";

// People in the workspace: profiles whose address is still on the allowlist (removed people left out).
// The search palette's People and the Share dialog's invite search.
export const listActivePeople = read(async (ctx: ApiContext): Promise<{ id: string; name: string; email: string }[]> => {
  const supabase = ctx.db;
  const [profiles, allowed] = await Promise.all([
    listProfiles(ctx),
    supabase.from("allowed_emails").select("email").is("removed_at", null),
  ]);
  if (allowed.error) return [];
  const active = new Set((allowed.data ?? []).map((row) => row.email.toLowerCase()));
  return profiles
    .filter((p) => active.has(p.email.toLowerCase()))
    .map((p) => ({ id: p.id, name: displayName(p), email: p.email }));
});

// Addresses on the allowlist whose owner hasn't signed in yet (no confirmed first sign-in). Adding one to a
// team makes a pending invite they join on first sign-in (Oct 26 notes, batch 4: the team member picker).
export const listUnjoinedAddresses = read(async (ctx: ApiContext): Promise<string[]> => {
  const supabase = ctx.db;
  const [allowed, joined] = await Promise.all([
    supabase.from("allowed_emails").select("email").is("removed_at", null),
    supabase.from("profiles").select("email").not("joined_at", "is", null),
  ]);
  if (allowed.error || joined.error) return [];
  const signedIn = new Set((joined.data ?? []).map((p) => p.email.toLowerCase()));
  return (allowed.data ?? []).map((a) => a.email.toLowerCase()).filter((email) => !signedIn.has(email)).sort();
});

export const listProfiles = read(async (ctx: ApiContext): Promise<Profile[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("profiles")
    .select("id, email, full_name, avatar_url")
    .order("full_name");
  return rows(result, "people");
});

// Everyone's picture by profile id (Oct 25 notes), for the shared Avatar wherever a person shows up.
// Only people who have one; everyone allowlisted reads every profile.
export const listProfileAvatars = read(async (ctx: ApiContext): Promise<Record<string, string>> => {
  const supabase = ctx.db;
  const result = await supabase.from("profiles").select("id, avatar_url").not("avatar_url", "is", null);
  if (result.error) return {};
  return Object.fromEntries((result.data ?? []).flatMap((p) => (p.avatar_url ? [[p.id, p.avatar_url]] : [])));
});

const PERSON_TASK_COLUMNS = "id, title, due_on, completed_at, kind, parent_task_id, root_task_id";

export const getPersonProfile = read(async (ctx: ApiContext, profileId: string): Promise<PersonProfile | null> => {
  if (!isUuid(profileId)) return null;
  const { user } = await getViewer(ctx);
  if (!user) return null;
  const supabase = ctx.db;
  const profile = maybe(
    await supabase.from("profiles").select("id, email, full_name, joined_at").eq("id", profileId).maybeSingle(),
    "person",
  );
  if (!profile) return null;
  const email = profile.email.toLowerCase();
  const self = profileId === user.id;
  const [allowed, admin, viewerIsAdmin, teamRows, memberRows, openResult, doneResult, stories, comments, tagsOn] =
    await Promise.all([
      supabase.from("allowed_emails").select("removed_at").eq("email", email).maybeSingle(),
      supabase.from("workspace_admins").select("id").eq("profile_id", profileId).is("deleted_at", null).limit(1),
      isWorkspaceAdmin(ctx),
      supabase
        .from("team_members")
        .select("role, team:teams!team_members_team_id_fkey!inner(id, name, deleted_at)")
        .eq("profile_id", profileId)
        .is("deleted_at", null)
        .is("team.deleted_at", null),
      supabase
        .from("project_members")
        .select("role, project:projects!inner(id, name, archived_at, deleted_at)")
        .eq("profile_id", profileId)
        .is("deleted_at", null)
        .is("project.deleted_at", null),
      supabase
        .from("tasks")
        .select(PERSON_TASK_COLUMNS, { count: "exact" })
        .eq("assignee_id", profileId)
        .is("completed_at", null)
        .is("deleted_at", null)
        .order("due_on", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(PROFILE_TASK_LIMIT),
      supabase
        .from("tasks")
        .select(PERSON_TASK_COLUMNS)
        .eq("assignee_id", profileId)
        .not("completed_at", "is", null)
        .is("deleted_at", null)
        .order("completed_at", { ascending: false })
        .limit(10),
      supabase
        .from("task_stories")
        .select("id, kind, created_at, task:tasks!inner(id, title, deleted_at, source, created_at)")
        .eq("actor_id", profileId)
        .is("task.deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(PROFILE_ACTIVITY_LIMIT * 2),
      supabase
        .from("comments")
        .select("id, body, created_at, task:tasks!inner(id, title, deleted_at)")
        .eq("author_id", profileId)
        .is("deleted_at", null)
        .is("task.deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(PROFILE_ACTIVITY_LIMIT),
      tagsEnabled(ctx),
    ]);

  const openRows = rows(openResult, "their open tasks");
  const doneRows = rows(doneResult, "their completed tasks");
  const places = await visibleTaskPlaces(ctx, [...openRows, ...doneRows].map((t) => t.id));
  const toTask = (t: (typeof openRows)[number]): PersonTask => ({
    id: t.id,
    title: t.title,
    dueOn: t.due_on,
    completedAt: t.completed_at,
    kind: t.kind,
    projectName: places.get(t.id)?.[0]?.projectName ?? null,
    isSubtask: t.parent_task_id !== null,
  });

  // Activity the viewer can read: task stories they caused (not the ones an inbound webhook wrote in
  // their name while creating a task) and their comments, newest first.
  const activity: PersonActivity[] = [
    ...rows(stories, "their activity")
      .filter((s) => !(s.task.source === "inbound" && s.created_at === s.task.created_at))
      // Note 154: no "tagged" / "untagged" lines while the workspace's tags are switched off.
      .filter((s) => tagsOn || (s.kind !== "tag_added" && s.kind !== "tag_removed"))
      .map((s) => ({
        id: `story-${s.id}`,
        at: s.created_at,
        kind: "story" as const,
        verb: s.kind,
        taskId: s.task.id,
        taskTitle: s.task.title,
        excerpt: null,
        times: 1,
      })),
    ...rows(comments, "their comments").map((c) => ({
      id: `comment-${c.id}`,
      at: c.created_at,
      kind: "comment" as const,
      verb: "comment",
      taskId: c.task.id,
      taskTitle: c.task.title,
      excerpt: c.body.split("\n").find((line) => line.trim())?.trim().slice(0, 200) ?? null,
      times: 1,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .reduce<PersonActivity[]>((list, item) => {
      const last = list[list.length - 1];
      if (last && item.kind === "story" && last.kind === "story" && last.verb === item.verb && last.taskId === item.taskId) {
        last.times += 1;
      } else {
        list.push(item);
      }
      return list;
    }, [])
    .slice(0, PROFILE_ACTIVITY_LIMIT);

  let lastActivity: PersonProfile["lastActivity"] = { at: activity[0]?.at ?? null, signedInAt: null, scope: "visible" };
  if (self || viewerIsAdmin) {
    const result = await supabase.rpc("list_member_last_activity", { target_profile: profileId });
    const row = result.error ? null : (result.data?.[0] ?? null);
    if (row) lastActivity = { at: row.last_active_at, signedInAt: row.last_sign_in_at, scope: "workspace" };
  }

  const allowedRow = maybe(allowed, "allowlist entry");
  return {
    id: profile.id,
    name: displayName(profile),
    email: profile.email,
    joinedAt: profile.joined_at,
    status: !allowedRow
      ? "not_in_workspace"
      : allowedRow.removed_at
        ? "removed"
        : profile.joined_at
          ? "active"
          : "invited",
    isWorkspaceAdmin: rows(admin, "workspace admins").length > 0,
    teams: rows(teamRows, "their teams")
      .filter((m) => isTeamRole(m.role))
      .map((m) => ({ id: m.team.id, name: m.team.name, role: m.role as TeamRole }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    projects: rows(memberRows, "their projects")
      .map((m) => ({ id: m.project.id, name: m.project.name, role: m.role, archived: m.project.archived_at !== null }))
      .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name)),
    openTasks: openRows.map(toTask),
    openTaskCount: openResult.count ?? openRows.length,
    recentlyCompleted: doneRows.map(toTask),
    activity,
    lastActivity,
  };
});

// A person's project access (Oct 25 notes, note 2) for the Members page and Admin console → Users:
// which projects they're in (or invited to) with their role, read with the caller's own context, so RLS
// decides — only projects the viewer is a member of show (a workspace admin sees nothing of a private
// project they aren't in). Changes go through the existing writes (changeProjectMemberRole,
// inviteProjectMember), which the database checks again.
export async function loadPersonProjectAccess(
  ctx: ApiContext,
  person: { email: string; profileId: string | null },
): Promise<PersonProjectAccess | null> {
  const { user, allowlisted } = await getViewer(ctx);
  if (!user || !allowlisted) return null;
  const email = typeof person.email === "string" ? person.email.trim().toLowerCase() : "";
  if (!email || email.length > 320) return null;
  const profileId = person.profileId && isUuid(person.profileId) ? person.profileId : null;

  const supabase = ctx.db;
  const [memberships, invites, myRoles, projects, allowCommenter] = await Promise.all([
    profileId
      ? supabase
          .from("project_members")
          .select("project_id, role, project:projects!project_members_project_id_fkey!inner(name, archived_at, deleted_at)")
          .eq("profile_id", profileId)
          .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("pending_memberships")
      .select("project_id, role, project:projects!pending_memberships_project_id_fkey!inner(name, archived_at, deleted_at)")
      .eq("email", email)
      .not("project_id", "is", null)
      .is("applied_at", null)
      .is("deleted_at", null),
    listMyProjectRoles(ctx),
    listProjects(ctx),
    commenterRoleAllowed(ctx),
  ]);
  if (memberships.error || invites.error) return null;

  const manage = (projectId: string, role: ProjectRole) => {
    const mine = myRoles.get(projectId);
    const canManage = hasRole(mine, "admin") && (role !== "owner" || mine === "owner");
    return { canManage, grantable: canManage ? assignableRoles(mine, allowCommenter) : [] };
  };

  const accessRows: PersonProjectAccessRow[] = [];
  const seen = new Set<string>();
  for (const m of memberships.data ?? []) {
    if (!m.project || m.project.deleted_at !== null || !isProjectRole(m.role)) continue;
    seen.add(m.project_id);
    accessRows.push({
      projectId: m.project_id,
      name: m.project.name,
      archived: m.project.archived_at !== null,
      role: m.role,
      pending: false,
      ...manage(m.project_id, m.role),
    });
  }
  for (const i of invites.data ?? []) {
    if (!i.project_id || !i.project || i.project.deleted_at !== null || seen.has(i.project_id) || !isProjectRole(i.role)) continue;
    seen.add(i.project_id);
    accessRows.push({
      projectId: i.project_id,
      name: i.project.name,
      archived: i.project.archived_at !== null,
      role: i.role,
      pending: true,
      ...manage(i.project_id, i.role),
    });
  }
  accessRows.sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));

  const addable = projects
    .filter((p) => !seen.has(p.id) && hasRole(myRoles.get(p.id), "admin"))
    .map((p) => ({ id: p.id, name: p.name, grantable: assignableRoles(myRoles.get(p.id), allowCommenter) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { rows: accessRows, addable, allowCommenter, defaultRoles: true };
}
