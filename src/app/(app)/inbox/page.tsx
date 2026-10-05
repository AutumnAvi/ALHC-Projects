import type { Metadata } from "next";
import { InboxView } from "@/components/inbox/inbox-view";
import { TaskPane } from "@/components/task/task-pane";
import { requireMember } from "@/lib/auth";
import { listInbox, listProfiles } from "@/lib/data";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const { task } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;
  const [member, items, profiles] = await Promise.all([
    requireMember(),
    listInbox(),
    listProfiles(),
  ]);

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <InboxView
          items={items}
          profiles={profiles}
          memberId={member.id}
          openTaskId={openTaskId}
        />
      </div>
      {openTaskId ? <TaskPane taskId={openTaskId} /> : null}
    </main>
  );
}
