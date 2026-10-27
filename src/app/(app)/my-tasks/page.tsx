import type { Metadata } from "next";
import { cookies } from "next/headers";
import { CircleCheck } from "lucide-react";
import { listBulkContext } from "@/components/bulk/bulk-context";
import { MyTasksView } from "@/components/my-tasks/my-tasks-view";
import { TaskPaneSlot } from "@/components/task/task-pane";
import { SyncCalendarButton } from "@/components/calendar/sync-calendar-dialog";
import { PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { MyTaskRulesButton } from "@/components/my-tasks/my-task-rules";
import {
  getExpandedTaskIds,
  listAwaitingMyApproval,
  listMyTaskLayout,
  listMyTaskRules,
  listMyTasks,
  listProfiles,
  listProjects,
  listSubtaskTrees,
  type MyTask,
} from "@/lib/data";
import { MY_TASKS_LAYOUT_COOKIE, isMyTasksLayout } from "@/lib/my-tasks";

export const metadata: Metadata = { title: "My tasks" };

export default async function MyTasksPage({ searchParams }: PageProps<"/my-tasks">) {
  const { task } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;
  const member = await requireMember();
  const saved = (await cookies()).get(MY_TASKS_LAYOUT_COOKIE)?.value;
  // The layout call seeds the viewer's sections and places newly assigned tasks first, so it runs
  // before the task lists are read.
  const { sections, placements } = await listMyTaskLayout();
  const [{ open, completed }, bulk, rules, projects, expandedTaskIds, awaiting, profiles] = await Promise.all([
    listMyTasks(member.id),
    listBulkContext(null),
    listMyTaskRules(),
    listProjects(),
    // Oct 27 notes (batch 6): rows this person opened, and approvals waiting on them.
    getExpandedTaskIds(),
    listAwaitingMyApproval(),
    listProfiles(),
  ]);
  // The subtask trees of the open rows (trees load by their top-level task: a row that is itself a
  // subtask needs its root, when the data says which).
  const opened = new Set(expandedTaskIds);
  const rootOf = (task: MyTask) =>
    (task as MyTask & { rootTaskId?: string | null }).rootTaskId ?? (task.parentTitle ? null : task.id);
  const roots = [
    ...new Set(
      open.filter((task) => opened.has(task.id) && (task.subtaskCount ?? 0) > 0).flatMap((task) => rootOf(task) ?? []),
    ),
  ];
  const subtasks = roots.length ? await listSubtaskTrees(roots) : [];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={CircleCheck}
        title="My tasks"
        description="Everything assigned to you, across every project, in your own sections or by due date"
        actions={
          <div className="flex items-center gap-2">
            <MyTaskRulesButton
              rules={rules}
              ctx={{ sections: sections.map((s) => ({ id: s.id, name: s.name })), projects: projects.map((p) => ({ id: p.id, name: p.name })) }}
            />
            <SyncCalendarButton scope="my_tasks" className="btn-secondary" />
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="px-gutter pb-8 pt-2">
          <MyTasksView
            open={open}
            completed={completed}
            bulk={bulk}
            layout={isMyTasksLayout(saved) ? saved : "sections"}
            sections={sections}
            placements={placements}
            expandedTaskIds={expandedTaskIds}
            subtasks={subtasks}
            awaiting={awaiting}
            profiles={profiles}
          />
        </div>
      </div>
      <TaskPaneSlot taskId={openTaskId} />
    </main>
  );
}
