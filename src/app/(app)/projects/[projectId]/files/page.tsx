import type { Metadata } from "next";
import { ProjectFiles } from "@/components/project/project-files";
import { getProject, listProfiles, listProjectFiles } from "@/lib/data";

export async function generateMetadata({ params }: PageProps<"/projects/[projectId]/files">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Files` : "Files" };
}

// Files: every attachment on the project's tasks (and their subtasks) the viewer can read, like Asana's
// Files tab. Uploading happens on a task; this page lists, previews, and downloads.
export default async function ProjectFilesPage({ params }: PageProps<"/projects/[projectId]/files">) {
  const { projectId } = await params;
  const [files, profiles] = await Promise.all([listProjectFiles(projectId), listProfiles()]);
  const names = Object.fromEntries(profiles.map((p) => [p.id, p.full_name || p.email]));

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <ProjectFiles projectId={projectId} files={files} uploaderNames={names} />
    </main>
  );
}
