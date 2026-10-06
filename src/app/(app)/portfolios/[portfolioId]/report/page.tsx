import type { Metadata } from "next";
import { PortfolioReport } from "@/components/portfolio/portfolio-report";
import {
  countHiddenPortfolioProjects,
  getPortfolio,
  listLatestStatusUpdates,
  listPortfolioChildren,
  listPortfolioFieldValues,
  listPortfolioFields,
  listPortfolioRollupProjects,
  listProfiles,
  portfolioReport,
} from "@/lib/data";
import { EMPTY_COUNTS } from "@/lib/portfolios";
import { getViewerTimeZone } from "@/lib/timezone";

export async function generateMetadata({ params }: PageProps<"/portfolios/[portfolioId]/report">): Promise<Metadata> {
  const { portfolioId } = await params;
  const portfolio = await getPortfolio(portfolioId);
  return { title: portfolio ? `${portfolio.name} · Report` : "Report" };
}

export default async function PortfolioReportPage({ params }: PageProps<"/portfolios/[portfolioId]/report">) {
  const { portfolioId } = await params;
  const timeZone = await getViewerTimeZone();
  const [projects, byProject, byAssignee, totals, hidden, profiles, children, fields, values] = await Promise.all([
    listPortfolioRollupProjects(portfolioId),
    portfolioReport(portfolioId, "project", timeZone),
    portfolioReport(portfolioId, "assignee", timeZone),
    portfolioReport(portfolioId, "none", timeZone),
    countHiddenPortfolioProjects(portfolioId),
    listProfiles(),
    listPortfolioChildren(portfolioId),
    listPortfolioFields(portfolioId),
    listPortfolioFieldValues(portfolioId),
  ]);
  const latest = await listLatestStatusUpdates(projects.map((p) => p.id));
  const projectCounts = new Map(byProject.map((row) => [row.bucket, row]));
  const names = new Map(profiles.map((p) => [p.id, p.full_name?.trim() || p.email]));
  // The portfolio's own projects first (portfolio order), then each nested portfolio's in nesting order.
  const groupOrder = new Map(children.map((c, i) => [c.id, i]));
  const groupNames = new Map(children.map((c) => [c.id, c.name]));
  const ordered = [...projects].sort(
    (a, b) =>
      (a.groupId === null ? -1 : (groupOrder.get(a.groupId) ?? children.length)) -
        (b.groupId === null ? -1 : (groupOrder.get(b.groupId) ?? children.length)) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  );

  return (
    <PortfolioReport
      portfolioId={portfolioId}
      totals={totals[0] ?? EMPTY_COUNTS}
      hiddenCount={hidden}
      projects={ordered.map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
        statusNote: project.statusNote,
        via: project.groupId ? (groupNames.get(project.groupId) ?? "A nested portfolio") : null,
        own: project.portfolioId === portfolioId,
        counts: projectCounts.get(project.id) ?? EMPTY_COUNTS,
        latest: latest.get(project.id) ?? null,
      }))}
      fields={fields}
      values={values}
      assignees={byAssignee
        .map((row) => ({ id: row.bucket, name: row.bucket ? (names.get(row.bucket) ?? "Unknown person") : "Unassigned", counts: row }))
        .sort(
          (a, b) =>
            Number(a.id === null) - Number(b.id === null) ||
            b.counts.incomplete - a.counts.incomplete ||
            a.name.localeCompare(b.name),
        )}
    />
  );
}
