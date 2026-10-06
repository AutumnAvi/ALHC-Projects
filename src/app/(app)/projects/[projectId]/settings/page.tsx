import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { History } from "lucide-react";
import { RoleGate } from "@/components/project/project-access";
import { ProjectSettings } from "@/components/project/project-settings";
import { ProjectStatusForm } from "@/components/project/project-status-form";
import { ProjectStatusHistory } from "@/components/project/project-status-history";
import {
  getProject,
  getProjectOrigin,
  getRequestSequence,
  listProjectStatusUpdates,
  type ProjectOrigin,
} from "@/lib/data";
import { getViewerTimeZone } from "@/lib/timezone";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/settings">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Settings` : "Settings" };
}

export default async function ProjectSettingsPage({
  params,
}: PageProps<"/projects/[projectId]/settings">) {
  const { projectId } = await params;
  const [project, sequence, origin, timeZone, statusUpdates] = await Promise.all([
    getProject(projectId),
    getRequestSequence(projectId),
    getProjectOrigin(projectId),
    getViewerTimeZone(),
    listProjectStatusUpdates(projectId),
  ]);
  if (!project) notFound();

  // Status is Editor+, so it sits outside the admin-only gate below.
  return (
    <>
      {origin ? <OriginNote origin={origin} timeZone={timeZone} /> : null}
      <ProjectStatusForm project={project} />
      <ProjectStatusHistory updates={statusUpdates} />
      <RoleGate need="admin" what="project settings">
        <ProjectSettings project={project} sequence={sequence} />
      </RoleGate>
    </>
  );
}

// The project story written by the copy engine (Duplicate project / Use template).
function OriginNote({ origin, timeZone }: { origin: ProjectOrigin; timeZone: string }) {
  const when = new Date(origin.createdAt).toLocaleDateString("en-US", { timeZone, dateStyle: "medium" });
  const from = origin.fromName ?? (origin.kind === "duplicated" ? "another project" : "a template");
  return (
    <div className="mx-auto max-w-3xl px-gutter pt-5">
      <p className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
        <History className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
        <span>
          {origin.kind === "duplicated" ? "Duplicated from " : "Created from the template "}
          {origin.kind === "duplicated" && origin.fromProjectId ? (
            <Link href={`/projects/${origin.fromProjectId}`} className="font-medium text-zinc-800 hover:underline">
              {from}
            </Link>
          ) : (
            <span className="font-medium text-zinc-800">{from}</span>
          )}
          {origin.actorName ? ` by ${origin.actorName}` : ""} on {when}. Copied rules started turned off.
        </span>
      </p>
    </div>
  );
}
