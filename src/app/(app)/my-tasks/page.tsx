import type { Metadata } from "next";
import { MyTasksView } from "@/components/my-tasks/my-tasks-view";
import { TaskPane } from "@/components/task/task-pane";
import { requireMember } from "@/lib/auth";
import { listMyTasks } from "@/lib/data";

export const metadata: Metadata = { title: "My Tasks" };

export default async function MyTasksPage({ searchParams }: PageProps<"/my-tasks">) {
  const { task } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;
  const member = await requireMember();
  const { open, completed } = await listMyTasks(member.id);

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-6">
        <h1 className="text-xl font-semibold tracking-tight">My Tasks</h1>
        <p className="mt-0.5 text-sm text-zinc-600">
          Everything assigned to you, across every project, grouped by due date.
        </p>
        <MyTasksView open={open} completed={completed} openTaskId={openTaskId} />
      </div>
      {openTaskId ? <TaskPane taskId={openTaskId} /> : null}
    </main>
  );
}
