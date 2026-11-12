"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { parsePageLimits, ROW_PAGE } from "@alhc/core/views";

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
  loading = false,
}: {
  hidden: number;
  onClick: () => void;
  className?: string;
  // Batch 39: the next page is on its way from the server (List and Board): the button says so at once
  // and can't be clicked again until it arrives. aria-disabled rather than disabled, so the focus a
  // keyboard user put on it stays there.
  loading?: boolean;
}) {
  if (hidden <= 0) return null;
  const next = Math.min(ROW_PAGE, hidden);
  return (
    <button
      type="button"
      onClick={loading ? undefined : onClick}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      className={`btn-ghost text-zinc-500 ${loading ? "cursor-wait" : ""} ${className}`}
    >
      {loading ? "Loading…" : `Show ${next} more`}
    </button>
  );
}

// List and Board ask the server for the next page. The count lives in ?n= so a refresh keeps it.
// Returns the function and the group whose next page is still loading (batch 39: its button reads
// "Loading…" until the page arrives).
export function usePagedShowMore(): [(key: string, shown: number) => void, string | null] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const show = (key: string, shown: number) => {
    setLoadingKey(key);
    const limits = parsePageLimits(searchParams.get("n"));
    limits[key] = shown + ROW_PAGE;
    const params = new URLSearchParams(searchParams.toString());
    params.set("n", JSON.stringify(limits));
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  };
  return [show, pending ? loadingKey : null];
}
