// Big move 1: the workspace area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "@/lib/api/core/context";
import { isMissingColumn, maybe, rows } from "@/lib/api/core/db";
import { deliveryStatuses } from "@/lib/api/task-pane/queries";
import type {
  CommenterMember,
  InviteDelivery,
  MemberActivity,
  VerifiedDomain,
  Workspace,
} from "@/lib/api/workspace/model";
import { displayName } from "@/lib/people";
import { DEFAULT_WORK_WEEK, normalizeWorkWeek } from "@/lib/workdays";
import {
  type InviteEmailStatus,
  type PendingInvite,
  WORKSPACE_ASSETS_BUCKET,
  type WorkspaceMember,
} from "@/lib/workspace";

export const getWorkspace = read(async (ctx: ApiContext): Promise<Workspace | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("workspaces")
    .select("id, name, default_team_id, logo_path, email_sender_name")
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const row = maybe(result, "workspace");
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    defaultTeamId: row.default_team_id,
    logoPath: row.logo_path,
    logoUrl: row.logo_path ? supabase.storage.from(WORKSPACE_ASSETS_BUCKET).getPublicUrl(row.logo_path).data.publicUrl : null,
    emailSenderName: row.email_sender_name,
  };
});

// The workspace's workweek for business days (Sunday–Thursday until an admin changes it).
export const getWorkWeek = read(async (ctx: ApiContext): Promise<number[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("workspaces")
    .select("work_week")
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (result.error || !result.data) return [...DEFAULT_WORK_WEEK];
  return normalizeWorkWeek((result.data as { work_week?: unknown }).work_week);
});

export const isWorkspaceAdmin = read(async (ctx: ApiContext): Promise<boolean> => {
  const supabase = ctx.db;
  return maybe(await supabase.rpc("is_workspace_admin", {}), "workspace admin check") === true;
});

// ---------------------------------------------------------------------------------------------
// Workspace people (Asana feel, batch 2): the allowlist is readable by everyone allowlisted, so the
// Members page reads it with the viewer's client. Invite email status comes back for workspace admins
// only (RLS on email_outbox).
// ---------------------------------------------------------------------------------------------

export const listWorkspaceMembers = read(async (ctx: ApiContext): Promise<WorkspaceMember[]> => {
  const supabase = ctx.db;
  const workspace = await getWorkspace(ctx);
  const [allowed, profiles, admins, teamRows, invites, defaults] = await Promise.all([
    supabase
      .from("allowed_emails")
      .select("email, invited_at, removed_at, created_at, inviter:profiles!allowed_emails_invited_by_fkey(full_name)")
      .order("email"),
    supabase.from("profiles").select("id, email, full_name, joined_at"),
    workspace
      ? supabase.from("workspace_admins").select("profile_id").eq("workspace_id", workspace.id).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("team_members")
      .select("profile_id, team:teams!team_members_team_id_fkey!inner(id, name, deleted_at)")
      .is("deleted_at", null)
      .is("team.deleted_at", null),
    supabase
      .from("email_outbox")
      .select("to_email, status, last_error, sent_at, created_at")
      .is("task_id", null)
      .eq("payload->>kind", "invite")
      .order("created_at", { ascending: false })
      .limit(500),
    // Oct 25 notes: each person's default project role (an error = a database without the update).
    supabase.from("allowed_emails").select("email, default_project_role"),
  ]);
  const defaultRoles = defaults.error
    ? null
    : new Map((defaults.data ?? []).map((d) => [d.email, d.default_project_role] as const));
  const byEmail = new Map(rows(profiles, "people").map((p) => [p.email.toLowerCase(), p] as const));
  const adminIds = new Set(rows(admins, "workspace admins").map((a) => a.profile_id));
  const teamsByProfile = new Map<string, { id: string; name: string }[]>();
  for (const m of rows(teamRows, "team memberships")) {
    const list = teamsByProfile.get(m.profile_id) ?? [];
    list.push({ id: m.team.id, name: m.team.name });
    teamsByProfile.set(m.profile_id, list);
  }
  const latestInvite = new Map<string, WorkspaceMember["inviteEmail"]>();
  for (const o of rows(invites, "invite emails")) {
    if (!latestInvite.has(o.to_email)) {
      latestInvite.set(o.to_email, { status: o.status, lastError: o.last_error, sentAt: o.sent_at, createdAt: o.created_at });
    }
  }
  return rows(allowed, "workspace members")
    .map((a): WorkspaceMember => {
      const profile = byEmail.get(a.email) ?? null;
      return {
        email: a.email,
        profileId: profile?.id ?? null,
        name: profile?.full_name?.trim() || a.email,
        role: profile && adminIds.has(profile.id) ? "admin" : "member",
        // Active once they've signed in with a confirmed address (profiles.joined_at); a profile alone can
        // be an unconfirmed sign-up.
        status: a.removed_at ? "removed" : profile?.joined_at ? "active" : "invited",
        teams: profile ? (teamsByProfile.get(profile.id) ?? []).sort((x, y) => x.name.localeCompare(y.name)) : [],
        invitedAt: a.invited_at,
        invitedByName: a.inviter?.full_name?.trim() || null,
        addedAt: a.created_at,
        removedAt: a.removed_at,
        inviteEmail: latestInvite.get(a.email) ?? null,
        defaultProjectRole: defaultRoles ? (defaultRoles.get(a.email) ?? null) : undefined,
      };
    })
    .sort((x, y) => Number(y.role === "admin") - Number(x.role === "admin") || x.name.localeCompare(y.name));
});

// Pending invites (people who haven't signed in yet) for one project, portfolio, or team. RLS: with
// the target (project / portfolio Viewer+, teams: everyone allowlisted).
export const listPendingInvites = read(
  async (ctx: ApiContext, target: "project" | "portfolio" | "team", targetId: string): Promise<PendingInvite[]> => {
    const supabase = ctx.db;
    const column = target === "project" ? "project_id" : target === "portfolio" ? "portfolio_id" : "team_id";
    const result = await supabase
      .from("pending_memberships")
      .select("id, email, role, created_at, inviter:profiles!pending_memberships_created_by_fkey(full_name)")
      .eq(column, targetId)
      .is("applied_at", null)
      .is("deleted_at", null)
      .order("created_at");
    const invites = rows(result, "pending invites");
    // Their invite emails (Real features 1; the outbox policy shows them only to the people who manage
    // the invite, so everyone else just sees "Invited").
    const emails = invites.length
      ? await supabase
          .from("email_outbox")
          .select("payload, status, last_error, sent_at, created_at")
          .is("task_id", null)
          .eq("payload->>kind", "invite")
          .in(
            "payload->>pending_id",
            invites.map((r) => r.id),
          )
          .order("created_at", { ascending: false })
      : { data: [], error: null };
    const latest = new Map<string, InviteEmailStatus>();
    for (const o of emails.data ?? []) {
      const pendingId = o.payload && typeof o.payload === "object" && !Array.isArray(o.payload) ? o.payload.pending_id : null;
      if (typeof pendingId === "string" && !latest.has(pendingId)) {
        latest.set(pendingId, { status: o.status, lastError: o.last_error, sentAt: o.sent_at, createdAt: o.created_at });
      }
    }
    return invites.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      invitedAt: r.created_at,
      invitedByName: r.inviter?.full_name?.trim() || null,
      inviteEmail: latest.get(r.id) ?? null,
      lastEmailAt: latest.get(r.id)?.createdAt ?? null,
    }));
  },
);

// When each allowlisted address last signed in (Admin console → Users). Null when the viewer isn't a
// workspace admin, or on a database without 20261012050000_asana_parity_5.sql.
const listWorkspaceMemberActivity = read(async (ctx: ApiContext): Promise<Map<string, string | null> | null> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("list_workspace_member_activity");
  if (result.error && ["PGRST202", "42501", "42883"].includes(result.error.code ?? "")) return null;
  return new Map(rows(result, "member activity").map((r) => [r.email.toLowerCase(), r.last_sign_in_at] as const));
});

// Each allowlisted person's last sign-in and last activity (Admin console → Users), by lowercased
// address: list_member_last_activity (Real features 2) — workspace admins get everyone. Falls back to
// sign-ins only (activeAt undefined → the UI says so) on a database without it; null when the viewer
// isn't a workspace admin or neither function exists.
export const listMemberLastActivity = read(
  async (ctx: ApiContext): Promise<{ byEmail: Map<string, MemberActivity>; activityTracked: boolean } | null> => {
    const supabase = ctx.db;
    const result = await supabase.rpc("list_member_last_activity", {});
    if (!result.error) {
      return {
        byEmail: new Map(
          (result.data ?? []).map((r) => [r.email.toLowerCase(), { signedInAt: r.last_sign_in_at, activeAt: r.last_active_at }] as const),
        ),
        activityTracked: true,
      };
    }
    if (!["PGRST202", "42883"].includes(result.error.code ?? "")) {
      throw new Error(`Failed to load member activity: ${result.error.message}`);
    }
    const signIns = await listWorkspaceMemberActivity(ctx);
    if (!signIns) return null;
    return {
      byEmail: new Map([...signIns].map(([email, at]) => [email, { signedInAt: at, activeAt: null }] as const)),
      activityTracked: false,
    };
  },
);

// The latest workspace invite emails (Admin console → Email). RLS: workspace admins read invite rows;
// everyone else gets none.
export const listInviteDeliveries = read(async (ctx: ApiContext, limit = 50): Promise<InviteDelivery[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("email_outbox")
    .select("id, to_email, status, attempts, max_attempts, last_error, sent_at, created_at")
    .is("task_id", null)
    .eq("payload->>kind", "invite")
    .order("created_at", { ascending: false })
    .limit(limit);
  const invites = rows(result, "invite emails");
  const delivery = await deliveryStatuses(ctx, invites.map((r) => r.id));
  return invites.map((r) => ({
    id: r.id,
    email: r.to_email,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastError: r.last_error,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    deliveryStatus: delivery.get(r.id) ?? null,
  }));
});

// ---------------------------------------------------------------------------------------------
// Email designs (20261019010000_email_designs.sql): the workspace defaults of each kind, a project's
// overrides, and its forms' overrides — whatever RLS lets the viewer read. null = a database without
// the update (the pages say so).
// ---------------------------------------------------------------------------------------------

// Whether the Commenter project role is offered (Admin console → Security). A database without the
// update keeps the old behavior (offered).
export const commenterRoleAllowed = read(async (ctx: ApiContext): Promise<boolean> => {
  const workspace = await getWorkspace(ctx);
  if (!workspace) return true;
  const supabase = ctx.db;
  const { data, error } = await supabase.from("workspaces").select("allow_commenter_role").eq("id", workspace.id).maybeSingle();
  if (error) {
    if (isMissingColumn(error)) return true;
    throw new Error(`Failed to load the Commenter setting: ${error.message}`);
  }
  return data?.allow_commenter_role ?? true;
});

// Workspace admins: everyone who holds the Commenter role somewhere (list_commenter_members). Empty
// for anyone else or without the update.
export const listCommenterMembers = read(async (ctx: ApiContext): Promise<CommenterMember[]> => {
  const supabase = ctx.db;
  const { data, error } = await supabase.rpc("list_commenter_members");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42501") return [];
    throw new Error(`Failed to load Commenters: ${error.message}`);
  }
  return (data ?? []).map((r) => ({
    profileId: r.profile_id,
    name: displayName({ full_name: r.full_name, email: r.email }),
    email: r.email,
    projectCount: r.project_count,
    projects: Array.isArray(r.projects)
      ? (r.projects as { id?: unknown; name?: unknown }[]).flatMap((p) =>
          typeof p?.id === "string" && typeof p?.name === "string" ? [{ id: p.id, name: p.name }] : [],
        )
      : [],
  }));
});

// The workspace's verified domains and its "only verified domains get email conversations" switch.
// Null without this release's database update.
export const getVerifiedDomainSettings = read(
  async (ctx: ApiContext): Promise<{ conversationsVerifiedOnly: boolean; domains: VerifiedDomain[] } | null> => {
    const workspace = await getWorkspace(ctx);
    if (!workspace) return null;
    const supabase = ctx.db;
    const [setting, domains] = await Promise.all([
      supabase.from("workspaces").select("verified_domain_conversations").eq("id", workspace.id).maybeSingle(),
      supabase
        .from("verified_email_domains")
        .select("id, domain, created_at")
        .eq("workspace_id", workspace.id)
        .is("removed_at", null)
        .order("domain"),
    ]);
    if (setting.error || domains.error) return null;
    return {
      conversationsVerifiedOnly: setting.data?.verified_domain_conversations ?? true,
      domains: (domains.data ?? []).map((d) => ({ id: d.id, domain: d.domain, createdAt: d.created_at })),
    };
  },
);
