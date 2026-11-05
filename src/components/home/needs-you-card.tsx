"use client";

import Link from "next/link";
import { ArrowRight, CalendarClock, ShieldCheck } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { displayName } from "@/lib/people";
import { describeInboxItem, inboxItemHref } from "@/components/inbox/inbox-card";
import { useTaskHref } from "@/components/project/shared";
import { TaskLink } from "@/components/task/task-link";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { markInboxRead } from "@/lib/actions/inbox";
import type { AwaitingApproval } from "@/lib/api/my-tasks/model";
import type { InboxItem } from "@/lib/api/inbox/model";
import type { Profile } from "@/lib/api/people/model";
import { formatDueDate } from "@/lib/dates";
import { displayTaskTitle } from "@/lib/request-numbers";
import { seedFromTitle } from "@/lib/task-seed";
import { Widget, WIDGET_FOOTER_LINK, WidgetTitle } from "./widget";

// How many Inbox items Needs you shows besides mentions and approvals.
export const NEEDS_YOU_INBOX = 5;

// Home's "Needs you" (Nov 1 notes, batch 9b, item 65): what's waiting on the person — approvals they
// decide, unread @mentions, new tasks without a date, and the first few other unread Inbox items. A
// row opens the task in the pane (and marks the Inbox item read) or the message / project.
export function NeedsYouCard({
  approvals,
  mentions,
  inbox,
  unreadTotal,
  undatedCount,
  actors,
}: {
  approvals: AwaitingApproval[];
  mentions: InboxItem[];
  inbox: InboxItem[];
  // Every unread item in the Inbox (the footer's count).
  unreadTotal: number;
  // New tasks someone gave the person without a date.
  undatedCount: number;
  actors: Profile[];
}) {
  const nothing = approvals.length === 0 && mentions.length === 0 && inbox.length === 0 && undatedCount === 0;
  return (
    <Widget
      labelledBy="home-needs-you"
      className="min-h-80"
      header={
        <div className="pb-2">
          <WidgetTitle id="home-needs-you">Needs you</WidgetTitle>
        </div>
      }
      footer={
        <Link href="/inbox" className={WIDGET_FOOTER_LINK}>
          {unreadTotal > 0 ? `Inbox · ${unreadTotal} unread` : "Open Inbox"}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      {nothing ? (
        <p className="px-5 py-6 text-sm text-zinc-500">Nothing is waiting on you. Mentions, approvals, and new work show up here.</p>
      ) : (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {undatedCount > 0 ? (
            <Link
              href="/my-tasks#checklist-none"
              className="flex items-center gap-2 rounded-lg bg-accent-50 px-3 py-2 text-sm text-accent-900 hover:bg-accent-100"
            >
              <CalendarClock className="size-4 shrink-0 text-accent-600" aria-hidden />
              <span className="flex-1">
                {undatedCount === 1 ? "1 new task needs a date" : `${undatedCount} new tasks need a date`}
              </span>
              <span className="font-medium">Set a date</span>
            </Link>
          ) : null}
          {approvals.length > 0 ? (
            <Group title="Approvals waiting on you" count={approvals.length}>
              {approvals.slice(0, 5).map((item) => (
                <li key={item.requestId}>
                  <TaskLink
                    taskId={item.taskId}
                    seed={() => seedFromTitle(item.taskId, item.title, { dueOn: item.dueOn, kind: item.isApprovalTask ? "approval" : undefined })}
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-zinc-50"
                  >
                    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-green-50 text-green-700">
                      <ShieldCheck className="size-3.5" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">
                      {displayTaskTitle(item.title, item.requestLabel)}
                    </span>
                    {item.dueOn ? <span className="shrink-0 text-xs text-zinc-500">Due {formatDueDate(item.dueOn)}</span> : null}
                  </TaskLink>
                </li>
              ))}
            </Group>
          ) : null}
          {mentions.length > 0 ? (
            <Group title="Mentions" count={mentions.length}>
              {mentions.map((item) => (
                <InboxRow key={item.id} item={item} actors={actors} />
              ))}
            </Group>
          ) : null}
          {inbox.length > 0 ? (
            <Group title="From your Inbox" count={null}>
              {inbox.map((item) => (
                <InboxRow key={item.id} item={item} actors={actors} />
              ))}
            </Group>
          ) : null}
        </div>
      )}
    </Widget>
  );
}

function Group({ title, count, children }: { title: string; count: number | null; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="flex items-center gap-1.5 px-2 pb-1 text-xs font-semibold text-zinc-500">
        {title}
        {count !== null ? <span className="rounded-full bg-zinc-100 px-1.5 tabular-nums">{count}</span> : null}
      </h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function InboxRow({ item, actors }: { item: InboxItem; actors: Profile[] }) {
  const [, run] = useServerAction();
  const taskHref = useTaskHref();
  const actor = actors.find((p) => p.id === item.actorId);
  const { verb, ruleName } = describeInboxItem(item);
  const name = actor ? displayName(actor) : ruleName ? `Rule “${ruleName}”` : (item.emailFrom ?? "Someone");
  const markRead = () => {
    if (!item.readAt) run(() => markInboxRead([item.id]));
  };
  const body = (
    <>
      <Avatar name={name} src={actor?.avatar_url} profileId={actor?.id} size="md" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm text-zinc-700">
          <span className="font-medium text-zinc-900">{name}</span> {verb} <span className="font-medium text-zinc-900">{item.taskTitle}</span>
        </span>
        <Timestamp iso={item.createdAt} className="text-xs text-zinc-500" />
      </span>
    </>
  );
  const className = "flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-zinc-50";
  const isTask = item.taskId && !item.message && !item.teamMessage && !item.statusUpdate && !item.project;
  return (
    <li>
      {isTask ? (
        <TaskLink
          taskId={item.taskId!}
          seed={() => seedFromTitle(item.taskId!, item.taskTitle, { parentTitle: item.parentTitle })}
          onClick={markRead}
          className={className}
        >
          {body}
        </TaskLink>
      ) : (
        <Link href={inboxItemHref(item, taskHref)} onClick={markRead} className={className}>
          {body}
        </Link>
      )}
    </li>
  );
}
