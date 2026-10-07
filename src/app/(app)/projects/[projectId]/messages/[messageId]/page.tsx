import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MessageThreadView } from "@/components/messages/messages";
import { requireMember } from "@/lib/auth";
import { getMessageThread, listProfiles, listProjectMembers } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { messageCandidates } from "../candidates";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/messages/[messageId]">): Promise<Metadata> {
  const { messageId } = await params;
  const thread = isUuid(messageId) ? await getMessageThread(messageId) : null;
  return { title: thread ? `${thread.title} · Messages` : "Messages" };
}

// One thread and its replies. A deleted, missing, or unreadable thread (or one of another project) 404s.
export default async function MessageThreadPage({ params }: PageProps<"/projects/[projectId]/messages/[messageId]">) {
  const { projectId, messageId } = await params;
  if (!isUuid(messageId)) notFound();
  const [member, thread, profiles, members] = await Promise.all([
    requireMember(),
    getMessageThread(messageId),
    listProfiles(),
    listProjectMembers(projectId),
  ]);
  if (!thread || thread.projectId !== projectId) notFound();
  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <MessageThreadView
        thread={thread}
        profiles={profiles}
        candidates={messageCandidates(members, member.id)}
        memberId={member.id}
      />
    </main>
  );
}
