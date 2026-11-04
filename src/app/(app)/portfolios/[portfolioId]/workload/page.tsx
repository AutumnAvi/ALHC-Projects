import type { Metadata } from "next";
import { displayName } from "@/lib/people";
import { TaskPaneSlot } from "@/components/task/task-pane";
import { summaryPeople, workloadParams, workloadPeople } from "@/components/workload/workload-params";
import { WorkloadModeSwitch, WorkloadPeopleView } from "@/components/workload/workload-people-view";
import { WorkloadView } from "@/components/workload/workload-view";
import {
  countHiddenPortfolioProjects,
  getPortfolio,
  getPortfolioRole,
  getWorkWeek,
  listNumberFields,
  listPortfolioMembers,
  listPortfolioRollupProjects,
  listProfiles,
  listWorkloadCapacities,
  portfolioWorkload,
  workloadPeopleSummary,
} from "@/lib/data";
import { numberPrefixOf } from "@/lib/fields";
import { hasPortfolioRole } from "@/lib/roles";

export async function generateMetadata({ params }: PageProps<"/portfolios/[portfolioId]/workload">): Promise<Metadata> {
  const { portfolioId } = await params;
  const portfolio = await getPortfolio(portfolioId);
  return { title: portfolio ? `${portfolio.name} · Workload` : "Workload" };
}

// Workload across the portfolio's projects the viewer can read, including projects of nested portfolios
// they're a member of (portfolio_workload() checks each project; portfolio membership never grants
// project access). A number field is chosen by name, so same-named fields in several projects add up.
export default async function PortfolioWorkloadPage({ params, searchParams }: PageProps<"/portfolios/[portfolioId]/workload">) {
  const { portfolioId } = await params;
  const state = await workloadParams(await searchParams);
  // Nov 2 notes (batch 13, note 86): the people view by default; ?view=grid = the day-by-day grid.
  if (state.mode === "people") {
    const [summary, profiles, workWeek, hidden] = await Promise.all([
      workloadPeopleSummary({ portfolioId }, state.period.start, state.period.end, state.timeZone),
      listProfiles(),
      getWorkWeek(),
      countHiddenPortfolioProjects(portfolioId),
    ]);
    return (
      <div className="flex min-h-full flex-col">
        <WorkloadModeSwitch mode="people" />
        <WorkloadPeopleView
          window={state.period}
          people={summaryPeople(summary ?? [], profiles)}
          workWeek={workWeek}
          available={summary !== null}
          hiddenProjects={hidden}
        />
        <TaskPaneSlot taskId={state.openTaskId} />
      </div>
    );
  }
  const [projects, members, profiles, capacities, role, hidden, workWeek] = await Promise.all([
    listPortfolioRollupProjects(portfolioId),
    listPortfolioMembers(portfolioId),
    listProfiles(),
    listWorkloadCapacities("portfolio", portfolioId),
    getPortfolioRole(portfolioId),
    countHiddenPortfolioProjects(portfolioId),
    getWorkWeek(),
  ]);
  const fieldNames = new Map<string, string>();
  // A measure's symbol (item 49) when every same-named number field shares it; none when they differ.
  const fieldSymbols = new Map<string, string | null>();
  for (const field of await listNumberFields(projects.map((p) => p.id))) {
    const key = field.name.trim().toLowerCase();
    if (!fieldNames.has(key)) fieldNames.set(key, field.name.trim());
    const symbol = numberPrefixOf(field);
    fieldSymbols.set(key, fieldSymbols.has(key) && fieldSymbols.get(key) !== symbol ? null : symbol);
  }
  const measure = fieldNames.get(state.measure.trim().toLowerCase()) ?? "";
  const tasks = await portfolioWorkload(portfolioId, state.start, state.end, measure || null);
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
    <div className="flex min-h-full flex-col">
      <WorkloadModeSwitch mode="grid" />
      <WorkloadView
        scope={{ portfolioId }}
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
          ...[...fieldNames.entries()].map(([key, name]) => {
            const symbol = fieldSymbols.get(key) ?? null;
            return { value: name, label: symbol ? `${name} (${symbol})` : name, symbol };
          }),
        ]}
        measure={measure}
        canEditCapacity={hasPortfolioRole(role, "editor")}
        projectNames={Object.fromEntries(projects.map((p) => [p.id, p.name]))}
        hiddenProjects={hidden}
      />
      <TaskPaneSlot taskId={state.openTaskId} />
    </div>
  );
}
