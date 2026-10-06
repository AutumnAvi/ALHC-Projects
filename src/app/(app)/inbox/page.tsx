import type { Metadata } from "next";
import { InboxView } from "@/components/inbox/inbox-view";
import { TaskPaneBoundary } from "@/components/task/task-pane";
import { requireMember } from "@/lib/auth";
import { listInbox, listProfiles } from "@/lib/data";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const { task, tab: tabParam } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;
  const tab = tabParam === "archived" ? "archived" : "active";
  const [member, items, profiles] = await Promise.all([
    requireMember(),
    listInbox(tab),
    listProfiles(),
  ]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <InboxView key={tab} tab={tab} items={items} profiles={profiles} memberId={member.id} openTaskId={openTaskId} />
      {openTaskId ? <TaskPaneBoundary taskId={openTaskId} /> : null}
    </main>
  );
}
