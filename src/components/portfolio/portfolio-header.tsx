"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Briefcase, ChartColumn, Gauge, GanttChart, LayoutGrid, Settings } from "lucide-react";
import { usePortfolioCan } from "@/components/portfolio/portfolio-access";
import { useServerAction } from "@/components/toast";
import { updatePortfolio } from "@/lib/actions";
import { HEADER_TAB, HEADER_TITLE_INPUT, HeaderGlyph } from "@/components/ui";
import type { Portfolio } from "@/lib/data";

export function PortfolioHeader({ portfolio }: { portfolio: Portfolio }) {
  const pathname = usePathname();
  const [, run] = useServerAction();
  const canEdit = usePortfolioCan("editor");
  const base = `/portfolios/${portfolio.id}`;
  const tabs = [
    { href: base, label: "Overview", icon: LayoutGrid, exact: true },
    { href: `${base}/report`, label: "Report", icon: ChartColumn, exact: false },
    { href: `${base}/timeline`, label: "Timeline", icon: GanttChart, exact: false },
    { href: `${base}/workload`, label: "Workload", icon: Gauge, exact: false },
    { href: `${base}/settings`, label: "Settings", icon: Settings, exact: false },
  ];

  function saveName(value: string) {
    const name = value.trim();
    if (name && name !== portfolio.name) run(() => updatePortfolio(portfolio.id, { name }));
  }

  return (
    <header className="border-b border-zinc-200 px-gutter pt-2.5">
      <div className="flex items-center gap-2">
        <HeaderGlyph icon={Briefcase} />
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
          className={`${HEADER_TITLE_INPUT} w-full`}
        />
      </div>
      <nav aria-label="Portfolio" className="mt-1 flex items-center gap-0.5 overflow-x-auto print:hidden">
        {tabs.map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined} className={HEADER_TAB}>
              <Icon className="size-3.5" aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
