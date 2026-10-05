import type { Metadata } from "next";
import { PortfolioReport } from "@/components/portfolio/portfolio-report";
import {
  countHiddenPortfolioProjects,
  getPortfolio,
  listPortfolioProjects,
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
  const [projects, byProject, byAssignee, totals, hidden, profiles] = await Promise.all([
    listPortfolioProjects(portfolioId),
    portfolioReport(portfolioId, "project", timeZone),
    portfolioReport(portfolioId, "assignee", timeZone),
    portfolioReport(portfolioId, "none", timeZone),
    countHiddenPortfolioProjects(portfolioId),
    listProfiles(),
  ]);
  const projectCounts = new Map(byProject.map((row) => [row.bucket, row]));
  const names = new Map(profiles.map((p) => [p.id, p.full_name?.trim() || p.email]));

  return (
    <PortfolioReport
      totals={totals[0] ?? EMPTY_COUNTS}
      hiddenCount={hidden}
      projects={projects.map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
        statusNote: project.status_note,
        counts: projectCounts.get(project.id) ?? EMPTY_COUNTS,
      }))}
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
