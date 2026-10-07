import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  assigneeBars,
  loadOverdueRows,
  loadReportContext,
  projectBars,
  sectionBars,
} from "@/components/reports/load-report";
import { PersonalDashboardView, type WidgetPayload } from "@/components/reports/personal-dashboard";
import {
  getPersonalDashboard,
  listPersonalWidgets,
  reportCompletedSeries,
  workspaceReport,
  workspaceTotals,
} from "@/lib/data";
import { isUuid } from "@/lib/ids";
import type { PersonalWidget } from "@/lib/reports";
import { getViewerTimeZone } from "@/lib/timezone";

export async function generateMetadata({ params }: PageProps<"/reports/dashboards/[dashboardId]">): Promise<Metadata> {
  const { dashboardId } = await params;
  const dashboard = isUuid(dashboardId) ? await getPersonalDashboard(dashboardId) : null;
  return { title: dashboard ? `${dashboard.name} · Reports` : "Dashboard" };
}

// A personal dashboard (owner-only RLS: anyone else gets a 404). Each widget's numbers come from the
// workspace report RPCs, so a widget limited to a project the owner can no longer read is empty.
export default async function PersonalDashboardPage({ params }: PageProps<"/reports/dashboards/[dashboardId]">) {
  const { dashboardId } = await params;
  if (!isUuid(dashboardId)) notFound();
  const dashboard = await getPersonalDashboard(dashboardId);
  if (!dashboard) notFound();

  const timeZone = await getViewerTimeZone();
  const [widgets, context] = await Promise.all([listPersonalWidgets(dashboardId), loadReportContext(timeZone)]);

  async function payload(widget: PersonalWidget): Promise<WidgetPayload> {
    const { filters } = widget;
    switch (widget.kind) {
      case "count":
        return { type: "count", value: (await workspaceTotals(filters, timeZone)).total };
      case "by_project":
        return { type: "bars", bars: projectBars(await workspaceReport(filters, "project", timeZone), context), more: 0 };
      case "by_assignee":
        return { type: "bars", bars: assigneeBars(await workspaceReport(filters, "assignee", timeZone), context), more: 0 };
      case "by_section":
        return { type: "bars", ...(await sectionBars(await workspaceReport(filters, "section", timeZone), context)) };
      case "completed_series":
        return { type: "series", points: await reportCompletedSeries(filters, widget.interval, timeZone) };
      case "overdue_list":
        return { type: "overdue", rows: await loadOverdueRows(filters, timeZone, context, 100) };
    }
  }

  const data = await Promise.all(widgets.map(async (widget) => ({ widget, payload: await payload(widget) })));

  return (
    <PersonalDashboardView dashboard={dashboard} widgets={data} projects={context.projects} people={context.people} tags={context.tags} />
  );
}
