"use server";
// Big move 1: the members area's Server Actions (project members, pending invites, project roles), thin
// wrappers around src/lib/api/members/mutations.ts. Only what Next.js does (redirects, the email switch,
// the request's context) stays here.
import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/api/core/result";
import type { InviteActionResult, TaskRolesInfo } from "@/lib/api/members/model";
import * as membersApi from "@/lib/api/members/mutations";
import type { RoleUsage } from "@/lib/api/projects/model";
import { countOpenRoleTasks, loadRoleUsage } from "@/lib/api/projects/queries";
import { isEmailConfigured } from "@/lib/email";
import { run, runWith } from "@/lib/server/action";
import { actionContext } from "@/lib/server/context";

// ---------------------------------------------------------------------------------------------
// Members (all checks — role, allowlist, last owner — live in the SQL RPCs)
// ---------------------------------------------------------------------------------------------

export async function inviteProjectMember(
  projectId: string,
  email: string,
  memberRole: string,
): Promise<InviteActionResult> {
  return runWith((ctx) =>
    membersApi.inviteProjectMember(ctx, projectId, email, memberRole, { emailConfigured: isEmailConfigured() }),
  );
}

// Cancels a pending invite (project / portfolio Admin+, team leads and workspace admins; RLS decides).
export async function cancelPendingInvite(inviteId: string): Promise<ActionResult> {
  return run((ctx) => membersApi.cancelPendingInvite(ctx, inviteId));
}

// Sends a pending invite's email again (Real features 1); the email goes out right after the response
// like every queued email.
export async function resendPendingInvite(inviteId: string): Promise<ActionResult> {
  return run((ctx) => membersApi.resendPendingInvite(ctx, inviteId));
}

// The bulk bar's "Add <name> to this project and assign?".
export async function addProjectMemberByProfile(
  projectId: string,
  profileId: string,
  memberRole = "editor",
): Promise<ActionResult> {
  return run((ctx) => membersApi.addProjectMemberByProfile(ctx, projectId, profileId, memberRole));
}

export async function changeProjectMemberRole(
  projectId: string,
  profileId: string,
  memberRole: string,
): Promise<ActionResult> {
  return run((ctx) => membersApi.changeProjectMemberRole(ctx, projectId, profileId, memberRole));
}

export async function removeProjectMember(projectId: string, profileId: string): Promise<ActionResult> {
  return run((ctx) => membersApi.removeProjectMember(ctx, projectId, profileId));
}

// Leaving loses access, so send the person home instead of re-rendering a project they can't see.
export async function leaveProject(projectId: string, profileId: string): Promise<ActionResult> {
  const result = await removeProjectMember(projectId, profileId);
  if (!result.error) redirect("/");
  return result;
}

export async function transferProjectOwnership(projectId: string, profileId: string): Promise<ActionResult> {
  return run((ctx) => membersApi.transferProjectOwnership(ctx, projectId, profileId));
}

// ---------------------------------------------------------------------------------------------
// Project roles (Nov 2 notes, batch 14, 95)
// ---------------------------------------------------------------------------------------------

export async function createProjectRole(projectId: string, name: string, profileId: string | null = null): Promise<ActionResult> {
  return run((ctx) => membersApi.createProjectRole(ctx, projectId, name, profileId));
}

export async function renameProjectRole(roleId: string, name: string): Promise<ActionResult> {
  return run((ctx) => membersApi.renameProjectRole(ctx, roleId, name));
}

export async function removeProjectRole(roleId: string): Promise<ActionResult> {
  return run((ctx) => membersApi.removeProjectRole(ctx, roleId));
}

// Who fills a role; with updateOpenTasks, the open tasks linked to it follow. Returns how many tasks
// changed and how many couldn't.
export async function setProjectRolePerson(
  roleId: string,
  profileId: string | null,
  updateOpenTasks: boolean,
): Promise<ActionResult & { updated?: number; skipped?: number }> {
  return runWith((ctx) => membersApi.setProjectRolePerson(ctx, roleId, profileId, updateOpenTasks));
}

// How many open tasks follow a role (asked before changing its person).
export async function loadRoleOpenTaskCount(roleId: string): Promise<number> {
  return countOpenRoleTasks(await actionContext(), roleId);
}

// Nov 3 notes (batch 19, 146): the open tasks and automations that follow a role, listed in the prompt.
export async function loadRoleUsageForChange(roleId: string): Promise<RoleUsage> {
  return loadRoleUsage(await actionContext(), roleId);
}

// The task pane's Roles row: the roles a task can take people from and its links.
export async function loadTaskRoles(taskId: string): Promise<TaskRolesInfo> {
  return membersApi.loadTaskRoles(await actionContext(), taskId);
}

// Links (or unlinks) a project role to a task's assignee / approver / follower and applies its person.
export async function setTaskRoleLink(
  taskId: string,
  roleId: string,
  slot: "assignee" | "approver" | "follower",
  linked: boolean,
): Promise<ActionResult> {
  return run((ctx) => membersApi.setTaskRoleLink(ctx, taskId, roleId, slot, linked));
}
