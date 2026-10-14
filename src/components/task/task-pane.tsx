import dynamic from "next/dynamic";
import { Suspense } from "react";
import { requireMember } from "@/lib/auth";
import { getTaskDetail, listMyProjectRoles, listProfiles, listProjects, listTags } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import { isUuid } from "@/lib/ids";
import { TaskNotFoundPanel, TaskPaneLoading } from "./task-pane-frame";

// The detail panel pulls in comments, dates, and attachments. Load that chunk only once a task opens.
const TaskDetailPanel = dynamic(() => import("./task-detail-panel").then((mod) => mod.TaskDetailPanel));

// Streams the pane: the page underneath renders without waiting for the task, and the pane shows a
// skeleton right away. Keyed by task so switching tasks shows the skeleton again instead of the old task.
export function TaskPaneBoundary({ taskId }: { taskId: string }) {
  return (
    <Suspense key={taskId} fallback={<TaskPaneLoading />}>
      <TaskPane taskId={taskId} />
    </Suspense>
  );
}

export async function TaskPane({ taskId }: { taskId: string }) {
  if (!isUuid(taskId)) return <TaskNotFoundPanel />;
  const [member, task, projects, profiles, roles, tags] = await Promise.all([
    requireMember(),
    getTaskDetail(taskId),
    listProjects(),
    listProfiles(),
    listMyProjectRoles(),
    listTags(),
  ]);
  if (!task) return <TaskNotFoundPanel />;

  return (
    <TaskDetailPanel
      key={task.id}
      task={task}
      projects={projects.map(({ id, name }) => ({ id, name, canAdd: hasRole(roles.get(id), "editor") }))}
      profiles={profiles}
      memberId={member.id}
      tags={tags}
    />
  );
}
