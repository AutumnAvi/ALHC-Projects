"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ChartColumn, Download, LayoutDashboard, Printer, Table2 } from "lucide-react";
import { Segmented } from "@/components/project/view-chrome";
import { HEADER_TAB } from "@/components/ui";
import type { SeriesInterval } from "@/lib/reports";

export function ReportsTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: "/reports", label: "Overview", icon: ChartColumn, exact: true },
    { href: "/reports/projects", label: "All projects", icon: Table2, exact: false },
    { href: "/reports/dashboards", label: "My dashboards", icon: LayoutDashboard, exact: false },
  ];
  return (
    <nav aria-label="Reports" className="flex items-center gap-0.5 overflow-x-auto border-b border-zinc-200 px-gutter print:hidden">
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
  );
}

// Browser Print → Save as PDF; the print stylesheet in globals.css hides the app chrome.
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className="btn-secondary print:hidden">
      <Printer className="size-4" aria-hidden /> {label}
    </button>
  );
}

// A plain download link to an /export route (the browser keeps the session cookie).
export function ExportLink({ href, label = "Export CSV", variant = "secondary" }: { href: string; label?: string; variant?: "secondary" | "ghost" }) {
  return (
    <a href={href} download className={`${variant === "ghost" ? "btn-ghost" : "btn-secondary"} print:hidden`}>
      <Download className="size-4" aria-hidden /> {label}
    </a>
  );
}

const INTERVALS = [
  { value: "day", label: "Days" },
  { value: "week", label: "Weeks" },
] as const;

// Day / week buckets for the completed series (`?int=day`, default week), kept next to the filters.
export function IntervalToggle({ value }: { value: SeriesInterval }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  return (
    <div className="print:hidden">
      <Segmented
        label="Completed per"
        options={INTERVALS}
        value={value}
        onChange={(next) => {
          const params = new URLSearchParams(searchParams.toString());
          if (next === "week") params.delete("int");
          else params.set("int", next);
          const query = params.toString();
          startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
        }}
      />
    </div>
  );
}
