import type { Metadata } from "next";
import { TaskPaneBoundary } from "@/components/task/task-pane";
import { workloadParams, workloadPeople } from "@/components/workload/workload-params";
import { WorkloadView } from "@/components/workload/workload-view";
import {
  countHiddenPortfolioProjects,
  getPortfolio,
  getPortfolioRole,
  listNumberFields,
  listPortfolioMembers,
  listPortfolioProjects,
  listProfiles,
  listWorkloadCapacities,
  portfolioWorkload,
} from "@/lib/data";
import { hasPortfolioRole } from "@/lib/roles";

export async function generateMetadata({ params }: PageProps<"/portfolios/[portfolioId]/workload">): Promise<Metadata> {
  const { portfolioId } = await params;
  const portfolio = await getPortfolio(portfolioId);
  return { title: portfolio ? `${portfolio.name} · Workload` : "Workload" };
}

// Workload across the portfolio's projects the viewer can read (portfolio_workload() checks each
// project; portfolio membership never grants project access). A number field is chosen by name, so
// same-named fields in several projects add up.
export default async function PortfolioWorkloadPage({ params, searchParams }: PageProps<"/portfolios/[portfolioId]/workload">) {
  const { portfolioId } = await params;
  const state = await workloadParams(await searchParams);
  const [projects, members, profiles, capacities, role, hidden] = await Promise.all([
    listPortfolioProjects(portfolioId),
    listPortfolioMembers(portfolioId),
    listProfiles(),
    listWorkloadCapacities("portfolio", portfolioId),
    getPortfolioRole(portfolioId),
    countHiddenPortfolioProjects(portfolioId),
  ]);
  const fieldNames = new Map<string, string>();
  for (const field of await listNumberFields(projects.map((p) => p.id))) {
    const key = field.name.trim().toLowerCase();
    if (!fieldNames.has(key)) fieldNames.set(key, field.name.trim());
  }
  const measure = fieldNames.get(state.measure.trim().toLowerCase()) ?? "";
  const tasks = await portfolioWorkload(portfolioId, state.start, state.end, measure || null);

  return (
    <div className="flex min-h-full flex-col">
      <WorkloadView
        scope={{ portfolioId }}
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
        measures={[{ value: "", label: "Task count" }, ...[...fieldNames.values()].map((name) => ({ value: name, label: name }))]}
        measure={measure}
        canEditCapacity={hasPortfolioRole(role, "editor")}
        projectNames={Object.fromEntries(projects.map((p) => [p.id, p.name]))}
        hiddenProjects={hidden}
      />
      {state.openTaskId ? <TaskPaneBoundary taskId={state.openTaskId} /> : null}
    </div>
  );
}
