"use client";

import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  const timer = window.setInterval(callback, 60_000);
  return () => window.clearInterval(timer);
}

const minute = () => Math.floor(Date.now() / 60_000);

function relative(iso: string, nowMinute: number) {
  const then = new Date(iso);
  const minutes = nowMinute - Math.floor(then.getTime() / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: then.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

// Rendered only on the client so relative times never cause hydration mismatches.
export function Timestamp({ iso, className }: { iso: string; className?: string }) {
  const nowMinute = useSyncExternalStore(subscribe, minute, () => null);
  return (
    <time
      dateTime={iso}
      title={nowMinute === null ? undefined : new Date(iso).toLocaleString()}
      className={className}
    >
      {nowMinute === null ? "" : relative(iso, nowMinute)}
    </time>
  );
}
