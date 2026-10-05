import type { Metadata } from "next";
import Link from "next/link";
import { Briefcase } from "lucide-react";
import { ProgressBar } from "@/components/portfolio/progress-bar";
import { NewPortfolioForm } from "@/components/shell/new-portfolio-form";
import { listPortfolioProgress, listPortfolios } from "@/lib/data";
import { formatProgress, progressPercent } from "@/lib/portfolios";

export const metadata: Metadata = { title: "Portfolios" };

export default async function PortfoliosPage() {
  const [portfolios, progress] = await Promise.all([listPortfolios(), listPortfolioProgress()]);

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Portfolios</h1>
        <p className="mt-1 text-sm text-zinc-600">
          A portfolio groups projects so you can follow their progress together. You only see portfolios you’re a
          member of, and inside them only the projects you’re a member of. Anyone can start one and becomes its owner.
        </p>

        <div className="mt-6 max-w-md">
          <NewPortfolioForm />
        </div>

        {portfolios.length === 0 ? (
          <div className="mt-10 rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center">
            <Briefcase className="mx-auto size-8 text-zinc-300" aria-hidden />
            <h2 className="mt-3 text-sm font-medium text-zinc-900">No portfolios yet</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-600">
              Create one above, then add the projects you want to follow, or ask a portfolio’s owner or admin to invite
              you.
            </p>
          </div>
        ) : (
          <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {portfolios.map((portfolio) => {
              const counts = progress.get(portfolio.id);
              const percent = counts ? progressPercent(counts.completed, counts.total) : null;
              return (
                <li key={portfolio.id}>
                  <Link
                    href={`/portfolios/${portfolio.id}`}
                    className="flex h-full flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-300 hover:shadow-sm"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                      <Briefcase className="size-4 text-zinc-400" aria-hidden />
                      <span className="truncate">{portfolio.name}</span>
                    </span>
                    <span className="line-clamp-2 text-sm text-zinc-500">{portfolio.notes || "No notes"}</span>
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
    </main>
  );
}
