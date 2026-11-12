"use client";

import { useState } from "react";
import { ROW_PAGE } from "@alhc/core/views";

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
