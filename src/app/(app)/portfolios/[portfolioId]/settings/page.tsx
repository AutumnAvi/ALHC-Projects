import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortfolioFieldsManager } from "@/components/portfolio/portfolio-fields-manager";
import { PortfolioMembersManager } from "@/components/portfolio/portfolio-members";
import { requireMember } from "@/lib/auth";
import { getPortfolio, getPortfolioRole, listPortfolioFields, listPortfolioMembers } from "@/lib/data";
import { hasPortfolioRole } from "@/lib/roles";

export async function generateMetadata({ params }: PageProps<"/portfolios/[portfolioId]/settings">): Promise<Metadata> {
  const { portfolioId } = await params;
  const portfolio = await getPortfolio(portfolioId);
  return { title: portfolio ? `${portfolio.name} · Settings` : "Settings" };
}

export default async function PortfolioSettingsPage({ params }: PageProps<"/portfolios/[portfolioId]/settings">) {
  const { portfolioId } = await params;
  const [viewer, portfolio, role, members, fields] = await Promise.all([
    requireMember(),
    getPortfolio(portfolioId),
    getPortfolioRole(portfolioId),
    listPortfolioMembers(portfolioId),
    listPortfolioFields(portfolioId),
  ]);
  if (!portfolio || !role) notFound();

  return (
    <>
      <PortfolioFieldsManager portfolioId={portfolio.id} fields={fields} canEdit={hasPortfolioRole(role, "editor")} />
      <PortfolioMembersManager portfolio={portfolio} members={members} viewerId={viewer.id} viewerRole={role} />
    </>
  );
}
