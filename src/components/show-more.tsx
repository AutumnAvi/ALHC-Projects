"use client";

import { useState } from "react";

// First paint of a long List, Board, My Tasks, or Inbox. Small groups render in full, so the
// everyday screen is unchanged; a long one grows by a page when asked.
export const ROW_PAGE = 80;

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
