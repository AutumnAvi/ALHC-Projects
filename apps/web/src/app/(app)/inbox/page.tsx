import type { Metadata } from "next";
import { InboxView } from "@/components/inbox/inbox-view";
import { TaskPaneSlot } from "@/components/task/task-pane";
import { requireMember } from "@/lib/auth";
import { listInbox, listProfiles } from "@/lib/data";
import { parseInboxTab } from "@alhc/core/inbox";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@alhc/core/workload";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const { task, tab: tabParam } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;
  // ?tab=archived (the old Archived tab) opens Archive.
  const tab = parseInboxTab(tabParam);
  const [member, items, profiles, timeZone] = await Promise.all([
    requireMember(),
    listInbox(tab),
    listProfiles(),
    getViewerTimeZone(),
  ]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <InboxView
        tab={tab}
        items={items}
        profiles={profiles}
        memberId={member.id}
        bookmarks
        timeZone={timeZone}
        today={todayIn(timeZone)}
      />
      <TaskPaneSlot taskId={openTaskId} />
    </main>
  );
}
