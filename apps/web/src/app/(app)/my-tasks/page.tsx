import type { Metadata } from "next";
import { cookies } from "next/headers";
import { CircleCheck } from "lucide-react";
import { bulkContextFrom } from "@/components/bulk/bulk-context";
import { MyTasksView } from "@/components/my-tasks/my-tasks-view";
import { MyTasksChecklist } from "@/components/my-tasks/my-tasks-checklist";
import { TaskPaneSlot } from "@/components/task/task-pane";
import { SyncCalendarButton } from "@/components/calendar/sync-calendar-dialog";
import { PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { MyTaskRulesButton } from "@/components/my-tasks/my-task-rules";
import { listMyTaskLayout, listSubtaskTrees } from "@/lib/data";
import { type MyTask } from "@alhc/core/api/my-tasks/model";
import { loadAppShell, loadMyTasksScreen } from "@/lib/screen-loaders";
import { myTaskRuleContextFrom } from "@alhc/core/api/screens/model";
import { MY_TASKS_LAYOUT_COOKIE, myTasksLayoutOf } from "@alhc/core/my-tasks";
import { permissionsFor } from "@alhc/core/permissions";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@alhc/core/workload";

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
    // Nov 4 notes (batch 22, M1): everything else in one call (my_tasks_screen), with the app shell the
    // layout already read.
    const [{ sections }, screen, shell] = await Promise.all([listMyTaskLayout(), loadMyTasksScreen(), loadAppShell()]);
    const { open, completed, awaiting, rules, loadedAt } = screen;
    const { myTasksChecked: checked, workWeek, projects, myRoles: roles, profiles } = shell;
    const ruleCtx = myTaskRuleContextFrom(sections, shell, screen);
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
              <MyTaskRulesButton className="btn-ghost" rules={rules} ctx={ruleCtx} />
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
              loadedAt={loadedAt}
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
  // Nov 4 notes (batch 22, M1): one call (my_tasks_screen) plus the app shell the layout already read; the
  // rows this person opened (Oct 27 notes, batch 6) are in the shell's preferences.
  const [screen, shell] = await Promise.all([loadMyTasksScreen(), loadAppShell()]);
  const { open, completed, awaiting, rules, loadedAt } = screen;
  const bulk = bulkContextFrom(shell, null, null, member.id);
  const { expandedTaskIds, profiles } = shell;
  const ruleCtx = myTaskRuleContextFrom(sections, shell, screen);
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
            <MyTaskRulesButton rules={rules} ctx={ruleCtx} />
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
            loadedAt={loadedAt}
          />
        </div>
      </div>
      <TaskPaneSlot taskId={openTaskId} />
    </main>
  );
}
