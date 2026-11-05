import type { Metadata } from "next";
import { MessageThreadList } from "@/components/messages/messages";
import { requireMember } from "@/lib/auth";
import { getProject, listMessageThreads, listProfiles, listProjectMembers } from "@/lib/data";
import { messageCandidates } from "./candidates";

export async function generateMetadata({ params }: PageProps<"/projects/[projectId]/messages">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Messages` : "Messages" };
}

// Project Messages: threads anyone in the project can read (RLS: Viewer+); Commenters+ post.
export default async function ProjectMessagesPage({ params }: PageProps<"/projects/[projectId]/messages">) {
  const { projectId } = await params;
  const [member, threads, profiles, members] = await Promise.all([
    requireMember(),
    listMessageThreads(projectId),
    listProfiles(),
    listProjectMembers(projectId),
  ]);
  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <MessageThreadList
        projectId={projectId}
        threads={threads}
        profiles={profiles}
        candidates={messageCandidates(members, member.id)}
      />
    </main>
  );
}
