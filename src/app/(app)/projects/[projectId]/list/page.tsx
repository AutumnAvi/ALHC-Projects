import type { Metadata } from "next";
import { ListView } from "@/components/project/list-view";
import { TaskPane } from "@/components/task/task-pane";
import {
  getProject,
  listProfiles,
  listProjectFields,
  listProjectTasks,
  listSections,
} from "@/lib/data";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/list">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · List` : "List" };
}

export default async function ProjectListPage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/list">) {
  const { projectId } = await params;
  const { task } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;

  const [sections, tasks, profiles, fields] = await Promise.all([
    listSections(projectId),
    listProjectTasks(projectId),
    listProfiles(),
    listProjectFields(projectId),
  ]);

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <ListView
        projectId={projectId}
        sections={sections}
        tasks={tasks}
        profiles={profiles}
        fields={fields}
        openTaskId={openTaskId}
      />
      {openTaskId ? <TaskPane taskId={openTaskId} /> : null}
    </main>
  );
}
