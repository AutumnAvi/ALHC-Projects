import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { NoProjectAccess } from "@/components/project/no-project-access";
import { getProjectAccessStatus } from "@/lib/data";
import { isUuid } from "@/lib/ids";

export const metadata: Metadata = { title: "Project", robots: { index: false } };

// Oct 26 notes (batch 3): where the project layout sends someone who isn't part of the project (its own
// route, so no project page renders next to it). A deleted or unknown project is a 404; once they're a
// member it goes straight to the project.
export default async function ProjectAccessPage({ params }: PageProps<"/project-access/[projectId]">) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const access = await getProjectAccessStatus(projectId);
  if (access === "member") redirect(`/projects/${projectId}`);
  if (access === "missing") notFound();
  return <NoProjectAccess projectId={projectId} status={access} />;
}
