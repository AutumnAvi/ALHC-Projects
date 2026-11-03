import type { Metadata } from "next";
import { cookies } from "next/headers";
import { CircleCheck } from "lucide-react";
import { listBulkContext } from "@/components/bulk/bulk-context";
import { MyTasksView } from "@/components/my-tasks/my-tasks-view";
import { MyTasksChecklist } from "@/components/my-tasks/my-tasks-checklist";
import { TaskPaneSlot } from "@/components/task/task-pane";
import { SyncCalendarButton } from "@/components/calendar/sync-calendar-dialog";
import { PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { MyTaskRulesButton } from "@/components/my-tasks/my-task-rules";
import {
  getExpandedTaskIds,
  getMyTasksChecked,
  getWorkWeek,
  listAwaitingMyApproval,
  listMyProjectRoles,
  listMyTaskLayout,
  listMyTaskRules,
  listMyTasks,
  listProfiles,
  listProjects,
  listSubtaskTrees,
  type MyTask,
} from "@/lib/data";
import { MY_TASKS_LAYOUT_COOKIE, myTasksLayoutOf } from "@/lib/my-tasks";
import { permissionsFor } from "@/lib/permissions";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@/lib/workload";

export const metadata: Metadata = { title: "My tasks" };

export default async function MyTasksPage({ searchParams }: PageProps<"/my-tasks">) {
  const { task } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;
  const member = await requireMember();
  const layout = myTasksLayoutOf((await cookies()).get(MY_TASKS_LAYOUT_COOKIE)?.value);

  if (layout === "checklist") {
    const timeZone = await getViewerTimeZone();
    // Nov 1 notes (batch 9b, item 64): the checklist. The sections call still runs (it seeds the
    // person's sections and keeps placements current for the classic view and My Tasks rules), side by
    // side with the rest since the checklist doesn't order by it.
    const [{ sections }, { open, completed }, checked, workWeek, rules, projects, roles, profiles, awaiting] = await Promise.all([
      listMyTaskLayout(),
      listMyTasks(member.id),
      getMyTasksChecked(),
      getWorkWeek(),
      listMyTaskRules(),
      listProjects(),
      listMyProjectRoles(),
      listProfiles(),
      listAwaitingMyApproval(),
    ]);
    // #project in the quick add: active projects where the person can add tasks.
    const addable = projects.filter((p) => permissionsFor(roles.get(p.id) ?? null).canEdit).map((p) => ({ id: p.id, name: p.name }));
    const people = profiles.map((p) => ({ id: p.id, name: p.full_name?.trim() || p.email, email: p.email }));
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader
          icon={CircleCheck}
          title="My tasks"
          description="Everything assigned to you, as one checklist"
          actions={
            <div className="flex items-center gap-1">
              <MyTaskRulesButton
                className="btn-ghost"
                rules={rules}
                ctx={{ sections: sections.map((s) => ({ id: s.id, name: s.name })), projects: projects.map((p) => ({ id: p.id, name: p.name })), workWeek }}
              />
              <SyncCalendarButton scope="my_tasks" className="btn-ghost" />
            </div>
          }
        />
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="px-gutter pt-4">
            <MyTasksChecklist
              open={open}
              completed={completed}
              checked={checked}
              workWeek={workWeek}
              projects={addable}
              people={people}
              awaiting={awaiting}
              today={todayIn(timeZone)}
              timeZone={timeZone}
            />
          </div>
        </div>
        <TaskPaneSlot taskId={openTaskId} />
      </main>
    );
  }

  // The classic views (your sections, due-date buckets), as before.
  // The layout call seeds the viewer's sections and places newly assigned tasks first, so it runs
  // before the task lists are read.
  const { sections, placements } = await listMyTaskLayout();
  const [{ open, completed }, bulk, rules, projects, expandedTaskIds, awaiting, profiles, classicWorkWeek] = await Promise.all([
    listMyTasks(member.id),
    listBulkContext(null),
    listMyTaskRules(),
    listProjects(),
    // Oct 27 notes (batch 6): rows this person opened, and approvals waiting on them.
    getExpandedTaskIds(),
    listAwaitingMyApproval(),
    listProfiles(),
    getWorkWeek(),
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
              ctx={{ sections: sections.map((s) => ({ id: s.id, name: s.name })), projects: projects.map((p) => ({ id: p.id, name: p.name })), workWeek: classicWorkWeek }}
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
            layout={layout}
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
