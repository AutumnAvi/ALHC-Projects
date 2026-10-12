import type { Metadata } from "next";
import Link from "next/link";
import { Briefcase, Plus } from "lucide-react";
import { ProgressBar } from "@/components/portfolio/progress-bar";
import { OpenDialogButton } from "@/components/shell/open-dialog-button";
import { EmptyState, PageHeader } from "@/components/ui";
import { listPortfolioProgress, listPortfolios } from "@/lib/data";
import { formatProgress, progressPercent } from "@/lib/portfolios";

export const metadata: Metadata = { title: "Portfolios" };

export default async function PortfoliosPage() {
  const [portfolios, progress] = await Promise.all([listPortfolios(), listPortfolioProgress()]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Briefcase}
        title="Portfolios"
        description="Follow the progress of several projects together"
        actions={
          <OpenDialogButton dialog={{ kind: "portfolio" }} className="btn-primary h-8 px-3">
            <Plus className="size-4" aria-hidden />
            New portfolio
          </OpenDialogButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-gutter py-6">
          <h2 className="text-sm font-semibold text-zinc-900">Your portfolios</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Anyone can start a portfolio and becomes its owner. You only see portfolios you’re a member of, and inside
            them only the projects you’re a member of.
          </p>
          {portfolios.length === 0 ? (
            <div className="mt-3">
              <EmptyState
                icon={Briefcase}
                title="No portfolios yet"
                action={
                  <OpenDialogButton dialog={{ kind: "portfolio" }} className="btn-primary h-8 px-3">
                    <Plus className="size-4" aria-hidden />
                    New portfolio
                  </OpenDialogButton>
                }
              >
                Create one, then add the projects you want to follow, or ask a portfolio’s owner or admin to invite you.
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {portfolios.map((portfolio) => {
                const counts = progress.get(portfolio.id);
                const percent = counts ? progressPercent(counts.completed, counts.total) : null;
                return (
                  <li key={portfolio.id}>
                    <Link
                      href={`/portfolios/${portfolio.id}`}
                      className="flex h-full flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-3 hover:border-zinc-300 hover:bg-zinc-50"
                    >
                      <span className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                        <Briefcase className="size-4 text-zinc-400" aria-hidden />
                        <span className="truncate">{portfolio.name}</span>
                      </span>
                      <span className="line-clamp-2 text-xs text-zinc-500">{portfolio.notes || "No notes"}</span>
                      <span className="mt-auto flex items-center gap-2">
                        <ProgressBar percent={percent} label={`${portfolio.name} progress`} size="sm" />
                        <span className="shrink-0 text-xs tabular-nums text-zinc-600">{formatProgress(percent)}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
