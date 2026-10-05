import type { Metadata } from "next";
import { CircleCheck } from "lucide-react";
import { MyTasksView } from "@/components/my-tasks/my-tasks-view";
import { TaskPaneBoundary } from "@/components/task/task-pane";
import { PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { listMyTasks } from "@/lib/data";

export const metadata: Metadata = { title: "My Tasks" };

export default async function MyTasksPage({ searchParams }: PageProps<"/my-tasks">) {
  const { task } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;
  const member = await requireMember();
  const { open, completed } = await listMyTasks(member.id);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={CircleCheck}
        title="My Tasks"
        description="Everything assigned to you, across every project, grouped by due date"
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl px-gutter pb-8 pt-2">
          <MyTasksView open={open} completed={completed} openTaskId={openTaskId} />
        </div>
      </div>
      {openTaskId ? <TaskPaneBoundary taskId={openTaskId} /> : null}
    </main>
  );
}
