"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Briefcase, ChartColumn, LayoutGrid, Settings } from "lucide-react";
import { usePortfolioCan } from "@/components/portfolio/portfolio-access";
import { useServerAction } from "@/components/toast";
import { updatePortfolio } from "@/lib/actions";
import type { Portfolio } from "@/lib/data";

const TAB_CLASS =
  "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2.5 pb-2.5 pt-1 text-sm text-zinc-600 hover:text-zinc-900 aria-[current=page]:border-zinc-900 aria-[current=page]:font-medium aria-[current=page]:text-zinc-900";

export function PortfolioHeader({ portfolio }: { portfolio: Portfolio }) {
  const pathname = usePathname();
  const [, run] = useServerAction();
  const canEdit = usePortfolioCan("editor");
  const base = `/portfolios/${portfolio.id}`;
  const tabs = [
    { href: base, label: "Overview", icon: LayoutGrid, exact: true },
    { href: `${base}/report`, label: "Report", icon: ChartColumn, exact: false },
    { href: `${base}/settings`, label: "Settings", icon: Settings, exact: false },
  ];

  function saveName(value: string) {
    const name = value.trim();
    if (name && name !== portfolio.name) run(() => updatePortfolio(portfolio.id, { name }));
  }

  return (
    <header className="border-b border-zinc-200 px-6 pt-4">
      <div className="flex items-center gap-2">
        <Briefcase className="size-5 shrink-0 text-zinc-400" aria-hidden />
        <label htmlFor="portfolio-name" className="sr-only">
          Portfolio name
        </label>
        <input
          id="portfolio-name"
          key={`name-${portfolio.name}`}
          defaultValue={portfolio.name}
          maxLength={100}
          readOnly={!canEdit}
          onBlur={(e) => {
            if (canEdit) saveName(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = portfolio.name;
              e.currentTarget.blur();
            }
          }}
          className="w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xl font-semibold tracking-tight hover:border-zinc-200 focus:border-zinc-300 focus:outline-none read-only:hover:border-transparent read-only:focus:border-transparent"
        />
      </div>
      <nav aria-label="Portfolio" className="mt-3 flex items-end gap-1 overflow-x-auto">
        {tabs.map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined} className={TAB_CLASS}>
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
