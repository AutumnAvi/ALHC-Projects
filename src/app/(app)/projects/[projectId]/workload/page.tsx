import type { Metadata } from "next";
import { displayName } from "@/lib/people";
import { TaskPaneSlot } from "@/components/task/task-pane";
import { summaryPeople, workloadParams, workloadPeople } from "@/components/workload/workload-params";
import { WorkloadModeSwitch, WorkloadPeopleView } from "@/components/workload/workload-people-view";
import { WorkloadView } from "@/components/workload/workload-view";
import {
  getProject,
  getProjectRole,
  getWorkWeek,
  listNumberFields,
  listProfiles,
  listProjectMembers,
  listWorkloadCapacities,
  projectWorkload,
  workloadPeopleSummary,
} from "@/lib/data";
import { fieldNameWithSymbol, numberPrefixOf } from "@/lib/fields";
import { hasRole } from "@/lib/roles";

export async function generateMetadata({ params }: PageProps<"/projects/[projectId]/workload">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Workload` : "Workload" };
}

// Nov 2 notes (batch 13, note 86): by default the people view — what each person got done in a period,
// what's open and overdue (workload_people_summary, invoker). ?view=grid is the day-by-day grid: who has
// how much open work, per day or week (project_workload(), invoker, so RLS applies); drags go through the
// normal task update path.
export default async function ProjectWorkloadPage({ params, searchParams }: PageProps<"/projects/[projectId]/workload">) {
  const { projectId } = await params;
  const state = await workloadParams(await searchParams);
  const [profiles, workWeek] = await Promise.all([listProfiles(), getWorkWeek()]);

  if (state.mode === "people") {
    const summary = await workloadPeopleSummary({ projectId }, state.period.start, state.period.end, state.timeZone);
    return (
      <main className="flex min-h-0 flex-1 flex-col overflow-auto">
        <WorkloadModeSwitch mode="people" />
        <WorkloadPeopleView
          window={state.period}
          people={summaryPeople(summary ?? [], profiles)}
          workWeek={workWeek}
          available={summary !== null}
        />
        <TaskPaneSlot taskId={state.openTaskId} />
      </main>
    );
  }

  const [fields, members, capacities, role] = await Promise.all([
    listNumberFields([projectId]),
    listProjectMembers(projectId),
    listWorkloadCapacities("project", projectId),
    getProjectRole(projectId),
  ]);
  const measure = fields.some((f) => f.id === state.measure) ? state.measure : "";
  const tasks = await projectWorkload(projectId, state.start, state.end, measure || null);
  const people = workloadPeople(
    members.map((m) => m.profileId),
    tasks,
    capacities,
    profiles,
  );
  // One person's grid (opened from the people view), even when they have nothing open in this window.
  const focusProfile = state.person ? profiles.find((p) => p.id === state.person) : undefined;
  const focus = state.person
    ? (people.find((p) => p.id === state.person) ?? (focusProfile ? { id: focusProfile.id, name: displayName(focusProfile) } : null))
    : null;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto">
      <WorkloadModeSwitch mode="grid" />
      <WorkloadView
        scope={{ projectId }}
        anchor={state.anchor}
        zoom={state.zoom}
        today={state.today}
        people={focus ? [focus] : people}
        tasks={focus ? tasks.filter((t) => t.assigneeId === focus.id) : tasks}
        focus={focus}
        workWeek={workWeek}
        capacities={capacities}
        measures={[
          { value: "", label: "Task count" },
          ...fields.map((f) => ({ value: f.id, label: fieldNameWithSymbol(f), symbol: numberPrefixOf(f) })),
        ]}
        measure={measure}
        canEditCapacity={hasRole(role, "editor")}
      />
      <TaskPaneSlot taskId={state.openTaskId} />
    </main>
  );
}
