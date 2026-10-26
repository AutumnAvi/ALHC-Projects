// Notification kinds and their Inbox / Email switches (Real features 2), mirrored from
// 20261013020000_real_2.sql: notification_settings.kind, notification_category(), and the defaults in
// notification_wanted(). Browser + server.

import type { Json } from "@/lib/supabase/database.types";

export const NOTIFICATION_KINDS = [
  {
    key: "assigned",
    label: "Task assignments",
    description: "Someone assigns a task to you.",
  },
  {
    key: "mention",
    label: "@mentions",
    description: "Someone @mentions you in a comment or a project message.",
  },
  {
    key: "comment",
    label: "Comments on tasks you follow",
    description: "A new comment on a task you follow (you follow tasks you create, are assigned, or comment on).",
  },
  {
    key: "message",
    label: "Messages",
    description: "A reply in a project message thread you started or took part in.",
  },
  {
    key: "status_update",
    label: "Status updates",
    description: "A new status update on a project you're a member of.",
  },
  {
    key: "approval",
    label: "Approvals",
    description: "Someone asks for your approval, or an approval on a task you follow is decided.",
  },
  {
    key: "completed",
    label: "Completed tasks",
    description: "A task you follow is marked complete.",
  },
  {
    key: "field_change",
    label: "Field changes",
    description: "A field set to “Notify collaborators when changed” changes on a task you follow.",
  },
  {
    key: "rule",
    label: "Rule notifications",
    description: "A project rule sends you a notification.",
  },
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]["key"];
export type NotificationChannel = "inbox" | "email";

export function isNotificationKind(value: unknown): value is NotificationKind {
  return NOTIFICATION_KINDS.some((k) => k.key === value);
}

export const isNotificationChannel = (value: unknown): value is NotificationChannel =>
  value === "inbox" || value === "email";

// One person's switches: an explicit choice per kind (null = the default).
export type NotificationSettingRow = { kind: string; inbox: boolean | null; email: boolean | null };
export type NotificationSettings = Record<NotificationKind, { inbox: boolean; email: boolean }>;

// The defaults keep what happened before Real features 2: every Inbox kind on; comment emails are
// profiles.email_comments; mention emails follow that switch until set; every other email off.
export function resolveNotificationSettings(
  rows: readonly NotificationSettingRow[],
  emailComments: boolean,
): NotificationSettings {
  const byKind = new Map(rows.map((r) => [r.kind, r] as const));
  return Object.fromEntries(
    NOTIFICATION_KINDS.map(({ key }) => {
      const row = byKind.get(key);
      const email =
        key === "comment" ? emailComments : (row?.email ?? (key === "mention" ? emailComments : false));
      return [key, { inbox: row?.inbox ?? true, email }];
    }),
  ) as NotificationSettings;
}

// The kind an inbox item counts as (notification_category()): approval requests and decisions are
// "approval"; a rule item with data.field_change is "field_change".
export function notificationKindOf(item: { kind: string; data: Json }): NotificationKind {
  switch (item.kind) {
    case "assigned":
    case "mention":
    case "comment":
    case "completed":
    case "message":
    case "status_update":
      return item.kind;
    case "approval_requested":
    case "approval_decided":
      return "approval";
    default: {
      const d = item.data;
      const fieldChange = !!d && typeof d === "object" && !Array.isArray(d) && d.field_change === true;
      return fieldChange ? "field_change" : "rule";
    }
  }
}
