"use client";

import Link from "next/link";
import { useOptimistic } from "react";
import { AtSign, CheckCheck, CheckCircle2, Inbox, MessageSquare, ShieldCheck, UserPlus, Workflow } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { useTaskHref } from "@/components/project/shared";
import { Timestamp } from "@/components/timestamp";
import { EmptyState, PageHeader } from "@/components/ui";
import { useServerAction } from "@/components/toast";
import { markInboxRead, markInboxUnread } from "@/lib/actions";
import type { InboxItem, Profile } from "@/lib/data";
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

export function InboxView({
  items,
  profiles,
  memberId,
  openTaskId,
}: {
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
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const isRead = (item: InboxItem) => readOverrides.get(item.id) ?? Boolean(item.readAt);
  const unread = items.filter((item) => !isRead(item));

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
        description={unread.length > 0 ? `${unread.length} unread` : "You’re all caught up"}
        actions={
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
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-gutter py-4">
          {items.length === 0 ? (
            <EmptyState icon={Inbox} title="No notifications yet">
              You’ll hear about assignments, @mentions, approvals, rule notifications, and comments or completions on
              tasks you follow.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200" aria-label="Notifications">
              {items.map((item) => {
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
                        {read ? null : <span className="sr-only"> (unread)</span>}
                      </Link>
                      {detail ? <p className="mt-0.5 line-clamp-2 text-sm text-zinc-500">{detail}</p> : null}
                      <p className="mt-1 flex items-center gap-1 text-xs text-zinc-400">
                        <Icon className="size-3.5" aria-hidden />
                        <Timestamp iso={item.createdAt} />
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setItemRead(item, !read)}
                      className="relative z-10 self-start rounded px-1.5 py-0.5 text-xs text-zinc-500 opacity-0 hover:bg-zinc-200 hover:text-zinc-900 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      {read ? "Mark unread" : "Mark read"}
                    </button>
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
