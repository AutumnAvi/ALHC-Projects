// Big move 1: the me area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getViewer } from "@/lib/api/auth/queries";
import { type ApiContext, read } from "@/lib/api/core/context";
import { maybe, rpcMissing } from "@/lib/api/core/db";
import type { MySettings } from "@/lib/api/me/model";
import { listTeams } from "@/lib/api/teams/queries";
import { getWorkspace, getWorkWeek, isWorkspaceAdmin } from "@/lib/api/workspace/queries";
import { type CheckedMode, DEFAULT_CHECKED_MODE, isCheckedMode } from "@/lib/checklist";
import { DEFAULT_EMAIL_PREFERENCES, type EmailPreferences, isDigestFrequency } from "@/lib/email-schedules";
import { EMPTY_HOME_DASHBOARD, type HomeDashboard, parseHomeDashboard } from "@/lib/home";
import { myTasksLayoutOf } from "@/lib/my-tasks";
import { resolveNotificationSettings } from "@/lib/notifications";
import { DEFAULT_SUBTASK_PREFS, parseSubtaskPrefs, type SubtaskPrefs } from "@/lib/subtask-view";
import { normalizeWorkWeek } from "@/lib/workdays";

// Nov 3 notes (batch 19, 140): the viewer's own workdays (Settings → Profile → My workdays). Null = they count
// the organization's; undefined = the column isn't there yet (a preview without the migration).
export const getMyPersonalWorkWeek = read(async (ctx: ApiContext): Promise<number[] | null | undefined> => {
  const { user } = await getViewer(ctx);
  if (!user) return null;
  const supabase = ctx.db;
  const { data, error } = await supabase.from("profile_preferences").select("work_week").eq("profile_id", user.id).maybeSingle();
  if (error) return error.code === "42703" || error.code === "PGRST204" ? undefined : null;
  const days = data?.work_week ?? null;
  return days && days.length ? normalizeWorkWeek(days) : null;
});

// The person's forwarding address row (made on first use) and their latest forwarded emails (Real
// features 1). Null when this release's database update isn't applied.
export const getMyForwarding = read(
  async (ctx: ApiContext): Promise<{
    token: string;
    defaultProjectId: string | null;
    recent: { id: string; status: string; reason: string | null; taskId: string | null; projectId: string | null; attachments: number; createdAt: string }[];
    taskTitles: Map<string, string>;
  } | null> => {
    const supabase = ctx.db;
    const address = await supabase.rpc("my_forwarding_address");
    if (address.error || !address.data) return null;
    const recent = await supabase
      .from("email_forwards")
      .select("id, status, reason, task_id, project_id, attachments, created_at")
      .order("created_at", { ascending: false })
      .limit(5);
    const forwards = recent.data ?? [];
    const taskIds = forwards.flatMap((f) => (f.task_id ? [f.task_id] : []));
    const titles = taskIds.length
      ? await supabase.from("tasks").select("id, title").in("id", taskIds).is("deleted_at", null)
      : { data: [] };
    return {
      token: address.data.token,
      defaultProjectId: address.data.default_project_id,
      recent: forwards.map((f) => ({
        id: f.id,
        status: f.status,
        reason: f.reason,
        taskId: f.task_id,
        projectId: f.project_id,
        attachments: f.attachments,
        createdAt: f.created_at,
      })),
      taskTitles: new Map((titles.data ?? []).map((t) => [t.id, t.title] as const)),
    };
  },
);

// `myTasksLayout`: the my_tasks_view cookie's value (the adapter reads cookies).
export const getMySettings = read(async (ctx: ApiContext, myTasksLayout?: string): Promise<MySettings | null> => {
  const { user, allowlisted } = await getViewer(ctx);
  if (!user || !allowlisted) return null;
  const supabase = ctx.db;
  const [profile, admin, teams, workspace, notificationRows, emailPreferences, preferences] = await Promise.all([
    supabase.from("profiles").select("full_name, avatar_url, email_comments, joined_at").eq("id", user.id).maybeSingle(),
    isWorkspaceAdmin(ctx),
    listTeams(ctx),
    getWorkspace(ctx),
    supabase.from("notification_settings").select("kind, inbox, email"),
    getMyEmailPreferences(ctx),
    getProfilePreferences(ctx),
  ]);
  const [myTasksChecked, workWeek, personalWorkWeek] = await Promise.all([getMyTasksChecked(ctx), getWorkWeek(ctx), getMyPersonalWorkWeek(ctx)]);
  const layout = myTasksLayout;
  const row = maybe(profile, "profile");
  const meta = user.user_metadata ?? {};
  const email = user.email ?? "";
  const name =
    row?.full_name?.trim() || (meta.full_name as string | undefined) || (meta.name as string | undefined) || email;
  const providers = (user.app_metadata?.providers as string[] | undefined) ?? [user.app_metadata?.provider as string];
  return {
    name,
    fullName: row?.full_name?.trim() || null,
    avatarUrl: row?.avatar_url ?? null,
    email,
    isWorkspaceAdmin: admin,
    workspaceName: workspace?.name ?? "ALHC Projects",
    workspaceLogoUrl: workspace?.logoUrl ?? null,
    defaultTeamName: teams.find((team) => team.id === workspace?.defaultTeamId)?.name ?? null,
    emailSenderName: workspace?.emailSenderName ?? null,
    teams: teams.flatMap((team) => {
      const me = team.members.find((m) => m.profileId === user.id);
      return me ? [{ id: team.id, name: team.name, lead: me.role === "lead" }] : [];
    }),
    emailComments: row?.email_comments ?? true,
    notifications: notificationRows.error
      ? null
      : resolveNotificationSettings(notificationRows.data ?? [], row?.email_comments ?? true),
    emailPreferences,
    joinedAt: row?.joined_at ?? null,
    signInMethod: providers.includes("google") ? "google" : "password",
    myTasksLayout: myTasksLayoutOf(layout),
    openPersonalView: preferences.available ? preferences.openPersonalView : null,
    myTasksChecked,
    workWeek,
    personalWorkWeek,
  };
});

// The signed-in person's own app preferences.
export const getProfilePreferences = read(async (ctx: ApiContext): Promise<{ openPersonalView: boolean; available: boolean }> => {
  const supabase = ctx.db;
  const { user } = await getViewer(ctx);
  if (!user) return { openPersonalView: false, available: true };
  const row = maybe(
    await supabase.from("profile_preferences").select("open_personal_view").eq("profile_id", user.id).maybeSingle(),
    "preferences",
  );
  return { openPersonalView: row?.open_personal_view ?? false, available: true };
});

// Nov 1 notes (batch 9b): what a task ticked today does on the person's checklist ("sink" without a row,
// or on a database without this release).
export const getMyTasksChecked = read(async (ctx: ApiContext): Promise<CheckedMode> => {
  const { user } = await getViewer(ctx);
  if (!user) return DEFAULT_CHECKED_MODE;
  const supabase = ctx.db;
  const result = await supabase.from("profile_preferences").select("my_tasks_checked").eq("profile_id", user.id).maybeSingle();
  if (result.error || !result.data) return DEFAULT_CHECKED_MODE;
  const mode = (result.data as { my_tasks_checked?: unknown }).my_tasks_checked;
  return isCheckedMode(mode) ? mode : DEFAULT_CHECKED_MODE;
});

// Nov 1 notes (batch 9b): Home in one read (home_dashboard). Empty on a database without this release.
export const getHomeDashboard = read(async (ctx: ApiContext, timeZone: string): Promise<HomeDashboard> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("home_dashboard", { tz: timeZone });
  if (result.error) {
    if (!rpcMissing(result.error)) throw new Error(`Failed to load Home: ${result.error.message}`);
    return EMPTY_HOME_DASHBOARD;
  }
  return parseHomeDashboard(result.data);
});

// Oct 27 notes (batch 5): the person's Subtasks filter and sort (the defaults without a row, or on a
// database without this release).
export const getSubtaskPreferences = read(async (ctx: ApiContext): Promise<SubtaskPrefs> => {
  const { user } = await getViewer(ctx);
  if (!user) return DEFAULT_SUBTASK_PREFS;
  const supabase = ctx.db;
  const { data, error } = await supabase
    .from("profile_preferences")
    .select("subtask_hide_completed, subtask_assigned_to_me, subtask_sort")
    .eq("profile_id", user.id)
    .maybeSingle();
  if (error || !data) return DEFAULT_SUBTASK_PREFS;
  return parseSubtaskPrefs(data);
});

// ---------------------------------------------------------------------------------------------
// Email extras (Real features 3): the person's digest / report email switches, their scheduled report
// emails, and the Admin console's delivery overview and suppression list. Every read uses the viewer's
// own client: email_preferences and report_schedules are own rows only; the overview and the list are
// workspace admins only (and never carry a subject, body, task, or project).
// ---------------------------------------------------------------------------------------------

// Null on a database without the migration; the defaults when the person never changed anything.
const getMyEmailPreferences = read(async (ctx: ApiContext): Promise<EmailPreferences | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("email_preferences")
    .select("digest, digest_hour, digest_weekday, time_zone, report_emails, digest_next_at, digest_last_sent_at")
    .maybeSingle();
  if (result.error) return null;
  const r = result.data;
  if (!r) return DEFAULT_EMAIL_PREFERENCES;
  return {
    digest: isDigestFrequency(r.digest) ? r.digest : "off",
    hour: r.digest_hour,
    weekday: r.digest_weekday,
    timeZone: r.time_zone,
    reportEmails: r.report_emails,
    nextDigestAt: r.digest_next_at,
    lastDigestAt: r.digest_last_sent_at,
  };
});

// List / My tasks rows the viewer expanded (profile_preferences.expanded_task_ids; newest first). Empty on
// a database without the column.
export const getExpandedTaskIds = read(async (ctx: ApiContext): Promise<string[]> => {
  const supabase = ctx.db;
  const result = await supabase.from("profile_preferences").select("expanded_task_ids").maybeSingle();
  if (result.error || !result.data) return [];
  return Array.isArray(result.data.expanded_task_ids) ? result.data.expanded_task_ids : [];
});
