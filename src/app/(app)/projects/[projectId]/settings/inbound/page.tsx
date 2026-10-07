import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InboundSettings } from "@/components/project/inbound-settings";
import { ReadOnlyNotice } from "@/components/project/project-access";
import {
  getProject,
  getProjectRole,
  listInboundCalls,
  listInboundEndpoints,
  listProjectMembers,
  listSections,
  listTags,
} from "@/lib/data";
import { requestOrigin } from "@/lib/origin";
import { hasRole } from "@/lib/roles";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/settings/inbound">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Inbound` : "Inbound" };
}

// Inbound webhooks: endpoints that create tasks in this project from outside (Zapier, a website form,
// a script). Admin+ only: RLS returns nothing to anyone else, so the page doesn't ask below Admin.
export default async function ProjectInboundPage({ params }: PageProps<"/projects/[projectId]/settings/inbound">) {
  const { projectId } = await params;
  const [project, role] = await Promise.all([getProject(projectId), getProjectRole(projectId)]);
  if (!project || !role) notFound();

  if (!hasRole(role, "admin")) {
    return (
      <div className="mx-auto max-w-3xl px-gutter py-5">
        <ReadOnlyNotice need="admin" what="inbound webhooks" />
      </div>
    );
  }

  const [endpoints, calls, sections, members, tags, origin] = await Promise.all([
    listInboundEndpoints(projectId),
    listInboundCalls(projectId),
    listSections(projectId),
    listProjectMembers(projectId),
    listTags(),
    requestOrigin(),
  ]);
  if (!endpoints || !calls) notFound();

  return (
    <InboundSettings
      projectId={projectId}
      origin={origin}
      endpoints={endpoints}
      calls={calls}
      sections={sections.map((s) => ({ id: s.id, name: s.name }))}
      members={members.map((m) => ({ id: m.profileId, name: m.fullName?.trim() || m.email }))}
      tags={tags.map((t) => ({ id: t.id, name: t.name, archived: t.archivedAt !== null }))}
    />
  );
}
