import { PROJECT_STATUS_LABELS, isProjectStatus, type ProjectStatus } from "@/lib/portfolios";

// Asana's status colors: green = on track, amber = at risk, red = off track, blue (the accent) = on hold,
// zinc = complete. The label is always spelled out, so color is never the only cue.
export const PROJECT_STATUS_CLASS: Record<ProjectStatus, string> = {
  on_track: "bg-green-50 text-green-800 ring-green-200",
  at_risk: "bg-amber-50 text-amber-800 ring-amber-200",
  off_track: "bg-red-50 text-red-700 ring-red-200",
  on_hold: "bg-accent-50 text-accent-700 ring-accent-200",
  complete: "bg-zinc-100 text-zinc-700 ring-zinc-200",
};

// The colored dot in status menus and pickers.
export const PROJECT_STATUS_DOT: Record<ProjectStatus, string> = {
  on_track: "bg-green-600",
  at_risk: "bg-amber-500",
  off_track: "bg-red-600",
  on_hold: "bg-accent-500",
  complete: "bg-zinc-500",
};

export function ProjectStatusBadge({ status, note }: { status: string; note?: string | null }) {
  if (!isProjectStatus(status)) return null;
  return (
    <span
      title={note ?? undefined}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${PROJECT_STATUS_CLASS[status]}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {PROJECT_STATUS_LABELS[status]}
    </span>
  );
}
