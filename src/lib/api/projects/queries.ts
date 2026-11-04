// Big move 1: the projects area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { parseAccessStatus, type ProjectAccessRequest, type ProjectAccessStatus } from "@/lib/access-requests";
import { getViewer } from "@/lib/api/auth/queries";
import { type ApiContext, read } from "@/lib/api/core/context";
import { isMissingColumn, maybe, rows } from "@/lib/api/core/db";
import { GOAL_COLUMNS, toGoal } from "@/lib/api/goals/model";
import {
  type BrowseProjectPeople,
  type Project,
  PROJECT_COLUMNS,
  type ProjectEmailActivityItem,
  type ProjectFile,
  type ProjectGoalLink,
  type ProjectMember,
  type ProjectOrigin,
  type ProjectOverviewInfo,
  type ProjectRoleDef,
  type ProjectStatusUpdate,
  type ProjectStoryItem,
  type ProjectStoryKind,
  type ProjectTeamAccess,
  type RoleUsage,
  type Section,
  type TaskRoleLink,
} from "@/lib/api/projects/model";
import { type DependencyShiftMode, parseDependencyShiftMode } from "@/lib/dependencies";
import { isUuid } from "@/lib/ids";
import { displayName } from "@/lib/people";
import { hasRole, isProjectRole, type ProjectRole } from "@/lib/roles";
import type { SidebarFolderState } from "@/lib/sidebar-folders";
import { type StatusTemplate, toStatusTemplate } from "@/lib/status-templates";
import type { Json } from "@/lib/supabase/database.types";
import { type BrowseProject, isProjectVisibility } from "@/lib/workspace";

// Active projects the viewer can read: the sidebar, Home, and every project picker. Archived projects
// are left out (listArchivedProjects); listReadableProjects has both, for labelling tasks.
export const listProjects = read(async (ctx: ApiContext): Promise<Project[]> =>
  (await listReadableProjects(ctx)).filter((p) => p.archived_at === null),
);

// Starred projects (Asana parity, batch 1): the viewer's own stars, oldest first (RLS: own rows only).
// The sidebar keeps the ones it can also read (listProjects), so a star on a project the viewer lost, or
// one that was archived or deleted, shows nothing. A missing table (a preview deployed before its
// migration is applied) reads as no stars rather than breaking the app shell.
export const listStarredProjectIds = read(async (ctx: ApiContext): Promise<string[]> => {
  const supabase = ctx.db;
  const result = await supabase.from("project_stars").select("project_id").is("deleted_at", null).order("starred_at");
  if (result.error) {
    console.error(`[stars] couldn't load starred projects: ${result.error.message}`);
    return [];
  }
  return (result.data ?? []).map((row) => row.project_id);
});

// Oct 26 notes (batch 3): the viewer's own sidebar folders and where their projects sit (RLS: own rows
// only). A missing table (a preview before this release's database update) reads as no folders.
export const listSidebarFolders = read(async (ctx: ApiContext): Promise<SidebarFolderState> => {
  const supabase = ctx.db;
  const [folders, placements] = await Promise.all([
    supabase.from("sidebar_folders").select("id, name, collapsed, sort_order").is("deleted_at", null).order("sort_order"),
    supabase.from("sidebar_folder_projects").select("project_id, folder_id, sort_order").not("folder_id", "is", null),
  ]);
  if (folders.error || placements.error) {
    const error = folders.error ?? placements.error;
    if (error?.code !== "PGRST205" && error?.code !== "42P01") console.error(`[sidebar] couldn't load folders: ${error?.message}`);
    return { folders: [], placements: [] };
  }
  return {
    folders: (folders.data ?? []).map((f) => ({ id: f.id, name: f.name, collapsed: f.collapsed, sortOrder: f.sort_order })),
    placements: (placements.data ?? []).map((p) => ({ projectId: p.project_id, folderId: p.folder_id, sortOrder: p.sort_order })),
  };
});

export const listArchivedProjects = read(async (ctx: ApiContext): Promise<Project[]> =>
  (await listReadableProjects(ctx))
    .filter((p) => p.archived_at !== null)
    .sort((a, b) => b.archived_at!.localeCompare(a.archived_at!)),
);

export const listReadableProjects = read(async (ctx: ApiContext): Promise<Project[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "projects");
});

export const getProject = read(async (ctx: ApiContext, projectId: string): Promise<Project | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  return maybe(result, "project");
});

// The viewer's role in a project, or null when they are not a member.
export const getProjectRole = read(async (ctx: ApiContext, projectId: string): Promise<ProjectRole | null> => {
  const supabase = ctx.db;
  const role = maybe(await supabase.rpc("project_role", { target_project: projectId }), "project role");
  return isProjectRole(role) ? role : null;
});

// The viewer's effective role in every project they belong to: archived projects count as Viewer
// (read-only for everyone, like project_role() in the database).
export const listMyProjectRoles = read(async (ctx: ApiContext): Promise<Map<string, ProjectRole>> => {
  const [own, projects] = await Promise.all([listOwnProjectRoles(ctx), listReadableProjects(ctx)]);
  const archived = new Set(projects.filter((p) => p.archived_at !== null).map((p) => p.id));
  return new Map([...own].map(([projectId, role]) => [projectId, archived.has(projectId) ? "viewer" : role] as const));
});

// The viewer's own membership role, archived or not (who may archive / unarchive: Admin+).
export const listOwnProjectRoles = read(async (ctx: ApiContext): Promise<Map<string, ProjectRole>> => {
  const { user } = await getViewer(ctx);
  if (!user) return new Map();
  const supabase = ctx.db;
  const result = await supabase
    .from("project_members")
    .select("project_id, role")
    .eq("profile_id", user.id)
    .is("deleted_at", null);
  return new Map(
    rows(result, "project roles")
      .filter((m) => isProjectRole(m.role))
      .map((m) => [m.project_id, m.role as ProjectRole] as const),
  );
});

export const listProjectMembers = read(async (ctx: ApiContext, projectId: string): Promise<ProjectMember[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("project_members")
    .select(
      "profile_id, role, created_at, profile:profiles!project_members_profile_id_fkey!inner(email, full_name, avatar_url)",
    )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at");
  return rows(result, "members")
    .filter((m) => isProjectRole(m.role))
    .map((m) => ({
      profileId: m.profile_id,
      role: m.role as ProjectRole,
      name: displayName(m.profile),
      email: m.profile.email,
      fullName: m.profile.full_name,
      avatarUrl: m.profile.avatar_url,
      addedAt: m.created_at,
    }));
});

export const listSections = read(async (ctx: ApiContext, projectId: string): Promise<Section[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("sections")
    .select("id, project_id, name, sort_order")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "sections");
});

// A project's status templates (Customize → Status templates, and the status update panel's picker):
// RLS shows them to the project's Viewers+. Empty on a database without Real features 4.
export const listStatusTemplates = read(async (ctx: ApiContext, projectId: string): Promise<StatusTemplate[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("project_status_templates")
    .select("id, name, status, title, sections, sort_order, created_by")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "status templates").map(toStatusTemplate);
});

// Active projects other than `exceptId` where the viewer is an Editor+, with their sections (the "Add
// to another project" action: saving it needs Editor+ there).
export const listEditableProjectsWithSections = read(
  async (ctx: ApiContext, exceptId: string): Promise<{ id: string; name: string; sections: { id: string; name: string }[] }[]> => {
    const [projects, roles] = await Promise.all([listProjects(ctx), listMyProjectRoles(ctx)]);
    const editable = projects
      .filter((p) => p.id !== exceptId && hasRole(roles.get(p.id) ?? null, "editor"))
      .slice(0, 100);
    if (editable.length === 0) return [];
    const supabase = ctx.db;
    const sections = rows(
      await supabase
        .from("sections")
        .select("id, name, project_id, sort_order")
        .in("project_id", editable.map((p) => p.id))
        .is("deleted_at", null)
        .order("sort_order"),
      "sections",
    );
    return editable.map((p) => ({
      id: p.id,
      name: p.name,
      sections: sections.filter((s) => s.project_id === p.id).map((s) => ({ id: s.id, name: s.name })),
    }));
  },
);

const STATUS_UPDATE_COLUMNS =
  "id, project_id, status, title, note, created_at, author:profiles!project_status_updates_author_id_fkey(full_name, email)";

// Before 20261011020000_asana_parity_2.sql (a preview deployed ahead of its migration): no title.
const STATUS_UPDATE_COLUMNS_UNTITLED =
  "id, project_id, status, note, created_at, author:profiles!project_status_updates_author_id_fkey(full_name, email)";

function toStatusUpdate(r: {
  id: string;
  project_id: string;
  status: string;
  title?: string | null;
  note: string | null;
  created_at: string;
  author: { full_name: string | null; email: string } | null;
}): ProjectStatusUpdate {
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    title: r.title ?? null,
    note: r.note,
    authorName: r.author ? r.author.full_name?.trim() || r.author.email : null,
    createdAt: r.created_at,
  };
}

// A project's status history, newest first (project Viewers+).
export const listProjectStatusUpdates = read(async (ctx: ApiContext, projectId: string): Promise<ProjectStatusUpdate[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("project_status_updates")
    .select(STATUS_UPDATE_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (isMissingColumn(result.error)) {
    const untitled = await supabase
      .from("project_status_updates")
      .select(STATUS_UPDATE_COLUMNS_UNTITLED)
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(50);
    return rows(untitled, "status history").map(toStatusUpdate);
  }
  return rows(result, "status history").map(toStatusUpdate);
});

// The latest status update of each project (for portfolio columns), keyed by project id.
export async function listLatestStatusUpdates(ctx: ApiContext, projectIds: string[]): Promise<Map<string, ProjectStatusUpdate>> {
  const latest = new Map<string, ProjectStatusUpdate>();
  if (projectIds.length === 0) return latest;
  const supabase = ctx.db;
  const result = await supabase
    .from("project_status_updates")
    .select(STATUS_UPDATE_COLUMNS)
    .in("project_id", projectIds)
    .order("created_at", { ascending: false })
    .limit(2000);
  const updates = isMissingColumn(result.error)
    ? rows(
        await supabase
          .from("project_status_updates")
          .select(STATUS_UPDATE_COLUMNS_UNTITLED)
          .in("project_id", projectIds)
          .order("created_at", { ascending: false })
          .limit(2000),
        "status updates",
      ).map(toStatusUpdate)
    : rows(result, "status updates").map(toStatusUpdate);
  for (const update of updates) {
    if (!latest.has(update.projectId)) latest.set(update.projectId, update);
  }
  return latest;
}

// ---------------------------------------------------------------------------------------------
// Project page (Asana parity, batch 2): the Overview tab and the Share dialog. Every read uses the
// viewer's client, so RLS decides: project rows, members, stories, and team records for project
// Viewers+, goal links only for projects the viewer can read. Workspace admins get nothing extra.
// ---------------------------------------------------------------------------------------------

function personName(person: { full_name: string | null; email: string } | null): string | null {
  return person ? displayName(person) : null;
}

// When and by whom the project was created, and its due date (projects.due_on; a preview deployed
// before 20261011020000_asana_parity_2.sql reads no due date).
export const getProjectOverviewInfo = read(async (ctx: ApiContext, projectId: string): Promise<ProjectOverviewInfo | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("projects")
    .select("created_at, due_on, creator:profiles!projects_created_by_fkey(full_name, email)")
    .eq("id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  if (isMissingColumn(result.error)) {
    const row = maybe(
      await supabase
        .from("projects")
        .select("created_at, creator:profiles!projects_created_by_fkey(full_name, email)")
        .eq("id", projectId)
        .is("deleted_at", null)
        .maybeSingle(),
      "project",
    );
    return row ? { createdAt: row.created_at, createdByName: personName(row.creator), dueOn: null } : null;
  }
  const row = maybe(result, "project");
  return row ? { createdAt: row.created_at, createdByName: personName(row.creator), dueOn: row.due_on } : null;
});

const PROJECT_STORY_KINDS: readonly string[] = ["created_from_template", "duplicated", "archived", "unarchived"];

// Project-level history (project_stories: copies, archive / unarchive), newest first.
export const listProjectStories = read(async (ctx: ApiContext, projectId: string): Promise<ProjectStoryItem[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("project_stories")
    .select("id, kind, data, created_at, actor:profiles(email, full_name)")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(50);
  return rows(result, "project history").flatMap((story): ProjectStoryItem[] => {
    if (!PROJECT_STORY_KINDS.includes(story.kind)) return [];
    const data = story.data && typeof story.data === "object" && !Array.isArray(story.data) ? story.data : {};
    const name = story.kind === "duplicated" ? data.source_project_name : data.template_name;
    return [
      {
        id: story.id,
        kind: story.kind as ProjectStoryKind,
        actorName: personName(story.actor),
        fromName: typeof name === "string" ? name : null,
        createdAt: story.created_at,
      },
    ];
  });
});

export const listProjectEmailActivity = read(async (ctx: ApiContext, projectId: string): Promise<ProjectEmailActivityItem[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("task_email_activity")
    .select("id, kind, task_id, sender_email, subject, created_at, task:tasks!inner(title, deleted_at), sender:profiles(email, full_name)")
    .eq("project_id", projectId)
    .is("task.deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  // A database without this release's update has no such table: nothing to list.
  if (result.error) return [];
  return (result.data ?? []).flatMap((row): ProjectEmailActivityItem[] => {
    const task = Array.isArray(row.task) ? row.task[0] : row.task;
    if (!task || (row.kind !== "task_created" && row.kind !== "comment_added")) return [];
    return [
      {
        id: row.id,
        kind: row.kind,
        taskId: row.task_id,
        taskTitle: task.title,
        senderName: personName(Array.isArray(row.sender) ? row.sender[0] : row.sender),
        senderEmail: row.sender_email,
        subject: row.subject,
        createdAt: row.created_at,
      },
    ];
  });
});

// Goals this project is connected to (goal_links; RLS shows a link only to people who can read the
// project, and goals are readable by everyone allowlisted).
export const listProjectGoalLinks = read(async (ctx: ApiContext, projectId: string): Promise<ProjectGoalLink[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("goal_links")
    .select(`id, goal:goals!goal_links_goal_id_fkey(${GOAL_COLUMNS}, deleted_at)` as const)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at");
  return rows(result, "connected goals").flatMap((r): ProjectGoalLink[] =>
    r.goal && r.goal.deleted_at === null ? [{ linkId: r.id, goal: toGoal(r.goal) }] : [],
  );
});

// Teams added to the project with a group invite (team_projects: a record of the invite, readable with
// the project). The people themselves are ordinary members.
export const listProjectTeamAccess = read(async (ctx: ApiContext, projectId: string): Promise<ProjectTeamAccess[]> => {
  const supabase = ctx.db;
  const query = (columns: string) =>
    supabase.from("team_projects").select(columns).eq("project_id", projectId).is("deleted_at", null).order("created_at");
  type Row = { team_id: string; role: string; uses_default_roles?: boolean; team: { name: string; deleted_at: string | null } | null };
  const base = "team_id, role, team:teams!team_projects_team_id_fkey(name, deleted_at)";
  // uses_default_roles comes with the Oct 25 notes' database update.
  let result = await query(`${base}, uses_default_roles`);
  if (result.error && isMissingColumn(result.error)) result = await query(base);
  return rows(result as unknown as { data: Row[] | null; error: typeof result.error }, "teams on the project").flatMap(
    (r): ProjectTeamAccess[] =>
      r.team && r.team.deleted_at === null
        ? [{ teamId: r.team_id, name: r.team.name, role: r.role, usesDefaultRoles: r.uses_default_roles === true }]
        : [],
  );
});

// Oct 26 notes (batch 3): what someone who isn't a member sees on a project link. Without this
// release's database (or on any error) it's "missing": the old plain Not found.
export const getProjectAccessStatus = read(async (ctx: ApiContext, projectId: string): Promise<ProjectAccessStatus> => {
  if (!isUuid(projectId)) return "missing";
  const supabase = ctx.db;
  const { data, error } = await supabase.rpc("project_access_status", { target_project: projectId });
  return error ? "missing" : parseAccessStatus(data);
});

// Open requests to join a project (RLS: the project's admins+ and each requester; Share shows them to
// the people who can decide). Empty without this release's database.
export const listProjectAccessRequests = read(async (ctx: ApiContext, projectId: string): Promise<ProjectAccessRequest[]> => {
  const supabase = ctx.db;
  const { data, error } = await supabase
    .from("project_access_requests")
    .select("id, requester_id, created_at")
    .eq("project_id", projectId)
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

// How the project was made, when the copy engine made it (one project story per created project).
export const getProjectOrigin = read(async (ctx: ApiContext, projectId: string): Promise<ProjectOrigin | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("project_stories")
    .select("kind, data, created_at, actor:profiles(email, full_name)")
    .eq("project_id", projectId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const story = maybe(result, "project history");
  if (!story || (story.kind !== "created_from_template" && story.kind !== "duplicated")) return null;
  const data = story.data && typeof story.data === "object" && !Array.isArray(story.data) ? story.data : {};
  const name = story.kind === "duplicated" ? data.source_project_name : data.template_name;
  return {
    kind: story.kind,
    fromName: typeof name === "string" ? name : null,
    fromProjectId: story.kind === "duplicated" && typeof data.source_project_id === "string" ? data.source_project_id : null,
    actorName: story.actor ? (story.actor.full_name ?? story.actor.email) : null,
    createdAt: story.created_at,
  };
});

// Browse projects: the viewer's own projects plus team-visible projects of their teams. Private
// projects of others never come back (workspace admins included).
export const browseProjects = read(async (ctx: ApiContext, teamId?: string | null): Promise<BrowseProject[]> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("browse_projects", { target_team: teamId ?? null });
  return rows(result, "projects to browse").map((r) => ({
    projectId: r.project_id,
    name: r.name,
    description: r.description,
    teamId: r.team_id,
    teamName: r.team_name,
    visibility: isProjectVisibility(r.visibility) ? r.visibility : "private",
    status: r.status,
    archived: r.archived,
    memberCount: r.member_count,
    myRole: r.my_role,
  }));
});

export const browseProjectPeople = read(
  async (ctx: ApiContext, teamId?: string | null): Promise<Map<string, BrowseProjectPeople> | null> => {
    const supabase = ctx.db;
    const result = await supabase.rpc("browse_project_people", { target_team: teamId ?? null });
    if (result.error?.code === "PGRST202") return null;
    return new Map(
      rows(result, "project people").map((r) => [
        r.project_id,
        { ownerIds: r.owner_ids ?? [], memberIds: r.member_ids ?? [], modifiedAt: r.modified_at },
      ]),
    );
  },
);

// Oct 27 notes (batch 5): whether the project's Owners locked its sections (false on a database without
// this release).
export const getProjectSectionsLocked = read(async (ctx: ApiContext, projectId: string): Promise<boolean> => {
  if (!isUuid(projectId)) return false;
  const supabase = ctx.db;
  const { data, error } = await supabase.from("projects").select("sections_locked").eq("id", projectId).maybeSingle();
  if (error) return false;
  return data?.sections_locked === true;
});

export const listProjectRoles = read(async (ctx: ApiContext, projectId: string): Promise<ProjectRoleDef[]> => {
  if (!isUuid(projectId)) return [];
  const supabase = ctx.db;
  const { data, error } = await supabase
    .from("project_roles")
    .select("id, project_id, name, profile_id, sort_order")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order");
  if (error) return [];
  return (data ?? []).map((r) => ({ id: r.id, projectId: r.project_id, name: r.name, profileId: r.profile_id, sortOrder: r.sort_order }));
});

export async function listTaskRoleLinks(ctx: ApiContext, taskId: string): Promise<TaskRoleLink[]> {
  if (!isUuid(taskId)) return [];
  const supabase = ctx.db;
  const { data, error } = await supabase
    .from("task_role_links")
    .select("project_role_id, slot")
    .eq("task_id", taskId)
    .is("deleted_at", null);
  if (error) return [];
  return (data ?? [])
    .filter((l) => l.slot === "assignee" || l.slot === "approver" || l.slot === "follower")
    .map((l) => ({ roleId: l.project_role_id, slot: l.slot as TaskRoleLink["slot"] }));
}

// How many open tasks follow a role (the "update open tasks too?" prompt).
export async function countOpenRoleTasks(ctx: ApiContext, roleId: string): Promise<number> {
  if (!isUuid(roleId)) return 0;
  const supabase = ctx.db;
  const { data, error } = await supabase
    .from("task_role_links")
    .select("task_id, task:tasks!inner(completed_at, deleted_at)")
    .eq("project_role_id", roleId)
    .is("deleted_at", null)
    .is("task.completed_at", null)
    .is("task.deleted_at", null);
  if (error) return 0;
  return new Set((data ?? []).map((r) => r.task_id)).size;
}

const ROLE_USAGE_TASKS_SHOWN = 50;

export async function loadRoleUsage(ctx: ApiContext, roleId: string): Promise<RoleUsage> {
  const empty: RoleUsage = { tasks: [], taskTotal: 0, automations: [] };
  if (!isUuid(roleId)) return empty;
  const supabase = ctx.db;
  const role = await supabase.from("project_roles").select("id, project_id").eq("id", roleId).maybeSingle();
  if (role.error || !role.data) return empty;
  const [links, rules] = await Promise.all([
    supabase
      .from("task_role_links")
      .select("task_id, slot, task:tasks!inner(title, assignee_id, completed_at, deleted_at, created_at)")
      .eq("project_role_id", roleId)
      .is("deleted_at", null)
      .is("task.completed_at", null)
      .is("task.deleted_at", null),
    supabase.from("rules").select("id, name, enabled, conditions, actions, trigger_config").eq("project_id", role.data.project_id).is("deleted_at", null),
  ]);
  const byTask = new Map<string, { id: string; title: string; slots: string[]; assigneeId: string | null; createdAt: string }>();
  for (const link of links.data ?? []) {
    const task = link.task as unknown as { title: string; assignee_id: string | null; created_at: string };
    const row = byTask.get(link.task_id) ?? { id: link.task_id, title: task.title, slots: [], assigneeId: task.assignee_id, createdAt: task.created_at };
    if (!row.slots.includes(link.slot)) row.slots.push(link.slot);
    byTask.set(link.task_id, row);
  }
  const tasks = [...byTask.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // An automation names a role as "project_role:<id>" (people) or Send email's role_id.
  const mentions = (rule: { conditions: Json; actions: Json; trigger_config: Json }) =>
    JSON.stringify([rule.conditions, rule.actions, rule.trigger_config]).includes(roleId);
  return {
    tasks: tasks.slice(0, ROLE_USAGE_TASKS_SHOWN).map((t) => ({ id: t.id, title: t.title, slots: t.slots, assigneeId: t.assigneeId })),
    taskTotal: tasks.length,
    automations: (rules.data ?? []).filter(mentions).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
  };
}

const FILE_COLUMNS = "id, file_name, content_type, size_bytes, uploaded_by, created_at, deleted_at";

const MAX_PROJECT_FILES = 500;

export const listProjectFiles = read(async (ctx: ApiContext, projectId: string): Promise<ProjectFile[]> => {
  if (!isUuid(projectId)) return [];
  const supabase = ctx.db;
  type FileRow = {
    id: string;
    file_name: string;
    content_type: string | null;
    size_bytes: number;
    uploaded_by: string;
    created_at: string;
    deleted_at: string | null;
    // With Real features 1's database update: upload | form | email.
    source?: string;
  };
  type TaskRow = { id: string; title: string; deleted_at: string | null; task_attachments: FileRow[] };
  const columns = `${FILE_COLUMNS}, source`;
  const files: ProjectFile[] = [];
  const add = (task: TaskRow) => {
    if (task.deleted_at) return;
    for (const f of task.task_attachments ?? []) {
      if (f.deleted_at) continue;
      files.push({
        id: f.id,
        fileName: f.file_name,
        contentType: f.content_type,
        sizeBytes: f.size_bytes,
        uploadedBy: f.uploaded_by,
        source: f.source === "form" || f.source === "email" ? f.source : "upload",
        createdAt: f.created_at,
        taskId: task.id,
        taskTitle: task.title,
      });
    }
  };

  const memberships = await supabase
    .from("task_projects")
    .select(`task_id, tasks!inner(id, title, deleted_at, task_attachments(${columns}))`)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .limit(5000);
  const taskIds: string[] = [];
  for (const row of rows(memberships, "project files")) {
    const task = row.tasks as unknown as TaskRow;
    taskIds.push(task.id);
    add(task);
  }
  // Subtasks have no memberships: they live under their top-level task.
  for (let i = 0; i < taskIds.length; i += 200) {
    const subtasks = await supabase
      .from("tasks")
      .select(`id, title, deleted_at, task_attachments(${columns})`)
      .in("root_task_id", taskIds.slice(i, i + 200))
      .is("deleted_at", null);
    for (const task of rows(subtasks, "subtask files")) add(task as unknown as TaskRow);
  }
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_PROJECT_FILES);
});

// A project's dependency-shift mode (Auto-shift / Ask me / Off). Ask me on a database without it.
export const getDependencyShiftMode = read(async (ctx: ApiContext, projectId: string): Promise<DependencyShiftMode> => {
  const supabase = ctx.db;
  const result = await supabase.from("projects").select("dependency_shift").eq("id", projectId).maybeSingle();
  if (result.error || !result.data) return "ask";
  return parseDependencyShiftMode(result.data.dependency_shift);
});
