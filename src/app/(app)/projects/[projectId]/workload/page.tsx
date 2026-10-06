import type { Metadata } from "next";
import { TaskPaneBoundary } from "@/components/task/task-pane";
import { workloadParams, workloadPeople } from "@/components/workload/workload-params";
import { WorkloadView } from "@/components/workload/workload-view";
import {
  getProject,
  getProjectRole,
  listNumberFields,
  listProfiles,
  listProjectMembers,
  listWorkloadCapacities,
  projectWorkload,
} from "@/lib/data";
import { hasRole } from "@/lib/roles";

export async function generateMetadata({ params }: PageProps<"/projects/[projectId]/workload">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Workload` : "Workload" };
}

// Who has how much open work, per day or week. Data comes from project_workload() (invoker, so RLS
// applies); drags go through the normal task update path.
export default async function ProjectWorkloadPage({ params, searchParams }: PageProps<"/projects/[projectId]/workload">) {
  const { projectId } = await params;
  const state = await workloadParams(await searchParams);
  const [fields, members, profiles, capacities, role] = await Promise.all([
    listNumberFields([projectId]),
    listProjectMembers(projectId),
    listProfiles(),
    listWorkloadCapacities("project", projectId),
    getProjectRole(projectId),
  ]);
  const measure = fields.some((f) => f.id === state.measure) ? state.measure : "";
  const tasks = await projectWorkload(projectId, state.start, state.end, measure || null);

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto">
      <WorkloadView
        scope={{ projectId }}
        anchor={state.anchor}
        zoom={state.zoom}
        today={state.today}
        people={workloadPeople(
          members.map((m) => m.profileId),
          tasks,
          capacities,
          profiles,
        )}
        tasks={tasks}
        capacities={capacities}
        measures={[{ value: "", label: "Task count" }, ...fields.map((f) => ({ value: f.id, label: f.name }))]}
        measure={measure}
        canEditCapacity={hasRole(role, "editor")}
      />
      {state.openTaskId ? <TaskPaneBoundary taskId={state.openTaskId} /> : null}
    </main>
  );
}
