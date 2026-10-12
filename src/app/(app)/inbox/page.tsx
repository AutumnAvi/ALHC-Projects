import type { Metadata } from "next";
import { InboxView } from "@/components/inbox/inbox-view";
import { TaskPaneBoundary } from "@/components/task/task-pane";
import { requireMember } from "@/lib/auth";
import { hasBatch5Schema, listInbox, listProfiles } from "@/lib/data";
import { parseInboxTab } from "@/lib/inbox";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@/lib/workload";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const { task, tab: tabParam } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;
  // ?tab=archived (the old Archived tab) opens Archive.
  const tab = parseInboxTab(tabParam);
  const [member, items, profiles, bookmarks, timeZone] = await Promise.all([
    requireMember(),
    listInbox(tab),
    listProfiles(),
    hasBatch5Schema(),
    getViewerTimeZone(),
  ]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <InboxView
        tab={tab}
        items={items}
        profiles={profiles}
        memberId={member.id}
        openTaskId={openTaskId}
        bookmarks={bookmarks}
        timeZone={timeZone}
        today={todayIn(timeZone)}
      />
      {openTaskId ? <TaskPaneBoundary taskId={openTaskId} /> : null}
    </main>
  );
}
