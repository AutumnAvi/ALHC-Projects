"use client";

import Link from "next/link";
import { useOptimistic } from "react";
import {
  Archive,
  ArchiveRestore,
  AtSign,
  CheckCheck,
  CheckCircle2,
  Inbox,
  MessageSquare,
  ShieldCheck,
  UserPlus,
  Workflow,
} from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { useTaskHref } from "@/components/project/shared";
import { Timestamp } from "@/components/timestamp";
import { EmptyState, PageHeader } from "@/components/ui";
import { useServerAction } from "@/components/toast";
import { archiveInboxItems, markInboxRead, markInboxUnread } from "@/lib/actions";
import type { InboxItem, InboxTab, Profile } from "@/lib/data";
import { useRealtimeRefresh } from "@/lib/realtime";

const KIND = {
  assigned: { icon: UserPlus, verb: "assigned you" },
  comment: { icon: MessageSquare, verb: "commented on" },
  mention: { icon: AtSign, verb: "mentioned you on" },
  completed: { icon: CheckCircle2, verb: "completed" },
  approval_requested: { icon: ShieldCheck, verb: "asked for your approval on" },
  approval_decided: { icon: ShieldCheck, verb: "decided an approval on" },
  rule: { icon: Workflow, verb: "notified you about" },
} as const;

const DECISION_VERB: Record<string, string> = {
  approved: "approved",
  changes_requested: "requested changes on",
  rejected: "rejected",
};

function dataText(data: InboxItem["data"], key: string): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data[key];
  return typeof value === "string" && value ? value : null;
}

function describe(item: InboxItem) {
  const ruleName = dataText(item.data, "rule_name");
  let verb: string = KIND[item.kind].verb;
  if (item.kind === "approval_decided") verb = DECISION_VERB[dataText(item.data, "status") ?? ""] ?? verb;
  if (item.kind === "approval_requested" && item.data && typeof item.data === "object" && !Array.isArray(item.data) && item.data.resubmitted) {
    verb = "resubmitted for your approval";
  }
  const detail =
    item.commentBody ?? dataText(item.data, "message") ?? dataText(item.data, "note") ?? null;
  return { ruleName, verb, detail };
}

const ITEM_ACTION =
  "relative z-10 rounded px-1.5 py-0.5 text-xs text-zinc-500 opacity-0 hover:bg-zinc-200 hover:text-zinc-900 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100";

export function InboxView({
  tab,
  items,
  profiles,
  memberId,
  openTaskId,
}: {
  tab: InboxTab;
  items: InboxItem[];
  profiles: Profile[];
  memberId: string;
  openTaskId: string | null;
}) {
  useRealtimeRefresh(`inbox-${memberId}`, [
    { table: "inbox_items", filter: `recipient_id=eq.${memberId}` },
  ]);
  const taskHref = useTaskHref();
  const [, run] = useServerAction();
  const [readOverrides, setRead] = useOptimistic(
    new Map<string, boolean>(),
    (current, change: { ids: string[]; read: boolean }) => {
      const next = new Map(current);
      for (const id of change.ids) next.set(id, change.read);
      return next;
    },
  );
  // Items archived (Inbox tab) or unarchived (Archived tab) here leave the list until the refresh lands.
  const [moved, move] = useOptimistic(new Set<string>(), (current, ids: string[]) => new Set([...current, ...ids]));
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const archivedTab = tab === "archived";
  const shown = items.filter((item) => !moved.has(item.id));
  const isRead = (item: InboxItem) => readOverrides.get(item.id) ?? Boolean(item.readAt);
  const unread = shown.filter((item) => !isRead(item));

  function setArchived(ids: string[] | "all", archived: boolean) {
    run(
      () => archiveInboxItems(ids, archived),
      () => move(ids === "all" ? shown.map((item) => item.id) : ids),
    );
  }

  function setItemRead(item: InboxItem, read: boolean) {
    run(
      () => (read ? markInboxRead([item.id]) : markInboxUnread(item.id)),
      () => setRead({ ids: [item.id], read }),
    );
  }

  return (
    <>
      <PageHeader
        icon={Inbox}
        title="Inbox"
        description={
          archivedTab
            ? "Archived notifications"
            : unread.length > 0
              ? `${unread.length} unread`
              : "You’re all caught up"
        }
        actions={
          archivedTab ? null : (
            <>
              <button
                type="button"
                disabled={unread.length === 0}
                onClick={() =>
                  run(
                    () => markInboxRead("all"),
                    () => setRead({ ids: unread.map((i) => i.id), read: true }),
                  )
                }
                className="btn-secondary"
              >
                <CheckCheck className="size-3.5" aria-hidden />
                Mark all read
              </button>
              <button
                type="button"
                disabled={shown.length === 0}
                onClick={() => {
                  if (window.confirm(`Archive ${shown.length === 1 ? "this notification" : `all ${shown.length} notifications`}?`)) {
                    setArchived("all", true);
                  }
                }}
                className="btn-secondary"
              >
                <Archive className="size-3.5" aria-hidden />
                Archive all
              </button>
            </>
          )
        }
      />
      <nav aria-label="Inbox tabs" className="flex shrink-0 gap-4 border-b border-zinc-200 px-gutter">
        {(
          [
            { key: "active", label: "Inbox", href: "/inbox" },
            { key: "archived", label: "Archived", href: "/inbox?tab=archived" },
          ] as const
        ).map(({ key, label, href }) => (
          <Link
            key={key}
            href={href}
            aria-current={tab === key ? "page" : undefined}
            className="-mb-px border-b-2 border-transparent py-2 text-sm text-zinc-600 hover:text-zinc-900 aria-[current=page]:border-zinc-900 aria-[current=page]:font-medium aria-[current=page]:text-zinc-900"
          >
            {label}
          </Link>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-gutter py-4">
          {shown.length === 0 ? (
            archivedTab ? (
              <EmptyState icon={Archive} title="Nothing archived">
                Archive notifications you’re done with to clear your Inbox. They stay here, and you can move them back.
              </EmptyState>
            ) : (
              <EmptyState icon={Inbox} title="No notifications">
                You’ll hear about assignments, @mentions, approvals, rule notifications, and comments or completions on
                tasks you follow. Archived notifications are in the Archived tab.
              </EmptyState>
            )
          ) : (
            <ul
              className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200"
              aria-label={archivedTab ? "Archived notifications" : "Notifications"}
            >
              {shown.map((item) => {
                const read = isRead(item);
                const actor = item.actorId ? profilesById.get(item.actorId) : undefined;
                const { ruleName, verb, detail } = describe(item);
                const actorName = actor ? displayName(actor) : ruleName ? `Rule “${ruleName}”` : "Someone";
                const { icon: Icon } = KIND[item.kind];
                const open = openTaskId === item.taskId;
                return (
                  <li
                    key={item.id}
                    data-unread={read ? undefined : "true"}
                    className={`group relative flex gap-3 px-3 py-2.5 ${
                      open ? "bg-accent-50" : read ? "hover:bg-zinc-50" : "bg-accent-50/40 hover:bg-accent-50"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`mt-2 size-2 shrink-0 rounded-full ${read ? "bg-transparent" : "bg-accent-600"}`}
                    />
                    <Avatar name={actorName} size="md" />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={taskHref(item.taskId)}
                        scroll={false}
                        onClick={() => {
                          if (!read) setItemRead(item, true);
                        }}
                        className="block text-sm text-zinc-700 after:absolute after:inset-0"
                      >
                        <span className={read ? "font-medium" : "font-semibold text-zinc-900"}>
                          {actorName}
                        </span>{" "}
                        {verb}{" "}
                        <span className={read ? "font-medium" : "font-semibold text-zinc-900"}>
                          {item.taskTitle}
                        </span>
                        {item.parentTitle ? <span className="text-zinc-500"> (subtask of {item.parentTitle})</span> : null}
                        {read ? null : <span className="sr-only"> (unread)</span>}
                      </Link>
                      {detail ? <p className="mt-0.5 line-clamp-2 text-sm text-zinc-500">{detail}</p> : null}
                      <p className="mt-1 flex items-center gap-1 text-xs text-zinc-400">
                        <Icon className="size-3.5" aria-hidden />
                        <Timestamp iso={item.createdAt} />
                      </p>
                    </div>
                    <div className="flex shrink-0 items-start gap-0.5 self-start">
                      <button type="button" onClick={() => setItemRead(item, !read)} className={ITEM_ACTION}>
                        {read ? "Mark unread" : "Mark read"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setArchived([item.id], !archivedTab)}
                        aria-label={archivedTab ? `Move “${item.taskTitle}” back to Inbox` : `Archive “${item.taskTitle}”`}
                        title={archivedTab ? "Move to Inbox" : "Archive"}
                        className={`${ITEM_ACTION} inline-flex items-center gap-1`}
                      >
                        {archivedTab ? <ArchiveRestore className="size-3.5" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
                        {archivedTab ? "Unarchive" : "Archive"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
