// Workspace people, settings, and project visibility (Asana feel, batch 2). Shared by the browser and
// the server; mirrors 20261008030000_asana_feel_2.sql.

// Public bucket for the workspace logo; objects live under "<workspace id>/". Images only, 2 MB.
export const WORKSPACE_ASSETS_BUCKET = "workspace-assets";
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export function logoObjectPath(workspaceId: string, fileName: string) {
  const ext = fileName.toLowerCase().match(/\.(png|jpe?g|webp|gif)$/)?.[1] ?? "png";
  return `${workspaceId}/logo-${crypto.randomUUID()}.${ext === "jpeg" ? "jpg" : ext}`;
}

// Mirrors the workspaces.email_sender_name CHECK: 1–60 characters, nothing that could forge an address.
export const SENDER_NAME_MAX = 60;
export function senderNameProblem(value: string): string | null {
  if (value.length > SENDER_NAME_MAX) return `Keep the sender name under ${SENDER_NAME_MAX} characters`;
  if (/[<>"\\\r\n,;]/.test(value)) return "The sender name can’t contain < > \" \\ , ; or line breaks";
  return null;
}

// projects.visibility (CHECK projects_visibility_check).
export const PROJECT_VISIBILITIES = ["team", "private"] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];
export const VISIBILITY_LABELS: Record<ProjectVisibility, string> = {
  team: "Public to team",
  private: "Private to members",
};
export const VISIBILITY_DESCRIPTIONS: Record<ProjectVisibility, string> = {
  team: "Everyone on the team can find it on Browse projects and join as an Editor.",
  private: "Only people you invite can find or open it.",
};
export function isProjectVisibility(value: unknown): value is ProjectVisibility {
  return typeof value === "string" && (PROJECT_VISIBILITIES as readonly string[]).includes(value);
}

export type WorkspaceRole = "admin" | "member";
export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = { admin: "Admin", member: "Member" };

export type MemberStatus = "active" | "invited" | "removed";

export type InviteEmailStatus = {
  status: string;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
};

export type WorkspaceMember = {
  // Oct 25 notes: the project role "default" adds them as (null = Editor; undefined = a database without
  // the update).
  defaultProjectRole?: string | null;
  email: string;
  profileId: string | null;
  name: string;
  role: WorkspaceRole;
  status: MemberStatus;
  teams: { id: string; name: string }[];
  invitedAt: string | null;
  invitedByName: string | null;
  // When the address was put on the allowlist (the invite date for people added before invites were
  // recorded, e.g. in SQL).
  addedAt: string;
  removedAt: string | null;
  // Workspace admins only (RLS): the latest invite email to this address.
  inviteEmail: InviteEmailStatus | null;
};

export function describeInviteEmail(email: InviteEmailStatus | null): string | null {
  if (!email) return null;
  switch (email.status) {
    case "sent":
      return "Invite email sent";
    case "mocked":
      return "Invite email not sent (no email provider)";
    case "failed":
      return email.lastError ? `Invite email failed: ${email.lastError}` : "Invite email failed";
    case "sending":
      return "Sending invite email…";
    default:
      return email.lastError ? `Invite email retrying: ${email.lastError}` : "Invite email queued";
  }
}

export type InviteResult = { email: string; status: "invited" | "restored" | "already_member" | "already_invited" };

export function parseInviteResult(value: unknown): InviteResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const status = v.status;
  if (typeof v.email !== "string") return null;
  if (status !== "invited" && status !== "restored" && status !== "already_member" && status !== "already_invited") return null;
  return { email: v.email, status };
}

export function describeInvites(results: InviteResult[]): string {
  const sent = results.filter((r) => r.status === "invited" || r.status === "restored").length;
  const skipped = results.length - sent;
  const parts = [];
  if (sent) parts.push(`Invited ${sent} ${sent === 1 ? "person" : "people"}`);
  if (skipped) parts.push(`${skipped} already in the workspace`);
  return parts.join(" · ") || "No changes";
}

// Splits a pasted list ("a@x.com, b@y.com; c@z.com") into distinct lowercase addresses.
export function splitEmails(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type PendingInvite = {
  id: string;
  email: string;
  role: string;
  invitedAt: string;
  invitedByName: string | null;
  // The latest invite email for it (Real features 1; only the people who manage the invite read it) and
  // when it was queued — Resend waits 10 minutes after that (RESEND_INVITE_MINUTES).
  inviteEmail: InviteEmailStatus | null;
  lastEmailAt: string | null;
};

// How long Resend waits after an invite email (mirrors guard_pending_membership()).
export const RESEND_INVITE_MINUTES = 10;

// Who can be added by email (projects, portfolios, teams, Share): anyone in the workspace; a workspace
// admin can also add an address that isn't in it yet (Real features 1: it joins the workspace too).
// `invitesEmailed` is false before Real features 1's database update (no invite emails, no new addresses).
export function inviteHelp(isWorkspaceAdmin: boolean, invitesEmailed: boolean): string {
  if (!invitesEmailed) {
    return "Anyone in the workspace can be added; people who haven’t signed in yet join on their first sign-in.";
  }
  return isWorkspaceAdmin
    ? "Anyone in the workspace can be added. You’re a workspace admin, so a new email address works too: it joins the workspace. People who haven’t signed in yet get an invite email and join when they sign up."
    : "Anyone in the workspace can be added. People who haven’t signed in yet get an invite email and join when they sign up. To add someone new to the workspace, ask a workspace admin.";
}

// The note after inviting someone who hasn't signed in yet. `where` reads like "this project".
export function describePendingInvite(
  address: string,
  where: string,
  outcome: { emailed?: boolean; alreadyInvited?: boolean; joinedWorkspace?: boolean },
): string {
  if (outcome.alreadyInvited) {
    return `${address} already has an invite to ${where}; it now has the role you picked.`;
  }
  const joined = outcome.joinedWorkspace ? " and added them to the workspace" : "";
  return outcome.emailed
    ? `Invited ${address}${joined}. We emailed them a sign-up link; they’ll join ${where} when they sign up.`
    : `Invited ${address}${joined}. They’ll join ${where} on their first sign-in. No invite email went out this time, so let them know.`;
}

export type BrowseProject = {
  projectId: string;
  name: string;
  description: string | null;
  teamId: string;
  teamName: string;
  visibility: ProjectVisibility;
  status: string;
  archived: boolean;
  memberCount: number;
  myRole: string | null;
};

export const ONLY_ADMINS_NOTE = "Only workspace admins can change this.";
