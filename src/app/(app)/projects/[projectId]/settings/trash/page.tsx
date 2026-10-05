import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReadOnlyNotice } from "@/components/project/project-access";
import { TrashView } from "@/components/project/trash-view";
import { getProject, getProjectRole, listProfiles, listTrashedTasks } from "@/lib/data";
import { hasRole } from "@/lib/roles";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/settings/trash">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Trash` : "Trash" };
}

// Soft-deleted tasks of this project. RLS only returns trashed tasks to Editors and above, so the page
// doesn't even ask for them below Editor.
export default async function ProjectTrashPage({ params }: PageProps<"/projects/[projectId]/settings/trash">) {
  const { projectId } = await params;
  const [project, role] = await Promise.all([getProject(projectId), getProjectRole(projectId)]);
  if (!project || !role) notFound();

  if (!hasRole(role, "editor")) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-6">
        <ReadOnlyNotice need="editor" what="the Trash (see and restore deleted tasks)" />
      </div>
    );
  }

  const [tasks, profiles] = await Promise.all([listTrashedTasks(projectId), listProfiles()]);
  return <TrashView projectId={projectId} tasks={tasks} profiles={profiles} />;
}
