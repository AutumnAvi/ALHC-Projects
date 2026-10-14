"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { parsePageLimits, ROW_PAGE } from "@/lib/views";

export { ROW_PAGE };

// First paint of a long List, Board, My Tasks, or Inbox. Small groups render in full, so the
// everyday screen is unchanged; a long one grows by a page when asked.

export function useGroupPages() {
  const [extra, setExtra] = useState<Record<string, number>>({});
  return {
    limit(key: string) {
      return ROW_PAGE + (extra[key] ?? 0);
    },
    showMore(key: string) {
      setExtra((current) => ({ ...current, [key]: (current[key] ?? 0) + ROW_PAGE }));
    },
  };
}

export function ShowMoreRows({
  hidden,
  onClick,
  className = "",
}: {
  hidden: number;
  onClick: () => void;
  className?: string;
}) {
  if (hidden <= 0) return null;
  const next = Math.min(ROW_PAGE, hidden);
  return (
    <button type="button" onClick={onClick} className={`btn-ghost text-zinc-500 ${className}`}>
      Show {next} more
    </button>
  );
}

// List and Board ask the server for the next page. The count lives in ?n= so a refresh keeps it.
export function usePagedShowMore() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  return (key: string, shown: number) => {
    const limits = parsePageLimits(searchParams.get("n"));
    limits[key] = shown + ROW_PAGE;
    const params = new URLSearchParams(searchParams.toString());
    params.set("n", JSON.stringify(limits));
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  };
}
