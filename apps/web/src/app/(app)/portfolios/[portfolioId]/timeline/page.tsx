import type { Metadata } from "next";
import { PortfolioTimeline } from "@/components/portfolio/portfolio-timeline";
import {
  countHiddenPortfolioProjects,
  getPortfolio,
  listPortfolioChildren,
  listPortfolioMilestones,
  portfolioTimeline,
} from "@/lib/data";

export async function generateMetadata({ params }: PageProps<"/portfolios/[portfolioId]/timeline">): Promise<Metadata> {
  const { portfolioId } = await params;
  const portfolio = await getPortfolio(portfolioId);
  return { title: portfolio ? `${portfolio.name} · Timeline` : "Timeline" };
}

// One bar per project the viewer can read, including projects of nested portfolios they're a member
// of (portfolio_timeline() checks both), with each project's open milestones as diamonds
// (portfolio_milestones()). Read-only: dates change in the projects themselves.
export default async function PortfolioTimelinePage({ params }: PageProps<"/portfolios/[portfolioId]/timeline">) {
  const { portfolioId } = await params;
  const [rows, children, hidden, milestones] = await Promise.all([
    portfolioTimeline(portfolioId),
    listPortfolioChildren(portfolioId),
    countHiddenPortfolioProjects(portfolioId),
    listPortfolioMilestones(portfolioId),
  ]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PortfolioTimeline
        rows={rows}
        nested={children.map(({ id, name }) => ({ id, name }))}
        hiddenCount={hidden}
        milestones={milestones}
      />
    </div>
  );
}
