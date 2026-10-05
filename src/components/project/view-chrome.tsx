"use client";

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui";

// Chrome shared by the date-based layouts (Calendar, Timeline) so they read as one product with
// List and Board: same gutter, same button sizes, same tray look.

export const VIEW_BODY = "flex min-h-0 flex-1 gap-3 px-gutter py-3";
export const VIEW_HINT = "mt-2 text-xs text-zinc-400";

// Side trays (Calendar's "No due date", Timeline's "Unscheduled"); `active` while a drag hovers.
export function trayClass(active = false) {
  return `hidden w-64 shrink-0 flex-col rounded-lg border p-1.5 md:flex ${
    active ? "border-accent-200 bg-accent-50" : "border-transparent bg-zinc-100/60"
  }`;
}
export const TRAY_HEADING = "flex h-8 shrink-0 items-center gap-1.5 px-1 text-sm font-semibold text-zinc-900";
export const TRAY_EMPTY = "rounded-md border border-dashed border-zinc-300/80 px-2 py-3 text-center text-xs text-zinc-400";

export function PeriodNav({
  label,
  prevLabel,
  nextLabel,
  onPrev,
  onNext,
  onToday,
  children,
}: {
  label: string;
  prevLabel: string;
  nextLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1">
      <button type="button" onClick={onToday} className="btn-secondary mr-1">
        Today
      </button>
      <button type="button" onClick={onPrev} aria-label={prevLabel} className="btn-icon">
        <ChevronLeft className="size-4" />
      </button>
      <button type="button" onClick={onNext} aria-label={nextLabel} className="btn-icon">
        <ChevronRight className="size-4" />
      </button>
      <h2 className="ml-1 text-sm font-semibold text-zinc-900" aria-live="polite">
        {label}
      </h2>
      {children ? <div className="ml-auto">{children}</div> : null}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-7 items-center rounded-md bg-zinc-100 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="h-6 rounded px-2 text-sm text-zinc-600 hover:text-zinc-900 aria-pressed:bg-white aria-pressed:font-medium aria-pressed:text-zinc-900 aria-pressed:shadow-xs"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// Calendar and Timeline wait for the viewer's local date before drawing; this keeps the frame steady.
export function ViewLoading({ label }: { label: string }) {
  return (
    <div role="status" className={VIEW_BODY}>
      <span className="sr-only">{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-1">
          <Skeleton className="h-7 w-14 rounded-md" />
          <Skeleton className="h-7 w-16 rounded-md" />
          <Skeleton className="ml-1 h-4 w-32" />
        </div>
        <Skeleton className="min-h-64 flex-1 rounded-lg" />
      </div>
      <Skeleton className="hidden w-64 shrink-0 rounded-lg md:block" />
    </div>
  );
}
