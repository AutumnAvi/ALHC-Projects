import { notFound } from "next/navigation";
import { PortfolioAccessProvider } from "@/components/portfolio/portfolio-access";
import { PortfolioHeader } from "@/components/portfolio/portfolio-header";
import { getPortfolio, getPortfolioRole } from "@/lib/data";
import { isUuid } from "@/lib/ids";

// Non-members get a plain 404: RLS hides the portfolio row, so nothing about it is revealed.
export default async function PortfolioLayout({ children, params }: LayoutProps<"/portfolios/[portfolioId]">) {
  const { portfolioId } = await params;
  if (!isUuid(portfolioId)) notFound();
  const [portfolio, role] = await Promise.all([getPortfolio(portfolioId), getPortfolioRole(portfolioId)]);
  if (!portfolio || !role) notFound();

  return (
    <PortfolioAccessProvider role={role}>
      <div className="flex min-h-0 flex-1 flex-col">
        <PortfolioHeader portfolio={portfolio} />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </PortfolioAccessProvider>
  );
}
