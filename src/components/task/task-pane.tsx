import { requireMember } from "@/lib/auth";
import { getTaskDetail, listMyProjectRoles, listProfiles, listProjects } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import { isUuid } from "@/lib/ids";
import { TaskDetailPanel, TaskNotFoundPanel } from "./task-detail-panel";

export async function TaskPane({ taskId }: { taskId: string }) {
  if (!isUuid(taskId)) return <TaskNotFoundPanel />;
  const [member, task, projects, profiles, roles] = await Promise.all([
    requireMember(),
    getTaskDetail(taskId),
    listProjects(),
    listProfiles(),
    listMyProjectRoles(),
  ]);
  if (!task) return <TaskNotFoundPanel />;

  return (
    <TaskDetailPanel
      key={task.id}
      task={task}
      projects={projects.map(({ id, name }) => ({ id, name, canAdd: hasRole(roles.get(id), "editor") }))}
      profiles={profiles}
      memberId={member.id}
    />
  );
}
