"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, type MouseEvent } from "react";
import { useNotify } from "@/components/toast";
import { MAX_EXPORT_ROWS, TRUNCATED_HEADER, TRUNCATED_NOTICE } from "@/lib/csv";
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

function fileNameOf(disposition: string | null): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // fall through to the plain name
    }
  }
  return disposition?.match(/filename="([^"]+)"/i)?.[1] ?? "export.csv";
}

// Download link to an /export route. It fetches the file (same session cookie), saves it, and when the
// 10,000-row cap cut the file short (X-Export-Truncated) says so: a toast plus a note next to the
// button. Without JavaScript, or if anything unexpected comes back, it falls back to the plain link.
export function ExportLink({
  href,
  label = "Export CSV",
  variant = "secondary",
  className,
}: {
  href: string;
  label?: string;
  variant?: "secondary" | "ghost";
  className?: string;
}) {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const [truncated, setTruncated] = useState(false);

  async function download(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(href, { credentials: "same-origin" });
      if (!response.ok || !(response.headers.get("Content-Type") ?? "").includes("text/csv")) {
        window.location.assign(href);
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = fileNameOf(response.headers.get("Content-Disposition"));
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const cut = response.headers.has(TRUNCATED_HEADER);
      setTruncated(cut);
      if (cut) notify(TRUNCATED_NOTICE);
    } catch {
      window.location.assign(href);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2 print:hidden">
      <a
        href={href}
        download
        onClick={download}
        aria-busy={busy}
        className={className ?? (variant === "ghost" ? "btn-ghost" : "btn-secondary")}
      >
        <Download className={className ? "size-3.5" : "size-4"} aria-hidden /> {busy ? "Exporting…" : label}
      </a>
      {truncated ? (
        <span role="status" className="text-xs text-amber-700" title={TRUNCATED_NOTICE}>
          First {MAX_EXPORT_ROWS.toLocaleString("en-US")} rows only
        </span>
      ) : null}
    </span>
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
