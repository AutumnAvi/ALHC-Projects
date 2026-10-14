// Real features 3 (email extras), mirrored from 20261014010000_real_3.sql: the Inbox email digest
// (email_preferences), scheduled report emails (report_schedules), and what Resend reported after
// sending (email_outbox.delivery_status, email_suppressions). Browser + server.

import type { ReportFilters } from "@/lib/reports";

export const DIGEST_FREQUENCIES = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number]["value"];
export const isDigestFrequency = (value: unknown): value is DigestFrequency =>
  DIGEST_FREQUENCIES.some((f) => f.value === value);

export const SCHEDULE_FREQUENCIES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number]["value"];
export const isScheduleFrequency = (value: unknown): value is ScheduleFrequency =>
  SCHEDULE_FREQUENCIES.some((f) => f.value === value);

export const REPORT_KINDS = [
  { value: "overview", label: "Reports overview" },
  { value: "projects", label: "All projects" },
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number]["value"];
export const isReportKind = (value: unknown): value is ReportKind => REPORT_KINDS.some((k) => k.value === value);

// 0 = Sunday, like extract(dow) in Postgres.
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);
export const HOURS = Array.from({ length: 24 }, (_, i) => i);
export const MAX_RECIPIENTS = 50;
export const MAX_SCHEDULE_NAME = 100;

export const isHour = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23;
export const isWeekday = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6;
export const isMonthDay = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 28;

// "8:00 AM", "12:00 PM".
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

// One person's digest and report email switches (email_preferences; no row = the defaults).
export type EmailPreferences = {
  digest: DigestFrequency;
  hour: number;
  weekday: number;
  timeZone: string;
  reportEmails: boolean;
  nextDigestAt: string | null;
  lastDigestAt: string | null;
};

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  digest: "off",
  hour: 8,
  weekday: 1,
  timeZone: "UTC",
  reportEmails: true,
  nextDigestAt: null,
  lastDigestAt: null,
};

// "Daily at 8:00 AM" / "Weekly on Monday at 8:00 AM" / "Monthly on the 1st at 8:00 AM".
export function describeSchedule(input: {
  frequency: DigestFrequency | ScheduleFrequency;
  hour: number;
  weekday?: number;
  monthDay?: number;
  timeZone?: string | null;
}): string {
  const at = `at ${hourLabel(input.hour)}`;
  const zone = input.timeZone ? ` (${input.timeZone.replace(/_/g, " ")})` : "";
  switch (input.frequency) {
    case "daily":
      return `Daily ${at}${zone}`;
    case "weekly":
      return `Weekly on ${WEEKDAYS[input.weekday ?? 1]} ${at}${zone}`;
    case "monthly":
      return `Monthly on the ${ordinal(input.monthDay ?? 1)} ${at}${zone}`;
    default:
      return "Off";
  }
}

// A scheduled report email as its owner sees it (report_schedules, owner-only RLS).
export type ReportSchedule = {
  id: string;
  name: string;
  report: ReportKind;
  filters: ReportFilters;
  frequency: ScheduleFrequency;
  weekday: number;
  monthDay: number;
  hour: number;
  timeZone: string;
  recipients: string[];
  pausedAt: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSentAt: string | null;
  lastSentCount: number | null;
  createdAt: string;
};

export type ReportScheduleInput = {
  name: string;
  report: ReportKind;
  filters: ReportFilters;
  frequency: ScheduleFrequency;
  weekday: number;
  monthDay: number;
  hour: number;
  timeZone: string;
  recipients: string[];
};

// What Resend reported after an email went out (email_outbox.delivery_status), and the send status
// before that, as the Admin console labels them.
export const DELIVERY_STATUSES = ["delivered", "delayed", "bounced", "complained", "suppressed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const isDeliveryEvent = (value: unknown): value is DeliveryStatus =>
  DELIVERY_STATUSES.some((s) => s === value);

type Badge = { label: string; className: string };

const SEND_STATUS: Record<string, Badge> = {
  pending: { label: "Queued", className: "bg-amber-50 text-amber-800" },
  sending: { label: "Sending", className: "bg-accent-50 text-accent-700" },
  sent: { label: "Sent", className: "bg-zinc-100 text-zinc-700" },
  mocked: { label: "Not sent (no email provider)", className: "bg-zinc-100 text-zinc-600" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700" },
};

const DELIVERY_BADGES: Record<DeliveryStatus, Badge> = {
  delivered: { label: "Delivered", className: "bg-green-50 text-green-800" },
  delayed: { label: "Delayed", className: "bg-amber-50 text-amber-800" },
  bounced: { label: "Bounced", className: "bg-red-50 text-red-700" },
  complained: { label: "Complained", className: "bg-red-50 text-red-700" },
  suppressed: { label: "Suppressed by Resend", className: "bg-red-50 text-red-700" },
};

// Sent / Delivered / Bounced / Complained: the delivery event wins once there is one.
export function emailStatusBadge(status: string, deliveryStatus: string | null, attempts = 0): Badge {
  if (status === "sent" && isDeliveryEvent(deliveryStatus)) return DELIVERY_BADGES[deliveryStatus];
  if (status === "pending" && attempts > 0) return { label: "Retrying", className: "bg-amber-50 text-amber-800" };
  return SEND_STATUS[status] ?? { label: status, className: "bg-zinc-100 text-zinc-600" };
}

export const EMAIL_KIND_LABELS: Record<string, string> = {
  comment: "Comment",
  invite: "Invite",
  notification: "Notification",
  digest: "Inbox digest",
  report: "Scheduled report",
  submitter_response: "Response to submitter",
  form_confirmation: "Form confirmation",
  requester_update: "Requester update",
  due_tomorrow: "Due tomorrow",
  custom: "Rule email",
};

export const SUPPRESSION_REASONS: Record<string, string> = {
  bounced: "Bounced (permanent)",
  complained: "Marked as spam",
  suppressed: "Suppressed by Resend",
};

// The Resend webhook events the app records (Avi adds these to the existing webhook in Resend).
export const RESEND_DELIVERY_EVENTS = [
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.suppressed",
] as const;
export const isResendDeliveryEvent = (value: unknown): value is (typeof RESEND_DELIVERY_EVENTS)[number] =>
  RESEND_DELIVERY_EVENTS.some((e) => e === value);

// The one-click "Turn off" links (no sign-in): what they turn off.
export type UnsubscribeWhat = "digest" | "reports";
export const isUnsubscribeWhat = (value: unknown): value is UnsubscribeWhat => value === "digest" || value === "reports";
export const UNSUBSCRIBE_TOKEN = /^[0-9a-f]{64}$/i;
