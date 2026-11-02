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
  listPortfolioRollupProjects,
  listPortfolios,
  listProjects,
  listTeams,
  portfolioReport,
} from "@/lib/data";
import { nestedPortfolioProjects } from "@/lib/portfolio-picker";
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
    rollup,
    teams,
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
    listPortfolioRollupProjects(portfolioId),
    listTeams(),
  ]);
  if (!portfolio) notFound();
  const inPortfolio = new Set(projects.map((p) => p.id));
  const nested = new Set(children.map((c) => c.id));
  // Nov 2 notes (batch 13, note 87): projects reached only through nested portfolios the viewer is in.
  const fromNested = nestedPortfolioProjects(
    rollup,
    inPortfolio,
    children.map((c) => c.id),
    new Map(allPortfolios.map((p) => [p.id, p.name])),
  );
  const latest = await listLatestStatusUpdates([...projects.map((p) => p.id), ...fromNested.map((p) => p.id)]);

  const counts = new Map(byProject.map((row) => [row.bucket, row]));
  const statusOf = new Map(rollup.map((r) => [r.id, { status: r.status, note: r.statusNote }]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

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
      nestedCards={fromNested.map((project) => ({
        ...project,
        status: statusOf.get(project.id)?.status ?? "on_track",
        statusNote: statusOf.get(project.id)?.note ?? null,
        role: myRoles.get(project.id) ?? null,
        counts: counts.get(project.id) ?? EMPTY_COUNTS,
        latest: latest.get(project.id) ?? null,
      }))}
      candidates={allProjects
        .map(({ id, name, team_id }) => ({
          id,
          name,
          teamName: teamName.get(team_id) ?? null,
          inPortfolio: inPortfolio.has(id),
        }))}
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
