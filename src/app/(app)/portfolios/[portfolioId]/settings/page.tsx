import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortfolioMembersManager } from "@/components/portfolio/portfolio-members";
import { requireMember } from "@/lib/auth";
import { getPortfolio, getPortfolioRole, listPortfolioMembers } from "@/lib/data";

export async function generateMetadata({ params }: PageProps<"/portfolios/[portfolioId]/settings">): Promise<Metadata> {
  const { portfolioId } = await params;
  const portfolio = await getPortfolio(portfolioId);
  return { title: portfolio ? `${portfolio.name} · Settings` : "Settings" };
}

export default async function PortfolioSettingsPage({ params }: PageProps<"/portfolios/[portfolioId]/settings">) {
  const { portfolioId } = await params;
  const [viewer, portfolio, role, members] = await Promise.all([
    requireMember(),
    getPortfolio(portfolioId),
    getPortfolioRole(portfolioId),
    listPortfolioMembers(portfolioId),
  ]);
  if (!portfolio || !role) notFound();

  return (
    <PortfolioMembersManager portfolio={portfolio} members={members} viewerId={viewer.id} viewerRole={role} />
  );
}
