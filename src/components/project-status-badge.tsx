import { PROJECT_STATUS_LABELS, isProjectStatus } from "@/lib/portfolios";

// Status colours carry meaning (like overdue red elsewhere): accent = on track, amber = at risk,
// red = off track, zinc = complete. The label is always spelled out, so colour is never the only cue.
const STATUS_CLASS = {
  on_track: "bg-accent-50 text-accent-700 ring-accent-200",
  at_risk: "bg-amber-50 text-amber-800 ring-amber-200",
  off_track: "bg-red-50 text-red-700 ring-red-200",
  complete: "bg-zinc-100 text-zinc-700 ring-zinc-200",
} as const;

export function ProjectStatusBadge({ status, note }: { status: string; note?: string | null }) {
  if (!isProjectStatus(status)) return null;
  return (
    <span
      title={note ?? undefined}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_CLASS[status]}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {PROJECT_STATUS_LABELS[status]}
    </span>
  );
}
