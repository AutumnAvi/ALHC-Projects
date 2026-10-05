import type { Metadata } from "next";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import {
  getProject,
  listDashboardWidgets,
  listProfiles,
  listProjectFields,
  listSections,
  projectMetrics,
} from "@/lib/data";
import { getViewerTimeZone } from "@/lib/timezone";
import { pruneFilters } from "@/lib/views";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/dashboard">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Dashboard` : "Dashboard" };
}

const GROUP_BY = { count: "none", by_section: "section", by_assignee: "assignee" } as const;

export default async function ProjectDashboardPage({ params }: PageProps<"/projects/[projectId]/dashboard">) {
  const { projectId } = await params;
  const [widgets, sections, profiles, fields, timeZone] = await Promise.all([
    listDashboardWidgets(projectId),
    listSections(projectId),
    listProfiles(),
    listProjectFields(projectId),
    getViewerTimeZone(),
  ]);
  const context = {
    sectionIds: new Set(sections.map((s) => s.id)),
    fields,
    profileIds: new Set(profiles.map((p) => p.id)),
  };
  const data = await Promise.all(
    widgets.map(async (widget) => {
      const filters = pruneFilters(widget.filters, context);
      const buckets = await projectMetrics(projectId, filters, GROUP_BY[widget.kind], timeZone);
      return { widget: { ...widget, filters }, buckets };
    }),
  );

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <DashboardView projectId={projectId} widgets={data} context={{ sections, profiles, fields }} />
    </main>
  );
}
