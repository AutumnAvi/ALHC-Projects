import { notFound } from "next/navigation";
import { PortfolioRuleBuilder } from "@/components/portfolio/portfolio-rules";
import { getPortfolio, getPortfolioRole, getPortfolioRule, listPortfolioRuleRuns } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { hasPortfolioRole } from "@/lib/roles";
import { loadPortfolioRuleContext } from "../context";

export const metadata = { title: "Portfolio rule" };

export default async function PortfolioRulePage({ params }: PageProps<"/portfolios/[portfolioId]/rules/[ruleId]">) {
  const { portfolioId, ruleId } = await params;
  if (!isUuid(ruleId)) notFound();
  const [portfolio, role, rule, runs, ctx] = await Promise.all([
    getPortfolio(portfolioId),
    getPortfolioRole(portfolioId),
    getPortfolioRule(ruleId),
    listPortfolioRuleRuns(portfolioId, ruleId),
    loadPortfolioRuleContext(portfolioId),
  ]);
  if (!portfolio || !role || !rule || rule.portfolioId !== portfolio.id) notFound();
  return <PortfolioRuleBuilder portfolioId={portfolio.id} rule={rule} runs={runs} ctx={ctx} canEdit={hasPortfolioRole(role, "admin")} />;
}
