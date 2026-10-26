"use client";

import Link from "next/link";
import { useOptimistic, useState } from "react";
import { Archive, AtSign, Bookmark, Inbox, ListFilter } from "lucide-react";
import { useConfirm, usePrompt } from "@/components/confirm";
import { InboxCard, inboxItemHref, type CardState, type Decision } from "@/components/inbox/inbox-card";
import { useInboxDensity } from "@/components/inbox/inbox-density";
import { InboxToolbar } from "@/components/inbox/inbox-toolbar";
import { useTaskHref } from "@/components/project/shared";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { ShowMoreRows, useGroupPages } from "@/components/show-more";
import { useServerAction } from "@/components/toast";
import { EmptyState, HEADER_TAB } from "@/components/ui";
import {
  archiveInboxItems,
  decideApproval,
  markInboxRead,
  markInboxUnread,
  setInboxBookmark,
  type ActionResult,
} from "@/lib/actions";
import type { InboxItem, Profile } from "@/lib/data";
import {
  INBOX_LIMIT,
  INBOX_TABS,
  NO_INBOX_FILTER,
  groupByDay,
  inboxCategory,
  inboxFilterCount,
  inboxTabHref,
  sortInbox,
  type InboxCategory,
  type InboxFilter,
  type InboxSort,
  type InboxTab,
} from "@/lib/inbox";
import { useRealtimeRefresh } from "@/lib/realtime";

// The Inbox (Asana parity, batch 5): tabs Activity / Bookmarks / Archive / @Mentioned, a toolbar
// (Filter, Sort, Density, Manage notifications, "…"), and notification cards grouped by day in a
// centered column. A card opens its task in the pane next to the list (?task=), or a message in its
// thread. Filter and Sort stay while moving between tabs; Density is remembered per browser.

type Override = Partial<CardState>;

export function InboxView({
  tab,
  items,
  profiles,
  memberId,
  bookmarks,
  timeZone,
  today,
}: {
  tab: InboxTab;
  items: InboxItem[];
  profiles: Profile[];
  memberId: string;
  // This release's migration is applied (hasBatch5Schema()): bookmarks work.
  bookmarks: boolean;
  // The viewer's zone and local day, from the server, so day headings match on both sides.
  timeZone: string;
  today: string;
}) {
  useRealtimeRefresh(`inbox-${memberId}`, [
    { table: "inbox_items", filter: `recipient_id=eq.${memberId}` },
  ]);
  const taskHref = useTaskHref();
  // The task whose pane is open (instant: no server render on open / close; Oct 19 notes).
  const openTaskId = useOpenTaskId();
  const pages = useGroupPages();
  const density = useInboxDensity();
  const [, run] = useServerAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [filter, setFilter] = useState<InboxFilter>(NO_INBOX_FILTER);
  const [sort, setSort] = useState<InboxSort>("newest");
  const [clickedId, setClickedId] = useState<string | null>(null);
  // Read, archived, and bookmarked changes show at once and last until the refresh lands.
  const [overrides, override] = useOptimistic(
    new Map<string, Override>(),
    (current, change: { ids: string[]; patch: Override }) => {
      const next = new Map(current);
      for (const id of change.ids) next.set(id, { ...next.get(id), ...change.patch });
      return next;
    },
  );
  const profilesById = new Map(profiles.map((p) => [p.id, p]));

  const states = new Map<string, CardState>(
    items.map((item) => {
      const o = overrides.get(item.id);
      return [
        item.id,
        {
          read: o?.read ?? Boolean(item.readAt),
          archived: o?.archived ?? Boolean(item.archivedAt),
          bookmarked: o?.bookmarked ?? Boolean(item.bookmarkedAt),
        },
      ];
    }),
  );
  const stateOf = (item: InboxItem) => states.get(item.id) as CardState;
  const isRead = (item: InboxItem) => stateOf(item).read;

  // Archiving here (Activity) or moving back (Archive), and removing a bookmark (Bookmarks), take the
  // card out of the tab right away. @Mentioned holds archived and unarchived mentions alike.
  const tabItems = items.filter((item) => {
    const state = stateOf(item);
    if (tab === "activity") return !state.archived;
    if (tab === "archive") return state.archived;
    if (tab === "bookmarks") return state.bookmarked;
    return true;
  });

  // The card whose task is open in the pane: the one clicked, else the first one about that task.
  const activeId = openTaskId
    ? ((tabItems.find((item) => item.id === clickedId && item.taskId === openTaskId) ??
        tabItems.find((item) => item.taskId === openTaskId))?.id ?? null)
    : null;

  const categoryCounts = new Map<InboxCategory, number>();
  for (const item of tabItems) {
    const category = inboxCategory(item);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const filtering = inboxFilterCount(filter) > 0;
  const visible = tabItems.filter((item) => {
    if (filter.categories.length > 0 && !filter.categories.includes(inboxCategory(item))) return false;
    // "Unread only" keeps the open card, which opening just marked read.
    if (filter.unreadOnly && isRead(item) && item.id !== activeId) return false;
    return true;
  });
  const sorted = sortInbox(visible, sort, isRead);
  const blocks =
    sort === "unread"
      ? [
          { key: "unread", label: "Unread", items: sorted.filter((item) => !isRead(item)) },
          { key: "read", label: "Read", items: sorted.filter(isRead) },
        ].filter((block) => block.items.length > 0)
      : [{ key: "all", label: null, items: sorted }];

  function change(ids: string[], patch: Override, action: () => Promise<ActionResult>) {
    run(action, () => override({ ids, patch }));
  }

  const setRead = (item: InboxItem, read: boolean) =>
    change([item.id], { read }, () => (read ? markInboxRead([item.id]) : markInboxUnread(item.id)));

  // The approver decides a pending request right here (decide_approval: approver only, Commenter+).
  async function decide(item: InboxItem, decision: Decision) {
    if (!item.approval) return;
    let note: string | undefined;
    if (decision !== "approved") {
      const rejecting = decision === "rejected";
      const answer = await prompt({
        title: rejecting ? "Reject this request?" : "Request changes?",
        label: "Note for the requester (optional)",
        placeholder: rejecting ? undefined : "What should change?",
        confirmLabel: rejecting ? "Reject" : "Request changes",
        tone: rejecting ? "danger" : "default",
      });
      if (answer === null) return;
      note = answer.trim() || undefined;
    }
    const approvalId = item.approval.id;
    change([item.id], { read: true }, () => decideApproval(approvalId, decision, note));
  }

  // "Mark all as read" on Activity covers every unread notification, older ones past the newest
  // INBOX_LIMIT included; on the other tabs, the unread ones in that tab. They turn read at once.
  const unreadIds = tabItems.filter((item) => !isRead(item)).map((item) => item.id);
  function markAllRead() {
    change(unreadIds, { read: true }, () => markInboxRead(tab === "activity" ? "all" : unreadIds));
  }

  // Activity only. With a filter on it archives just the notifications shown; otherwise every one in
  // Activity, including older ones past the newest INBOX_LIMIT.
  const archiveAll =
    tab === "activity"
      ? {
          label:
            !filtering || visible.length === 0
              ? "Archive all notifications"
              : visible.length === 1
                ? "Archive this notification"
                : `Archive these ${visible.length} notifications`,
          disabled: (filtering ? visible : tabItems).length === 0,
          run: async () => {
            const ids = (filtering ? visible : tabItems).map((item) => item.id);
            const question = filtering
              ? `Archive the ${ids.length === 1 ? "notification" : `${ids.length} notifications`} that match your filters?`
              : "Archive every notification in Activity?";
            const ok = await confirm({ title: question, message: "You can move them back from the Archive tab.", confirmLabel: "Archive" });
            if (!ok) return;
            change(ids, { archived: true }, () => archiveInboxItems(filtering ? ids : "all", true));
          },
        }
      : null;

  return (
    <>
      <header className="shrink-0 px-gutter pt-2.5">
        <div className="flex h-8 items-center">
          <h1 className="truncate text-xl font-semibold tracking-tight text-zinc-900">Inbox</h1>
        </div>
        <nav aria-label="Inbox tabs" className="tab-strip -mx-gutter mt-1 items-center gap-0.5 px-gutter">
          {INBOX_TABS.map((t) => (
            <Link
              key={t.key}
              href={inboxTabHref(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={HEADER_TAB}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </header>
      <InboxToolbar
        filter={filter}
        onFilterChange={setFilter}
        sort={sort}
        onSortChange={setSort}
        categoryCounts={categoryCounts}
        canMarkAllRead={unreadIds.length > 0}
        onMarkAllRead={markAllRead}
        archiveAll={archiveAll}
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="px-gutter pb-10 pt-5">
          <div className="mx-auto w-full max-w-150">
            {tabItems.length === 0 ? (
              <TabEmptyState tab={tab} bookmarks={bookmarks} />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={ListFilter}
                title="No notifications match your filters"
                action={
                  <button type="button" onClick={() => setFilter(NO_INBOX_FILTER)} className="btn-secondary">
                    Clear filters
                  </button>
                }
              >
                {tabItems.length === 1 ? "This tab has 1 notification" : `This tab has ${tabItems.length} notifications`},
                but none of them match.
              </EmptyState>
            ) : (
              blocks.map((block) => (
                <div key={block.key} className="mt-8 first:mt-0">
                  {block.label ? (
                    <h2 className="mb-3 flex items-baseline gap-1.5 text-sm font-semibold text-zinc-900">
                      {block.label}
                      <span className="text-xs font-normal tabular-nums text-zinc-400">{block.items.length}</span>
                    </h2>
                  ) : null}
                  {groupByDay(block.items, timeZone, today).map((group) => {
                    const DayHeading = block.label ? "h3" : "h2";
                    const headingId = `inbox-day-${block.key}-${group.day}`;
                    const pageKey = `${block.key}-${group.day}`;
                    return (
                      <section key={group.day} aria-labelledby={headingId} className="mt-5 first:mt-0">
                        <DayHeading id={headingId} className="mb-2 px-1 text-xs font-medium text-zinc-500">
                          {group.label}
                        </DayHeading>
                        <ul className="space-y-2" aria-label={`Notifications from ${group.label}`}>
                          {group.items.slice(0, pages.limit(pageKey)).map((item) => (
                            <InboxCard
                              key={item.id}
                              item={item}
                              actor={item.actorId ? profilesById.get(item.actorId) : undefined}
                              state={stateOf(item)}
                              density={density}
                              active={item.id === activeId}
                              href={inboxItemHref(item, taskHref)}
                              memberId={memberId}
                              bookmarks={bookmarks}
                              onOpen={() => {
                                setClickedId(item.id);
                                if (!isRead(item)) setRead(item, true);
                              }}
                              onRead={(read) => setRead(item, read)}
                              onArchive={(archived) =>
                                change([item.id], { archived }, () => archiveInboxItems([item.id], archived))
                              }
                              onBookmark={(bookmarked) =>
                                change([item.id], { bookmarked }, () => setInboxBookmark(item.id, bookmarked))
                              }
                              onDecide={(decision) => decide(item, decision)}
                            />
                          ))}
                          {group.items.length > pages.limit(pageKey) ? (
                            <li>
                              <ShowMoreRows
                                hidden={group.items.length - pages.limit(pageKey)}
                                onClick={() => pages.showMore(pageKey)}
                              />
                            </li>
                          ) : null}
                        </ul>
                      </section>
                    );
                  })}
                </div>
              ))
            )}
            {items.length >= INBOX_LIMIT ? (
              <p className="mt-8 text-center text-xs text-zinc-400">
                Showing the latest {INBOX_LIMIT} notifications
                {tab === "activity" ? ". Archive some to see older ones." : "."}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function TabEmptyState({ tab, bookmarks }: { tab: InboxTab; bookmarks: boolean }) {
  switch (tab) {
    case "bookmarks":
      return bookmarks ? (
        <EmptyState icon={Bookmark} title="Bookmark notifications to come back to them">
          Use the bookmark icon on a notification (it shows when you point at one) to keep it here. Bookmarks stay
          until you remove them, even after you archive the notification.
        </EmptyState>
      ) : (
        <EmptyState icon={Bookmark} title="Bookmarks need this release’s database update">
          It isn’t applied to this workspace yet, so notifications can’t be bookmarked. Activity, Archive, and
          @Mentioned work as usual.
        </EmptyState>
      );
    case "archive":
      return (
        <EmptyState icon={Archive} title="Nothing archived">
          Archive notifications you’re done with to clear Activity. They stay here, and you can move them back.
        </EmptyState>
      );
    case "mentioned":
      return (
        <EmptyState icon={AtSign} title="No @mentions yet">
          When someone @mentions you in a task comment or a project message, it shows up here,
          archived or not.
        </EmptyState>
      );
    default:
      return (
        <EmptyState icon={Inbox} title="You’re all caught up">
          You’ll hear about tasks assigned to you, @mentions, approvals, messages, status updates, rule
          notifications, and comments, completions, and field changes on tasks you follow (choose which in Manage
          notifications). Archived notifications are in Archive.
        </EmptyState>
      );
  }
}
