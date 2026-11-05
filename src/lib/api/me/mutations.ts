// Big move 1: the me area's writes (the signed-in person's own settings: profile, picture, notification
// and email switches, scheduled report emails, email forwarding, workdays, display preferences). Every
// function takes the caller's ApiContext first, validates its own input, writes only through ctx.db (RLS
// and the RPCs keep it to the person's own rows), and throws ApiError on any refusal; no Next.js here.
import { getSignedInUser } from "@/lib/api/auth/queries";
import type { ApiContext } from "@/lib/api/core/context";
import { check, checkUpdated, nowIso } from "@/lib/api/core/db";
import { ApiError, NEEDS_DATABASE_UPDATE, invalid } from "@/lib/api/core/errors";
import { id, text } from "@/lib/api/core/validate";
import {
  MAX_RECIPIENTS,
  MAX_SCHEDULE_NAME,
  isDigestFrequency,
  isHour,
  isMonthDay,
  isReportKind,
  isScheduleFrequency,
  isWeekday,
  type ReportScheduleInput,
} from "@/lib/email-schedules";
import { isNotificationChannel, isNotificationKind } from "@/lib/notifications";
import { AVATARS_BUCKET, AVATAR_TYPES, avatarFileProblem, ownAvatarPath, profileNameProblem } from "@/lib/profile";
import { reportFiltersJson } from "@/lib/reports";
import { parseSubtaskPrefs, type SubtaskPrefs } from "@/lib/subtask-view";
import { normalizeWorkWeek } from "@/lib/workdays";

// ---------------------------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------------------------

// Oct 27 notes (batch 5): the task pane's Subtasks filter and sort, remembered per person
// (set_subtask_preferences, invoker, own row). The caller doesn't refresh: the pane already shows the change.
export async function saveSubtaskPreferences(ctx: ApiContext, prefs: SubtaskPrefs): Promise<void> {
  const clean = parseSubtaskPrefs({ hide_completed: prefs?.hideCompleted, assigned_to_me: prefs?.assignedToMe, sort: prefs?.sort });
  const supabase = ctx.db;
  const result = await supabase.rpc("set_subtask_preferences", {
    hide_completed: clean.hideCompleted,
    assigned_to_me: clean.assignedToMe,
    sort_key: clean.sort,
  });
  // A database without this release: the choice lasts for the visit.
  if (result.error?.code === "PGRST202") return;
  check(result);
}

// Nov 3 notes (batch 19, 140): the signed-in person's own workdays (null = count the organization's). Business-day
// automation steps that count "the owner's own" days use them (My Tasks automations and personal projects by
// default).
export async function setMyWorkWeek(ctx: ApiContext, days: number[] | null): Promise<void> {
  if (
    days !== null &&
    (!Array.isArray(days) ||
      days.length < 1 ||
      days.length > 7 ||
      days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
      new Set(days).size !== days.length)
  ) {
    throw invalid("Choose 1 to 7 different days of the week");
  }
  const supabase = ctx.db;
  const saved = await supabase.rpc("set_my_work_week", { days: days === null ? null : normalizeWorkWeek(days) });
  if (saved.error?.code === "PGRST202") throw invalid("Your own workdays need this release’s database update");
  check(saved);
}

// Settings → Display: open my own saved view of a project first (when I have one).
export async function setOpenPersonalView(ctx: ApiContext, enabled: boolean): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase.rpc("set_open_personal_view", { enabled: Boolean(enabled) });
  if (result.error?.code === "PGRST202") throw invalid("This setting needs this release’s database update");
  check(result);
}

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

// "Email me about comments" (Settings → Profile). Own row only (profiles_update_own).
export async function setEmailComments(ctx: ApiContext, enabled: boolean): Promise<void> {
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) throw invalid("Sign in again to change this");
  checkUpdated(
    await supabase.from("profiles").update({ email_comments: enabled === true }).eq("id", user.id).select("id"),
    "Couldn’t save your notification setting",
  );
}

// Settings → Profile (Oct 25 notes): your own name. The column grant and profiles_update_own keep it to
// your own row's name, picture, and comment email switch.
export async function updateMyProfile(ctx: ApiContext, { fullName }: { fullName: string }): Promise<void> {
  const name = typeof fullName === "string" ? fullName.trim() : "";
  const problem = profileNameProblem(name);
  if (problem) throw invalid(problem);
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) throw invalid("Sign in again to change this");
  checkUpdated(
    await supabase.from("profiles").update({ full_name: name }).eq("id", user.id).select("id"),
    "Couldn’t save your name",
  );
}

// The image's first bytes must match its declared type (the bucket checks the type it's told).
function looksLikeImage(bytes: Uint8Array, type: string): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (type === "image/png") return bytes[0] === 0x89 && ascii(1, 4) === "PNG";
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/gif") return ascii(0, 4) === "GIF8";
  if (type === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  return false;
}

// Settings → Profile: upload a new picture into your own folder of the public avatars bucket
// (<your id>/<random>.<ext>, the Storage policies' rule), point your profile at it, then remove the old
// file. Answers the new public URL. `file` is the form's "file" entry (anything but a File is refused).
export async function uploadMyAvatar(ctx: ApiContext, file: unknown): Promise<{ avatarUrl: string }> {
  if (!(file instanceof File)) throw invalid("Choose a picture to upload");
  const problem = avatarFileProblem(file);
  if (problem) throw invalid(problem);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeImage(bytes, file.type)) throw invalid("That file isn’t a PNG, JPEG, WebP, or GIF image");
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) throw invalid("Sign in again to change this");
  const previous = await supabase.from("profiles").select("avatar_url").eq("id", user.id).maybeSingle();
  check(previous);
  const path = `${user.id}/${crypto.randomUUID()}.${AVATAR_TYPES[file.type]}`;
  const upload = await supabase.storage
    .from(AVATARS_BUCKET)
    .upload(path, bytes, { contentType: file.type, upsert: false, cacheControl: "31536000" });
  if (upload.error) {
    if (/row-level security|not authorized|unauthorized/i.test(upload.error.message)) {
      throw new ApiError("not_deployed", "Uploading pictures needs this release’s storage update");
    }
    throw new ApiError("failed", "Couldn’t upload the picture. Try again.");
  }
  const url = supabase.storage.from(AVATARS_BUCKET).getPublicUrl(path).data.publicUrl;
  const saved = await supabase.from("profiles").update({ avatar_url: url }).eq("id", user.id).select("id");
  if (saved.error || !saved.data?.length) {
    await supabase.storage.from(AVATARS_BUCKET).remove([path]);
    checkUpdated(saved, "Couldn’t save your picture");
  }
  const old = ownAvatarPath(previous.data?.avatar_url, user.id);
  if (old && old !== path) await supabase.storage.from(AVATARS_BUCKET).remove([old]);
  return { avatarUrl: url };
}

// Settings → Profile: remove your picture (and its file, when it's one you uploaded).
export async function removeMyAvatar(ctx: ApiContext): Promise<void> {
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) throw invalid("Sign in again to change this");
  const previous = await supabase.from("profiles").select("avatar_url").eq("id", user.id).maybeSingle();
  check(previous);
  checkUpdated(
    await supabase.from("profiles").update({ avatar_url: null }).eq("id", user.id).select("id"),
    "Couldn’t remove your picture",
  );
  const old = ownAvatarPath(previous.data?.avatar_url, user.id);
  if (old) await supabase.storage.from(AVATARS_BUCKET).remove([old]);
}

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

// Settings → Notifications (Real features 2): one Inbox or Email switch for one kind of notification.
// The comment email switch is profiles.email_comments; the database keeps every row the person's own.
export async function setNotificationSetting(ctx: ApiContext, kind: string, channel: string, enabled: boolean): Promise<void> {
  if (!isNotificationKind(kind)) throw invalid("Unknown notification kind");
  if (!isNotificationChannel(channel)) throw invalid("Unknown notification channel");
  const supabase = ctx.db;
  const result = await supabase.rpc("set_notification_setting", {
    category: kind,
    channel,
    enabled: enabled === true,
  });
  if (result.error?.code === "PGRST202") throw invalid("Notification settings need this release’s database update");
  check(result, "Couldn’t save your notification setting");
}

// ---------------------------------------------------------------------------------------------
// Email extras (Real features 3): the Inbox digest, report email switch, scheduled report emails, and
// the Admin console's suppression list. Everything goes through the person's own client: their own rows
// (email_preferences, report_schedules) and, for clearing a suppressed address, workspace admins by RLS.
// ---------------------------------------------------------------------------------------------

const NEEDS_REAL3 = "Email digests and scheduled reports need this release’s database update";

function missingReal3(error: { code?: string } | null): boolean {
  // PGRST202 = no such function, PGRST205 = no such table, 42P01 = undefined table.
  return Boolean(error && (error.code === "PGRST202" || error.code === "PGRST205" || error.code === "42P01"));
}

// Settings → Notifications → Email digest: off, daily, or weekly at an hour (and weekday) in the
// person's time zone. Answers when the next digest is due.
export async function setEmailDigest(
  ctx: ApiContext,
  input: {
    frequency: string;
    hour: number;
    weekday: number;
    timeZone: string;
  },
): Promise<{ nextAt: string | null }> {
  if (!isDigestFrequency(input.frequency)) throw invalid("Choose Off, Daily, or Weekly");
  if (!isHour(input.hour)) throw invalid("Choose an hour of the day");
  if (!isWeekday(input.weekday)) throw invalid("Choose a day of the week");
  const zone = typeof input.timeZone === "string" ? input.timeZone.trim().slice(0, 100) : "UTC";
  const supabase = ctx.db;
  const saved = await supabase.rpc("set_email_digest", {
    frequency: input.frequency,
    send_hour: input.hour,
    send_weekday: input.weekday,
    zone: zone || "UTC",
  });
  if (missingReal3(saved.error)) throw invalid(NEEDS_REAL3);
  check(saved, "Couldn’t save your email digest");
  return { nextAt: typeof saved.data === "string" ? saved.data : null };
}

// Settings → Notifications: whether scheduled report emails that people send you reach you at all.
export async function setReportEmails(ctx: ApiContext, enabled: boolean): Promise<void> {
  const supabase = ctx.db;
  const saved = await supabase.rpc("set_report_emails", { enabled: enabled === true });
  if (missingReal3(saved.error)) throw invalid(NEEDS_REAL3);
  check(saved, "Couldn’t save your report email setting");
}

function scheduleFields(input: ReportScheduleInput) {
  const name = text(input.name, "Name", { max: MAX_SCHEDULE_NAME });
  if (!isReportKind(input.report)) throw invalid("Choose a report");
  if (!isScheduleFrequency(input.frequency)) throw invalid("Choose daily, weekly, or monthly");
  if (!isHour(input.hour)) throw invalid("Choose an hour of the day");
  if (!isWeekday(input.weekday)) throw invalid("Choose a day of the week");
  if (!isMonthDay(input.monthDay)) throw invalid("Choose a day of the month (1–28)");
  // Sorted like the database stores them, so an edit that keeps the same people doesn't re-check them.
  const recipients = [
    ...new Set((Array.isArray(input.recipients) ? input.recipients : []).map((r) => id(r, "recipient").toLowerCase())),
  ].sort();
  if (recipients.length === 0) throw invalid("Add at least one recipient");
  if (recipients.length > MAX_RECIPIENTS) throw invalid(`Up to ${MAX_RECIPIENTS} recipients`);
  const zone = typeof input.timeZone === "string" && input.timeZone.trim() ? input.timeZone.trim().slice(0, 100) : "UTC";
  return {
    name,
    report: input.report,
    filters: input.report === "projects" ? {} : reportFiltersJson(input.filters ?? {}),
    frequency: input.frequency,
    weekday: input.weekday,
    month_day: input.monthDay,
    send_hour: input.hour,
    time_zone: zone,
    recipients,
  };
}

function scheduleError(error: { code?: string; message: string } | null): never | void {
  if (!error) return;
  if (missingReal3(error)) throw invalid(NEEDS_REAL3);
  if (error.code === "23514" && error.message.includes("workspace")) {
    throw invalid("Recipients must be people in this workspace");
  }
}

// Reports → Schedule email: the Reports page's current filters (or the All projects report), sent to
// people in the workspace on a schedule. Each recipient's copy is built with their own access. Answers
// the new schedule's id.
export async function createReportSchedule(ctx: ApiContext, input: ReportScheduleInput): Promise<{ id: string | undefined }> {
  const fields = scheduleFields(input);
  const supabase = ctx.db;
  const saved = await supabase.from("report_schedules").insert(fields).select("id").single();
  scheduleError(saved.error);
  check(saved, "Couldn’t schedule the report");
  return { id: saved.data?.id };
}

export async function updateReportSchedule(ctx: ApiContext, scheduleId: string, input: ReportScheduleInput): Promise<void> {
  const fields = scheduleFields(input);
  const supabase = ctx.db;
  const saved = await supabase
    .from("report_schedules")
    .update(fields)
    .eq("id", id(scheduleId, "schedule"))
    .is("deleted_at", null)
    .select("id");
  scheduleError(saved.error);
  checkUpdated(saved, "Only the person who scheduled this report can change it");
}

export async function setReportSchedulePaused(ctx: ApiContext, scheduleId: string, paused: boolean): Promise<void> {
  const supabase = ctx.db;
  const saved = await supabase
    .from("report_schedules")
    .update({ paused_at: paused ? nowIso() : null })
    .eq("id", id(scheduleId, "schedule"))
    .is("deleted_at", null)
    .select("id");
  scheduleError(saved.error);
  checkUpdated(saved, "Only the person who scheduled this report can change it");
}

export async function deleteReportSchedule(ctx: ApiContext, scheduleId: string): Promise<void> {
  const supabase = ctx.db;
  const saved = await supabase
    .from("report_schedules")
    .update({ deleted_at: nowIso() })
    .eq("id", id(scheduleId, "schedule"))
    .is("deleted_at", null)
    .select("id");
  scheduleError(saved.error);
  checkUpdated(saved, "Only the person who scheduled this report can remove it");
}

// Admin console → Email: let email go to a suppressed address again (workspace admins; the function
// checks). Resend
// keeps its own list for addresses it suppressed; the page says so.
export async function clearEmailSuppression(ctx: ApiContext, suppressionId: string): Promise<void> {
  const supabase = ctx.db;
  const saved = await supabase.rpc("clear_email_suppression", { target_suppression: id(suppressionId, "address") });
  if (missingReal3(saved.error)) throw invalid(NEEDS_REAL3);
  check(saved, "Only workspace admins can clear an address");
}

// ---------------------------------------------------------------------------------------------
// Email forwarding (Real features 1)
// ---------------------------------------------------------------------------------------------

// Settings → Email forwarding (Real features 1): where tasks from the person's forwarding address go — a
// project they can add tasks to (the database checks Editor+ now and again on every email), or null for
// their private My tasks.
export async function setForwardingProject(ctx: ApiContext, projectId: string | null): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase
    .from("email_forwarding_addresses")
    .update({ default_project_id: projectId === null ? null : id(projectId, "project") })
    .is("revoked_at", null)
    .select("id");
  if (result.error?.code === "42P01" || result.error?.code === "PGRST205") throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  checkUpdated(result, "Choose a project you can add tasks to");
}

// A new forwarding address; the old one stops working at once (mail to it is ignored and logged).
// Answers the new address's token (the caller turns it into the address on its reply domain).
export async function rotateForwardingAddress(ctx: ApiContext): Promise<string> {
  const supabase = ctx.db;
  const rotated = await supabase.rpc("rotate_forwarding_address");
  if (rotated.error?.code === "PGRST202") throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  check(rotated);
  if (!rotated.data?.token) throw new ApiError("failed", "Couldn’t make a new address");
  return rotated.data.token;
}
