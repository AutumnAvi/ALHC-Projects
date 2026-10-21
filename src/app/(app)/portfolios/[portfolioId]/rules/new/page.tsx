import { notFound, redirect } from "next/navigation";
import { PortfolioRuleBuilder } from "@/components/portfolio/portfolio-rules";
import { getPortfolio, getPortfolioRole, listPortfolioRules } from "@/lib/data";
import { hasPortfolioRole } from "@/lib/roles";
import { loadPortfolioRuleContext } from "../context";

export const metadata = { title: "New portfolio rule" };

export default async function NewPortfolioRulePage({ params }: PageProps<"/portfolios/[portfolioId]/rules/new">) {
  const { portfolioId } = await params;
  const [portfolio, role, rules, ctx] = await Promise.all([
    getPortfolio(portfolioId),
    getPortfolioRole(portfolioId),
    listPortfolioRules(portfolioId),
    loadPortfolioRuleContext(portfolioId),
  ]);
  if (!portfolio || !role) notFound();
  if (!hasPortfolioRole(role, "admin") || rules === null) redirect(`/portfolios/${portfolioId}/rules`);
  return <PortfolioRuleBuilder portfolioId={portfolio.id} rule={null} runs={[]} ctx={ctx} canEdit />;
}
