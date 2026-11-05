// Big move 1: the workspace area's writes (workspace admins, members and invites, workspace settings and
// switches, verified domains). Every function takes the caller's ApiContext first, validates its own input,
// writes only through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no Next.js here.
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { invalid } from "../core/errors";
import { email, id, optionalText, text } from "../core/validate";
import type { Workspace } from "./model";
import { getWorkspace } from "./queries";
import { isDefaultProjectRole } from "../../roles";
import type { TablesUpdate } from "../../supabase/database.types";
import { normalizeDomainInput } from "../../verified-domains";
import { normalizeWorkWeek } from "../../workdays";
import {
  EMAIL_PATTERN,
  LOGO_MAX_BYTES,
  WORKSPACE_ASSETS_BUCKET,
  parseInviteResult,
  senderNameProblem,
  splitEmails,
  type InviteResult,
} from "../../workspace";

async function currentWorkspace(ctx: ApiContext): Promise<Workspace> {
  const workspace = await getWorkspace(ctx);
  if (!workspace) throw invalid("No workspace found");
  return workspace;
}

// ---------------------------------------------------------------------------------------------
// Workspace admins (Settings → Workspace). Admins add and remove admins; the last one stays.
// ---------------------------------------------------------------------------------------------

export async function addWorkspaceAdmin(ctx: ApiContext, memberEmail: string): Promise<void> {
  const address = email(memberEmail);
  const workspace = await currentWorkspace(ctx);
  const supabase = ctx.db;
  check(await supabase.rpc("add_workspace_admin", { target_workspace: workspace.id, member_email: address }));
}

export async function removeWorkspaceAdmin(ctx: ApiContext, profileId: string): Promise<void> {
  const workspace = await currentWorkspace(ctx);
  const supabase = ctx.db;
  check(await supabase.rpc("remove_workspace_admin", { target_workspace: workspace.id, target_profile: id(profileId) }));
}

// ---------------------------------------------------------------------------------------------
// Workspace members and settings (Asana feel, batch 2). Workspace admins only; the database checks.
// The invite email goes through the email outbox (drained after the response, like every email).
// ---------------------------------------------------------------------------------------------

const WORKSPACE_ADMINS_ONLY = "Only workspace admins can change this";

// Invites one address at a time; each invite stands on its own, so `results` (filled as each one lands)
// tells a caller which ones went through even when a later one is refused. Answers `results`.
export async function inviteToWorkspace(
  ctx: ApiContext,
  emails: string,
  results: InviteResult[] = [],
): Promise<InviteResult[]> {
  const addresses = splitEmails(emails);
  if (addresses.length === 0) throw invalid("Enter at least one email address");
  if (addresses.length > 50) throw invalid("Invite at most 50 people at a time");
  const bad = addresses.find((a) => a.length > 320 || !EMAIL_PATTERN.test(a));
  if (bad) throw invalid(`“${bad}” isn’t a valid email address`);
  const supabase = ctx.db;
  for (const address of addresses) {
    const invited = await supabase.rpc("invite_to_workspace", { member_email: address });
    check(invited, WORKSPACE_ADMINS_ONLY);
    const parsed = parseInviteResult(invited.data);
    if (parsed) results.push(parsed);
  }
  return results;
}

export async function resendWorkspaceInvite(ctx: ApiContext, address: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("resend_workspace_invite", { member_email: email(address) }), WORKSPACE_ADMINS_ONLY);
}

export async function removeWorkspaceMember(ctx: ApiContext, address: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("remove_workspace_member", { member_email: email(address) }), WORKSPACE_ADMINS_ONLY);
}

export async function updateWorkspaceSettings(
  ctx: ApiContext,
  patch: {
    name?: string;
    emailSenderName?: string | null;
    defaultTeamId?: string;
  },
): Promise<void> {
  const workspace = await currentWorkspace(ctx);
  const update: TablesUpdate<"workspaces"> = {};
  if (patch.name !== undefined) update.name = text(patch.name, "Workspace name", { max: 100 });
  if (patch.emailSenderName !== undefined) {
    const sender = optionalText(patch.emailSenderName, 200);
    const problem = sender ? senderNameProblem(sender) : null;
    if (problem) throw invalid(problem);
    update.email_sender_name = sender;
  }
  if (patch.defaultTeamId !== undefined) update.default_team_id = id(patch.defaultTeamId, "team");
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("workspaces").update(update).eq("id", workspace.id).select("id"),
    WORKSPACE_ADMINS_ONLY,
  );
}

// The browser uploads the logo to the workspace-assets bucket (admins only, by Storage policy), then
// records its path here; null removes the logo.
export async function setWorkspaceLogo(ctx: ApiContext, path: string | null, size?: number): Promise<void> {
  const workspace = await currentWorkspace(ctx);
  if (path !== null) {
    if (typeof path !== "string" || !path.startsWith(`${workspace.id}/`) || path.length > 300) {
      throw invalid("Upload the logo again");
    }
    if (size !== undefined && size > LOGO_MAX_BYTES) throw invalid("The logo must be 2 MB or smaller");
  }
  const supabase = ctx.db;
  const previous = workspace.logoPath;
  checkUpdated(
    await supabase.from("workspaces").update({ logo_path: path }).eq("id", workspace.id).select("id"),
    WORKSPACE_ADMINS_ONLY,
  );
  // The bucket is public, so a replaced logo shouldn't stay reachable. Workspace admins may remove
  // their workspace's files (security review pass 2); a database without that policy leaves the file.
  if (previous && previous !== path && previous.startsWith(`${workspace.id}/`)) {
    await supabase.storage.from(WORKSPACE_ASSETS_BUCKET).remove([previous]);
  }
}

// A person's default project role (Admin console → Users; workspace admins only — the database checks):
// Viewer, Commenter, or Editor, or null to go back to Editor.
export async function setDefaultProjectRole(ctx: ApiContext, memberEmail: string, newRole: string | null): Promise<void> {
  const address = email(memberEmail);
  if (newRole !== null && !isDefaultProjectRole(newRole)) throw invalid("Choose Viewer, Commenter, or Editor");
  const supabase = ctx.db;
  const result = await supabase.rpc("set_default_project_role", { member_email: address, new_role: newRole });
  if (result.error?.code === "PGRST202") throw invalid("Default project roles need this release’s database update");
  check(result, WORKSPACE_ADMINS_ONLY);
}

// Oct 26 notes (batch 3): the workspace's Tags switch (Admin console → Tags; workspace admins, RLS and the
// column grant decide). Off only hides tags; nothing is removed.
export async function setTagsEnabled(ctx: ApiContext, enabled: boolean): Promise<void> {
  const workspace = await currentWorkspace(ctx);
  const supabase = ctx.db;
  const result = await supabase
    .from("workspaces")
    .update({ tags_enabled: enabled === true })
    .eq("id", workspace.id)
    .select("id");
  if (result.error?.code === "42703" || result.error?.code === "PGRST204") {
    throw invalid("This setting needs this release’s database update");
  }
  checkUpdated(result, WORKSPACE_ADMINS_ONLY);
}

// Nov 2 notes (batch 13, note 88): the workspace's Goals switch (Admin console → Organization; workspace
// admins, RLS and the column grant decide). Off only hides goals; nothing is removed. (Every page's
// sidebar and Create menu change, so the caller drops its cached copies of them too.)
export async function setGoalsEnabled(ctx: ApiContext, enabled: boolean): Promise<void> {
  const workspace = await currentWorkspace(ctx);
  const supabase = ctx.db;
  const result = await supabase
    .from("workspaces")
    .update({ goals_enabled: enabled === true })
    .eq("id", workspace.id)
    .select("id");
  if (result.error?.code === "42703" || result.error?.code === "PGRST204") {
    throw invalid("This setting needs this release’s database update");
  }
  checkUpdated(result, WORKSPACE_ADMINS_ONLY);
}

// The Commenter project role (Admin console → Security; workspace admins, RLS and the column grant
// decide). Turning it off never changes anyone's role.
export async function setCommenterRoleAllowed(ctx: ApiContext, allowed: boolean): Promise<void> {
  const workspace = await currentWorkspace(ctx);
  const supabase = ctx.db;
  const result = await supabase
    .from("workspaces")
    .update({ allow_commenter_role: allowed === true })
    .eq("id", workspace.id)
    .select("id");
  if (result.error?.code === "42703" || result.error?.code === "PGRST204") {
    throw invalid("This setting needs this release’s database update");
  }
  checkUpdated(result, WORKSPACE_ADMINS_ONLY);
}

// One click: someone's Commenter memberships become Viewer or Editor (workspace admins only).
export async function convertCommenterMember(ctx: ApiContext, profileId: string, role: "viewer" | "editor"): Promise<void> {
  if (role !== "viewer" && role !== "editor") throw invalid("Choose Viewer or Editor");
  const supabase = ctx.db;
  const result = await supabase.rpc("convert_commenter_members", { target_profile: id(profileId, "person"), new_role: role });
  check(result, WORKSPACE_ADMINS_ONLY);
}

// The organization's workweek (Admin console → Organization; workspace admins, RLS and the column grant
// decide).
export async function setWorkWeek(ctx: ApiContext, days: number[]): Promise<void> {
  if (
    !Array.isArray(days) ||
    days.length < 1 ||
    days.length > 7 ||
    days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
    new Set(days).size !== days.length
  ) {
    throw invalid("Choose 1 to 7 different days of the week");
  }
  const workspace = await currentWorkspace(ctx);
  const supabase = ctx.db;
  const result = await supabase
    .from("workspaces")
    .update({ work_week: normalizeWorkWeek(days) })
    .eq("id", workspace.id)
    .select("id");
  if (result.error?.code === "42703" || result.error?.code === "PGRST204") {
    throw invalid("The workweek needs this release’s database update");
  }
  checkUpdated(result, WORKSPACE_ADMINS_ONLY);
}

// ---------------------------------------------------------------------------------------------
// Nov 1 notes, item 69: Admin console → Security → Verified domains (workspace admins; RLS decides).
// ---------------------------------------------------------------------------------------------

export async function addVerifiedDomain(ctx: ApiContext, domain: string): Promise<void> {
  const workspace = await currentWorkspace(ctx);
  const clean = normalizeDomainInput(domain);
  if (!clean) throw invalid("Enter a domain like example.com");
  const supabase = ctx.db;
  const result = await supabase.from("verified_email_domains").insert({ workspace_id: workspace.id, domain: clean });
  if (result.error?.code === "23505") throw invalid(`${clean} is already a verified domain`);
  if (result.error?.code === "PGRST205" || result.error?.code === "42P01") {
    throw invalid("Verified domains need this release’s database update");
  }
  check(result, WORKSPACE_ADMINS_ONLY);
}

export async function removeVerifiedDomain(ctx: ApiContext, domainId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("verified_email_domains")
      .update({ removed_at: nowIso() })
      .eq("id", id(domainId, "domain"))
      .is("removed_at", null)
      .select("id"),
    WORKSPACE_ADMINS_ONLY,
  );
}

export async function setVerifiedDomainConversations(ctx: ApiContext, on: boolean): Promise<void> {
  const workspace = await currentWorkspace(ctx);
  const supabase = ctx.db;
  const result = await supabase
    .from("workspaces")
    .update({ verified_domain_conversations: on === true })
    .eq("id", workspace.id)
    .select("id");
  if (result.error?.code === "42703" || result.error?.code === "PGRST204") {
    throw invalid("This setting needs this release’s database update");
  }
  checkUpdated(result, WORKSPACE_ADMINS_ONLY);
}
