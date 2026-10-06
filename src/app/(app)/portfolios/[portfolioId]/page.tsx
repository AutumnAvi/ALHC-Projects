import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortfolioOverview } from "@/components/portfolio/portfolio-overview";
import {
  countHiddenPortfolioProjects,
  getPortfolio,
  listLatestStatusUpdates,
  listMyProjectRoles,
  listPortfolioChildren,
  listPortfolioFieldValues,
  listPortfolioFields,
  listPortfolioProgress,
  listPortfolioProjects,
  listPortfolios,
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
  const [
    portfolio,
    projects,
    byProject,
    totals,
    hidden,
    myRoles,
    allProjects,
    children,
    allPortfolios,
    progress,
    fields,
    values,
  ] = await Promise.all([
    getPortfolio(portfolioId),
    listPortfolioProjects(portfolioId),
    portfolioReport(portfolioId, "project", timeZone),
    portfolioReport(portfolioId, "none", timeZone),
    countHiddenPortfolioProjects(portfolioId),
    listMyProjectRoles(),
    listProjects(),
    listPortfolioChildren(portfolioId),
    listPortfolios(),
    listPortfolioProgress(),
    listPortfolioFields(portfolioId),
    listPortfolioFieldValues(portfolioId),
  ]);
  if (!portfolio) notFound();
  const latest = await listLatestStatusUpdates(projects.map((p) => p.id));

  const counts = new Map(byProject.map((row) => [row.bucket, row]));
  const inPortfolio = new Set(projects.map((p) => p.id));
  const nested = new Set(children.map((c) => c.id));

  return (
    <PortfolioOverview
      portfolio={portfolio}
      totals={totals[0] ?? EMPTY_COUNTS}
      hiddenCount={hidden}
      cards={projects.map((project) => ({
        project,
        role: myRoles.get(project.id) ?? null,
        counts: counts.get(project.id) ?? EMPTY_COUNTS,
        latest: latest.get(project.id) ?? null,
      }))}
      candidates={allProjects.filter((p) => !inPortfolio.has(p.id)).map(({ id, name }) => ({ id, name }))}
      nested={children.map((child) => ({
        ...child,
        total: progress.get(child.id)?.total ?? 0,
        completed: progress.get(child.id)?.completed ?? 0,
      }))}
      nestCandidates={allPortfolios
        .filter((p) => p.id !== portfolioId && !nested.has(p.id))
        .map(({ id, name }) => ({ id, name }))}
      fields={fields}
      values={values}
    />
  );
}
