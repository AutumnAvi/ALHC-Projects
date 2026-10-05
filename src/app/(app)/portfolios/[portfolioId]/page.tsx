import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortfolioOverview } from "@/components/portfolio/portfolio-overview";
import {
  countHiddenPortfolioProjects,
  getPortfolio,
  listMyProjectRoles,
  listPortfolioProjects,
  listProjects,
  portfolioReport,
} from "@/lib/data";
import { EMPTY_COUNTS } from "@/lib/portfolios";
import { getViewerTimeZone } from "@/lib/timezone";

export async function generateMetadata({ params }: PageProps<"/portfolios/[portfolioId]">): Promise<Metadata> {
  const { portfolioId } = await params;
  const portfolio = await getPortfolio(portfolioId);
  return { title: portfolio ? portfolio.name : "Portfolio" };
}

export default async function PortfolioPage({ params }: PageProps<"/portfolios/[portfolioId]">) {
  const { portfolioId } = await params;
  const timeZone = await getViewerTimeZone();
  const [portfolio, projects, byProject, totals, hidden, myRoles, allProjects] = await Promise.all([
    getPortfolio(portfolioId),
    listPortfolioProjects(portfolioId),
    portfolioReport(portfolioId, "project", timeZone),
    portfolioReport(portfolioId, "none", timeZone),
    countHiddenPortfolioProjects(portfolioId),
    listMyProjectRoles(),
    listProjects(),
  ]);
  if (!portfolio) notFound();

  const counts = new Map(byProject.map((row) => [row.bucket, row]));
  const inPortfolio = new Set(projects.map((p) => p.id));

  return (
    <PortfolioOverview
      portfolio={portfolio}
      totals={totals[0] ?? EMPTY_COUNTS}
      hiddenCount={hidden}
      cards={projects.map((project) => ({
        project,
        role: myRoles.get(project.id) ?? null,
        counts: counts.get(project.id) ?? EMPTY_COUNTS,
      }))}
      candidates={allProjects.filter((p) => !inPortfolio.has(p.id)).map(({ id, name }) => ({ id, name }))}
    />
  );
}
