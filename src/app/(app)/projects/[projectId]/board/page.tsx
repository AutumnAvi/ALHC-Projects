import type { Metadata } from "next";
import { BoardView } from "@/components/project/board-view";
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
}: PageProps<"/projects/[projectId]/board">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Board` : "Board" };
}

export default async function ProjectBoardPage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/board">) {
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
    <main className="flex min-h-0 flex-1 flex-col">
      <BoardView
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
