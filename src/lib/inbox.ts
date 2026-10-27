// The Inbox's vocabulary (Asana parity, batch 5): tabs, filter categories, sort, density, and the day
// groups. Browser + server. The items themselves come from listInbox() in data.ts.

import { notificationKindOf, type NotificationKind } from "@/lib/notifications";
import type { Json } from "@/lib/supabase/database.types";

export const INBOX_TABS = [
  { key: "activity", label: "Activity" },
  { key: "bookmarks", label: "Bookmarks" },
  { key: "archive", label: "Archive" },
  { key: "mentioned", label: "@Mentioned" },
] as const;
export type InboxTab = (typeof INBOX_TABS)[number]["key"];

// ?tab= on /inbox. "archived" was the Archived tab's old name (links in old emails and bookmarks).
export function parseInboxTab(value: unknown): InboxTab {
  if (value === "archived") return "archive";
  return INBOX_TABS.some((t) => t.key === value) ? (value as InboxTab) : "activity";
}

export const inboxTabHref = (tab: InboxTab) => (tab === "activity" ? "/inbox" : `/inbox?tab=${tab}`);

// The newest this many items per tab (task items and message items each), newest first.
export const INBOX_LIMIT = 100;

// Oct 26 notes (batch 4): teams have no Messages tab any more, so the Inbox leaves out items about a team
// message (they'd link nowhere; the threads stay in the database). Project messages stay.
export function withoutTeamMessages<T extends { teamMessage: unknown }>(items: T[]): T[] {
  return items.filter((item) => item.teamMessage === null || item.teamMessage === undefined);
}

export const INBOX_KINDS = [
  "assigned",
  "comment",
  "mention",
  "completed",
  "approval_requested",
  "approval_decided",
  "rule",
  "message",
  // Real features 2: a project status update (inbox_items.status_update_id).
  "status_update",
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

// The Filter menu's categories: the notification kinds of Settings → Notifications
// (src/lib/notifications.ts). A field set to "Notify followers when changed" (Asana parity,
// batch 4) sends kind "rule" items with data.field_change, so field changes and rule notifications are
// told apart by that flag.
export const INBOX_CATEGORIES = [
  { key: "assigned", label: "Assigned to me" },
  { key: "mention", label: "@Mentions" },
  { key: "comment", label: "Comments" },
  { key: "message", label: "Messages" },
  { key: "status_update", label: "Status updates" },
  { key: "approval", label: "Approvals" },
  { key: "completed", label: "Completed tasks" },
  { key: "field_change", label: "Field changes" },
  { key: "rule", label: "Rule notifications" },
] as const satisfies readonly { key: NotificationKind; label: string }[];
export type InboxCategory = (typeof INBOX_CATEGORIES)[number]["key"];

export function isFieldChange(item: { kind: string; data: Json }): boolean {
  const d = item.data;
  return item.kind === "rule" && !!d && typeof d === "object" && !Array.isArray(d) && Boolean(d.field_change);
}

export const inboxCategory = (item: { kind: string; data: Json }): InboxCategory => notificationKindOf(item);

// The Filter menu's state: no categories = every kind. Kept in the page (not the URL) while the
// person moves between tabs.
export type InboxFilter = { categories: InboxCategory[]; unreadOnly: boolean };
export const NO_INBOX_FILTER: InboxFilter = { categories: [], unreadOnly: false };
export const inboxFilterCount = (filter: InboxFilter) => filter.categories.length + (filter.unreadOnly ? 1 : 0);

// `short` is the toolbar button's text ("Sort: Newest").
export const INBOX_SORTS = [
  { key: "newest", label: "Newest first", short: "Newest" },
  { key: "oldest", label: "Oldest first", short: "Oldest" },
  { key: "unread", label: "Unread first", short: "Unread first" },
] as const;
export type InboxSort = (typeof INBOX_SORTS)[number]["key"];

// Items arrive newest first (listInbox). "Unread first" keeps that order within unread and read.
export function sortInbox<T>(items: T[], sort: InboxSort, isRead: (item: T) => boolean): T[] {
  if (sort === "oldest") return [...items].reverse();
  if (sort === "unread") return [...items.filter((item) => !isRead(item)), ...items.filter(isRead)];
  return items;
}

export const INBOX_DENSITIES = [
  { key: "detailed", label: "Detailed" },
  { key: "compact", label: "Compact" },
] as const;
export type InboxDensity = (typeof INBOX_DENSITIES)[number]["key"];
export const isInboxDensity = (value: unknown): value is InboxDensity => value === "detailed" || value === "compact";

// The local calendar day (YYYY-MM-DD) of a timestamp in the viewer's time zone. Built from the parts
// rather than a locale's own format, so every browser and the server write the same key.
export function dayKeyIn(iso: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(iso));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return iso.slice(0, 10);
  }
}

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

// The day group's heading: Today, Yesterday, the weekday within the last week, else the date (with
// the year when it isn't this year's). `today` is the viewer's local day, computed on the server so
// the server and the browser draw the same headings.
export function dayLabel(day: string, today: string): string {
  const diff = dayNumber(today) - dayNumber(day);
  const date = new Date(`${day}T12:00:00Z`);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff > 1 && diff < 7) return date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

// Items in display order, cut into day groups (the order within and between days follows the sort;
// "unread first" puts unread items before read ones and then groups each by day).
export function groupByDay<T extends { createdAt: string }>(
  items: T[],
  timeZone: string,
  today: string,
): { day: string; label: string; items: T[] }[] {
  const groups: { day: string; label: string; items: T[] }[] = [];
  for (const item of items) {
    const day = dayKeyIn(item.createdAt, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, label: dayLabel(day, today), items: [item] });
  }
  return groups;
}
