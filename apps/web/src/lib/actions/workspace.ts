"use server";
// Big move 1: the workspace area's Server Actions, thin wrappers around packages/core/src/api/workspace/mutations.ts.
// Only what Next.js does (cached pages, the request's context) stays here.
import type { ActionResult } from "@alhc/core/api/core/result";
import * as workspaceApi from "@alhc/core/api/workspace/mutations";
import { run } from "@/lib/server/action";
import type { InviteResult } from "@alhc/core/workspace";

// ---------------------------------------------------------------------------------------------
// Workspace admins
// ---------------------------------------------------------------------------------------------

export async function addWorkspaceAdmin(email: string): Promise<ActionResult> {
  return run((ctx) => workspaceApi.addWorkspaceAdmin(ctx, email));
}

export async function removeWorkspaceAdmin(profileId: string): Promise<ActionResult> {
  return run((ctx) => workspaceApi.removeWorkspaceAdmin(ctx, profileId));
}

// ---------------------------------------------------------------------------------------------
// Workspace members and settings
// ---------------------------------------------------------------------------------------------

// The invites made before a refusal still come back next to the error.
export async function inviteToWorkspace(emails: string): Promise<ActionResult & { results?: InviteResult[] }> {
  const results: InviteResult[] = [];
  const outcome = await run((ctx) => workspaceApi.inviteToWorkspace(ctx, emails, results));
  return { ...outcome, results };
}

export async function resendWorkspaceInvite(address: string): Promise<ActionResult> {
  return run((ctx) => workspaceApi.resendWorkspaceInvite(ctx, address));
}

export async function removeWorkspaceMember(address: string): Promise<ActionResult> {
  return run((ctx) => workspaceApi.removeWorkspaceMember(ctx, address));
}

export async function updateWorkspaceSettings(patch: {
  name?: string;
  emailSenderName?: string | null;
  defaultTeamId?: string;
}): Promise<ActionResult> {
  return run((ctx) => workspaceApi.updateWorkspaceSettings(ctx, patch));
}

export async function setWorkspaceLogo(path: string | null, size?: number): Promise<ActionResult> {
  return run((ctx) => workspaceApi.setWorkspaceLogo(ctx, path, size));
}

export async function setDefaultProjectRole(email: string, newRole: string | null): Promise<ActionResult> {
  return run((ctx) => workspaceApi.setDefaultProjectRole(ctx, email, newRole));
}

export async function setTagsEnabled(enabled: boolean): Promise<ActionResult> {
  return run((ctx) => workspaceApi.setTagsEnabled(ctx, enabled));
}

// Nov 2 notes (batch 13, note 88): every page's sidebar and Create menu change, so drop the browser's
// cached copies too, not just this page's.
export async function setGoalsEnabled(enabled: boolean): Promise<ActionResult> {
  return run((ctx) => workspaceApi.setGoalsEnabled(ctx, enabled), { revalidate: [["/", "layout"]] });
}

export async function setCommenterRoleAllowed(allowed: boolean): Promise<ActionResult> {
  return run((ctx) => workspaceApi.setCommenterRoleAllowed(ctx, allowed));
}

export async function convertCommenterMember(profileId: string, role: "viewer" | "editor"): Promise<ActionResult> {
  return run((ctx) => workspaceApi.convertCommenterMember(ctx, profileId, role));
}

export async function setWorkWeek(days: number[]): Promise<ActionResult> {
  return run((ctx) => workspaceApi.setWorkWeek(ctx, days));
}

// ---------------------------------------------------------------------------------------------
// Verified domains (Admin console → Security)
// ---------------------------------------------------------------------------------------------

export async function addVerifiedDomain(domain: string): Promise<ActionResult> {
  return run((ctx) => workspaceApi.addVerifiedDomain(ctx, domain), { revalidate: [["/admin/security"]] });
}

export async function removeVerifiedDomain(domainId: string): Promise<ActionResult> {
  return run((ctx) => workspaceApi.removeVerifiedDomain(ctx, domainId), { revalidate: [["/admin/security"]] });
}

export async function setVerifiedDomainConversations(on: boolean): Promise<ActionResult> {
  return run((ctx) => workspaceApi.setVerifiedDomainConversations(ctx, on));
}
