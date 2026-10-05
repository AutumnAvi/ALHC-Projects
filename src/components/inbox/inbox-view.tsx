"use client";

import Link from "next/link";
import { useOptimistic } from "react";
import { AtSign, CheckCircle2, Inbox, MessageSquare, UserPlus } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { useTaskHref } from "@/components/project/shared";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { markInboxRead, markInboxUnread } from "@/lib/actions";
import type { InboxItem, Profile } from "@/lib/data";
import { useRealtimeRefresh } from "@/lib/realtime";

const KIND = {
  assigned: { icon: UserPlus, verb: "assigned you" },
  comment: { icon: MessageSquare, verb: "commented on" },
  mention: { icon: AtSign, verb: "mentioned you on" },
  completed: { icon: CheckCircle2, verb: "completed" },
} as const;

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
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-0.5 text-sm text-zinc-600">
            {unread.length > 0 ? `${unread.length} unread` : "You’re all caught up."}
          </p>
        </div>
        <button
          type="button"
          disabled={unread.length === 0}
          onClick={() =>
            run(
              () => markInboxRead("all"),
              () => setRead({ ids: unread.map((i) => i.id), read: true }),
            )
          }
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          Mark all read
        </button>
      </div>

      {items.length === 0 ? (
        <div className="mt-10 rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center">
          <Inbox className="mx-auto size-8 text-zinc-300" />
          <h2 className="mt-3 text-sm font-medium text-zinc-900">No notifications yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-600">
            You’ll hear about assignments, @mentions, and comments or completions on tasks you
            follow.
          </p>
        </div>
      ) : (
        <ul className="mt-5 divide-y divide-zinc-100 rounded-lg border border-zinc-200" aria-label="Notifications">
          {items.map((item) => {
            const read = isRead(item);
            const actor = item.actorId ? profilesById.get(item.actorId) : undefined;
            const actorName = actor ? displayName(actor) : "Someone";
            const { icon: Icon, verb } = KIND[item.kind];
            const open = openTaskId === item.taskId;
            return (
              <li
                key={item.id}
                data-unread={read ? undefined : "true"}
                className={`group relative flex gap-3 px-4 py-3 ${
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
                  {item.commentBody ? (
                    <p className="mt-0.5 line-clamp-2 text-sm text-zinc-500">{item.commentBody}</p>
                  ) : null}
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
    </>
  );
}
