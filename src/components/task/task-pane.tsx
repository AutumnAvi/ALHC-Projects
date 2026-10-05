import { getTaskDetail, listProfiles, listProjects } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { TaskDetailPanel, TaskNotFoundPanel } from "./task-detail-panel";

export async function TaskPane({ taskId }: { taskId: string }) {
  if (!isUuid(taskId)) return <TaskNotFoundPanel />;
  const [task, projects, profiles] = await Promise.all([
    getTaskDetail(taskId),
    listProjects(),
    listProfiles(),
  ]);
  if (!task) return <TaskNotFoundPanel />;

  return (
    <TaskDetailPanel
      key={task.id}
      task={task}
      projects={projects.map(({ id, name }) => ({ id, name }))}
      profiles={profiles}
    />
  );
}
