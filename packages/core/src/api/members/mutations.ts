// Big move 1: the members area's writes (project members, pending invites, project roles and the tasks
// that follow them). Every function takes the caller's ApiContext first, validates its own input, writes
// only through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no Next.js here.
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { ApiError, NEEDS_DATABASE_UPDATE, invalid } from "../core/errors";
import { addRole, email, id, projectRole, text } from "../core/validate";
import { inviteByEmail, type InviteOutcome } from "./invite";
import { DEFAULT_ROLES_MISSING, type TaskRolesInfo } from "./model";
import { listTaskRoleLinks } from "../projects/queries";
import { isUuid } from "../../ids";
import { PERSON_DEFAULT_ROLE } from "../../roles";

// ---------------------------------------------------------------------------------------------
// Members (all checks — role, allowlist, last owner — live in the SQL RPCs)
// ---------------------------------------------------------------------------------------------

// Invites someone to a project by email (add_project_member). `emailConfigured`: whether this deployment
// can send email (the caller's to know).
export async function inviteProjectMember(
  ctx: ApiContext,
  projectId: string,
  address: string,
  memberRole: string,
  options: { emailConfigured: boolean },
): Promise<InviteOutcome> {
  const emailAddress = email(address);
  const project = id(projectId);
  const memberRoleValue = addRole(memberRole);
  return inviteByEmail(
    ctx,
    emailAddress,
    { column: "project_id", id: project },
    async (supabase) => {
      const added = await supabase.rpc("add_project_member", {
        target_project: project,
        member_email: emailAddress,
        member_role: memberRoleValue,
      });
      if (memberRoleValue === PERSON_DEFAULT_ROLE && added.error?.message === "Unknown role") {
        throw invalid(DEFAULT_ROLES_MISSING);
      }
      return added;
    },
    { emailConfigured: options.emailConfigured },
  );
}

// Cancels a pending invite (project / portfolio Admin+, team leads and workspace admins; RLS decides).
export async function cancelPendingInvite(ctx: ApiContext, inviteId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("pending_memberships").update({ deleted_at: nowIso() }).eq("id", id(inviteId, "invite")).select("id"),
    "Only the people who manage this can cancel the invite",
  );
}

// Sends a pending invite's email again (Real features 1): setting resent_at queues it — the same people
// who can cancel it (RLS), at most every 10 minutes (the database says when it's too soon). The email
// goes out right after the response like every queued email.
export async function resendPendingInvite(ctx: ApiContext, inviteId: string): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase
    .from("pending_memberships")
    .update({ resent_at: nowIso() })
    .eq("id", id(inviteId, "invite"))
    .select("id");
  if (result.error?.code === "42703" || result.error?.code === "PGRST204") {
    throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  }
  checkUpdated(result, "Only the people who manage this can resend the invite");
}

// The bulk bar's "Add <name> to this project and assign?": the same add_project_member path as an
// invite (Admin+ of the project, the person allowlisted and signed in), looked up by profile.
export async function addProjectMemberByProfile(
  ctx: ApiContext,
  projectId: string,
  profileId: string,
  memberRole = "editor",
): Promise<void> {
  const supabase = ctx.db;
  const { data: profile } = await supabase.from("profiles").select("email").eq("id", id(profileId, "person")).maybeSingle();
  if (!profile?.email) throw invalid("That person isn’t in this workspace");
  // Already a member (e.g. added since the page loaded): keep their role; add_project_member would reset it.
  const { data: existing } = await supabase
    .from("project_members")
    .select("id")
    .eq("project_id", id(projectId))
    .eq("profile_id", profileId)
    .is("deleted_at", null)
    .maybeSingle();
  if (existing) return;
  check(
    await supabase.rpc("add_project_member", {
      target_project: id(projectId),
      member_email: profile.email,
      member_role: projectRole(memberRole),
    }),
  );
}

export async function changeProjectMemberRole(
  ctx: ApiContext,
  projectId: string,
  profileId: string,
  memberRole: string,
): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("update_project_member_role", {
      target_project: id(projectId),
      target_profile: id(profileId, "person"),
      new_role: projectRole(memberRole),
    }),
  );
}

export async function removeProjectMember(ctx: ApiContext, projectId: string, profileId: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("remove_project_member", {
      target_project: id(projectId),
      target_profile: id(profileId, "person"),
    }),
  );
}

export async function transferProjectOwnership(ctx: ApiContext, projectId: string, profileId: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("transfer_project_ownership", {
      target_project: id(projectId),
      target_profile: id(profileId, "person"),
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Project roles (Nov 2 notes, batch 14, 95): named roles of a project and who fills each. Editors+ (RLS
// and the RPCs decide). Tasks follow a role through task_role_links; automations name "the person in
// role X".
// ---------------------------------------------------------------------------------------------

const ROLES_MISSING = "Project roles need this release’s database update";

export async function createProjectRole(
  ctx: ApiContext,
  projectId: string,
  name: string,
  profileId: string | null = null,
): Promise<void> {
  const supabase = ctx.db;
  const inserted = await supabase.from("project_roles").insert({
    project_id: id(projectId, "project"),
    name: text(name, "Role name", { max: 60 }),
    profile_id: profileId ? id(profileId, "person") : null,
  });
  if (inserted.error?.code === "42P01" || inserted.error?.code === "PGRST205") throw invalid(ROLES_MISSING);
  if (inserted.error?.code === "23505") throw invalid("This project already has a role with that name");
  check(inserted);
}

export async function renameProjectRole(ctx: ApiContext, roleId: string, name: string): Promise<void> {
  const supabase = ctx.db;
  const updated = await supabase
    .from("project_roles")
    .update({ name: text(name, "Role name", { max: 60 }) })
    .eq("id", id(roleId, "role"))
    .select("id");
  if (updated.error?.code === "23505") throw invalid("This project already has a role with that name");
  checkUpdated(updated);
}

export async function removeProjectRole(ctx: ApiContext, roleId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("project_roles").update({ deleted_at: nowIso() }).eq("id", id(roleId, "role")).select("id"),
  );
}

// Who fills a role; with updateOpenTasks, the open tasks linked to it follow (assignee, approvers,
// followers). Returns how many tasks changed and how many couldn't (e.g. the caller can't edit them).
export async function setProjectRolePerson(
  ctx: ApiContext,
  roleId: string,
  profileId: string | null,
  updateOpenTasks: boolean,
): Promise<{ updated: number; skipped: number }> {
  const supabase = ctx.db;
  const saved = await supabase.rpc("set_project_role_person", {
    target_role: id(roleId, "role"),
    person: profileId ? id(profileId, "person") : null,
    update_open_tasks: Boolean(updateOpenTasks),
  });
  if (saved.error?.code === "PGRST202") throw invalid(ROLES_MISSING);
  check(saved);
  const data = saved.data as { updated?: unknown; skipped?: unknown } | null;
  return {
    updated: typeof data?.updated === "number" ? data.updated : 0,
    skipped: typeof data?.skipped === "number" ? data.skipped : 0,
  };
}

// The roles a task can take people from (roles of its — its top-level task's — projects) and its links,
// for the task pane's Roles row. Only reads (the pane calls it on open), with the viewer's own client.
export async function loadTaskRoles(ctx: ApiContext, taskId: string): Promise<TaskRolesInfo> {
  if (!isUuid(taskId)) return { roles: [], links: [] };
  const supabase = ctx.db;
  const { data: task } = await supabase.from("tasks").select("id, root_task_id").eq("id", taskId).maybeSingle();
  if (!task) return { roles: [], links: [] };
  const { data: places } = await supabase
    .from("task_projects")
    .select("project_id, project:projects!inner(name)")
    .eq("task_id", task.root_task_id ?? task.id)
    .is("deleted_at", null);
  const projectIds = (places ?? []).map((p) => p.project_id);
  if (projectIds.length === 0) return { roles: [], links: [] };
  const { data: roles, error } = await supabase
    .from("project_roles")
    .select("id, name, project_id, profile_id, sort_order")
    .in("project_id", projectIds)
    .is("deleted_at", null)
    .order("sort_order");
  if (error || !roles?.length) return { roles: [], links: [] };
  const people = [...new Set(roles.map((r) => r.profile_id).filter((x): x is string => Boolean(x)))];
  const { data: profiles } = people.length
    ? await supabase.from("profiles").select("id, full_name, email").in("id", people)
    : { data: [] as { id: string; full_name: string | null; email: string }[] };
  const nameOf = new Map((profiles ?? []).map((p) => [p.id, p.full_name || p.email] as const));
  const projectName = new Map(
    (places ?? []).map((p) => [p.project_id, (p.project as unknown as { name: string } | null)?.name ?? ""] as const),
  );
  const links = await listTaskRoleLinks(ctx, taskId);
  return {
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      projectName: projectName.get(r.project_id) ?? "",
      personName: r.profile_id ? (nameOf.get(r.profile_id) ?? null) : null,
    })),
    links: links.filter((l) => roles.some((r) => r.id === l.roleId)),
  };
}

// Links (or unlinks) a project role to a task's assignee / approver / follower and applies its person.
export async function setTaskRoleLink(
  ctx: ApiContext,
  taskId: string,
  roleId: string,
  slot: "assignee" | "approver" | "follower",
  linked: boolean,
): Promise<void> {
  if (slot !== "assignee" && slot !== "approver" && slot !== "follower") throw invalid("Choose assignee, approver, or follower");
  const supabase = ctx.db;
  const saved = await supabase.rpc("set_task_role_link", {
    target_task: id(taskId, "task"),
    target_role: id(roleId, "role"),
    link_slot: slot,
    linked: Boolean(linked),
  });
  if (saved.error?.code === "PGRST202") throw invalid(ROLES_MISSING);
  check(saved);
}
