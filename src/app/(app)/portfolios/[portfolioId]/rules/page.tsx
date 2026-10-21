import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortfolioRulesView } from "@/components/portfolio/portfolio-rules";
import { getPortfolio, getPortfolioRole, listPortfolioRuleRuns, listPortfolioRules } from "@/lib/data";
import { hasPortfolioRole } from "@/lib/roles";
import { loadPortfolioRuleContext } from "./context";

export async function generateMetadata({ params }: PageProps<"/portfolios/[portfolioId]/rules">): Promise<Metadata> {
  const { portfolioId } = await params;
  const portfolio = await getPortfolio(portfolioId);
  return { title: portfolio ? `${portfolio.name} · Rules` : "Rules" };
}

export default async function PortfolioRulesPage({ params }: PageProps<"/portfolios/[portfolioId]/rules">) {
  const { portfolioId } = await params;
  const [portfolio, role, rules, runs, ctx] = await Promise.all([
    getPortfolio(portfolioId),
    getPortfolioRole(portfolioId),
    listPortfolioRules(portfolioId),
    listPortfolioRuleRuns(portfolioId),
    loadPortfolioRuleContext(portfolioId),
  ]);
  if (!portfolio || !role) notFound();
  return (
    <PortfolioRulesView
      portfolioId={portfolio.id}
      rules={rules}
      runs={runs}
      ctx={ctx}
      canEdit={hasPortfolioRole(role, "admin")}
      canRun={hasPortfolioRole(role, "editor")}
    />
  );
}
