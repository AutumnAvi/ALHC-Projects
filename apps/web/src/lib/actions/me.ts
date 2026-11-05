"use server";
// Big move 1: the me area's Server Actions (the signed-in person's own settings), thin wrappers around
// packages/core/src/api/me/mutations.ts. Only what Next.js does (the request's context, re-rendering, the reply
// domain from the environment) stays here.
import type { ActionResult } from "@alhc/core/api/core/result";
import * as meApi from "@alhc/core/api/me/mutations";
import { forwardingAddress } from "@/lib/email-reply";
import type { ReportScheduleInput } from "@alhc/core/email-schedules";
import { run, runWith } from "@/lib/server/action";
import type { SubtaskPrefs } from "@alhc/core/subtask-view";

// ---------------------------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------------------------

// Oct 27 notes (batch 5): no refresh (the pane already shows the change) and nothing to deliver.
export async function saveSubtaskPreferences(prefs: SubtaskPrefs): Promise<ActionResult> {
  return run((ctx) => meApi.saveSubtaskPreferences(ctx, prefs), { refresh: false, deliver: false });
}

export async function setMyWorkWeek(days: number[] | null): Promise<ActionResult> {
  return run((ctx) => meApi.setMyWorkWeek(ctx, days));
}

export async function setOpenPersonalView(enabled: boolean): Promise<ActionResult> {
  return run((ctx) => meApi.setOpenPersonalView(ctx, enabled));
}

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

export async function setEmailComments(enabled: boolean): Promise<ActionResult> {
  return run((ctx) => meApi.setEmailComments(ctx, enabled));
}

export async function updateMyProfile({ fullName }: { fullName: string }): Promise<ActionResult> {
  return run((ctx) => meApi.updateMyProfile(ctx, { fullName }));
}

// Returns the new public URL.
export async function uploadMyAvatar(formData: FormData): Promise<ActionResult & { avatarUrl?: string }> {
  return runWith((ctx) => meApi.uploadMyAvatar(ctx, formData.get("file")));
}

export async function removeMyAvatar(): Promise<ActionResult> {
  return run((ctx) => meApi.removeMyAvatar(ctx));
}

// ---------------------------------------------------------------------------------------------
// Notifications and email extras
// ---------------------------------------------------------------------------------------------

export async function setNotificationSetting(kind: string, channel: string, enabled: boolean): Promise<ActionResult> {
  return run((ctx) => meApi.setNotificationSetting(ctx, kind, channel, enabled));
}

// Returns when the next digest is due.
export async function setEmailDigest(input: {
  frequency: string;
  hour: number;
  weekday: number;
  timeZone: string;
}): Promise<ActionResult & { nextAt?: string | null }> {
  return runWith((ctx) => meApi.setEmailDigest(ctx, input));
}

export async function setReportEmails(enabled: boolean): Promise<ActionResult> {
  return run((ctx) => meApi.setReportEmails(ctx, enabled));
}

export async function createReportSchedule(input: ReportScheduleInput): Promise<ActionResult & { id?: string }> {
  return runWith((ctx) => meApi.createReportSchedule(ctx, input));
}

export async function updateReportSchedule(scheduleId: string, input: ReportScheduleInput): Promise<ActionResult> {
  return run((ctx) => meApi.updateReportSchedule(ctx, scheduleId, input));
}

export async function setReportSchedulePaused(scheduleId: string, paused: boolean): Promise<ActionResult> {
  return run((ctx) => meApi.setReportSchedulePaused(ctx, scheduleId, paused));
}

export async function deleteReportSchedule(scheduleId: string): Promise<ActionResult> {
  return run((ctx) => meApi.deleteReportSchedule(ctx, scheduleId));
}

export async function clearEmailSuppression(suppressionId: string): Promise<ActionResult> {
  return run((ctx) => meApi.clearEmailSuppression(ctx, suppressionId));
}

// ---------------------------------------------------------------------------------------------
// Email forwarding
// ---------------------------------------------------------------------------------------------

export async function setForwardingProject(projectId: string | null): Promise<ActionResult> {
  return run((ctx) => meApi.setForwardingProject(ctx, projectId));
}

// The address is the token on the reply domain (an environment setting, so it's made here).
export async function rotateForwardingAddress(): Promise<ActionResult & { address?: string }> {
  return runWith(async (ctx) => ({ address: forwardingAddress(await meApi.rotateForwardingAddress(ctx)) }));
}
