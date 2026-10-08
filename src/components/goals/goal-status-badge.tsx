import { GOAL_STATUS_LABELS, type GoalStatus } from "@/lib/goals";

// Same color language as the project status badge: accent = on track, amber = at risk, red = off
// track or missed, zinc = achieved or dropped. The label is always spelled out.
const STATUS_CLASS: Record<GoalStatus, string> = {
  on_track: "bg-accent-50 text-accent-700 ring-accent-200",
  at_risk: "bg-amber-50 text-amber-800 ring-amber-200",
  off_track: "bg-red-50 text-red-700 ring-red-200",
  achieved: "bg-zinc-100 text-zinc-800 ring-zinc-300",
  missed: "bg-red-50 text-red-700 ring-red-200",
  dropped: "bg-zinc-50 text-zinc-500 ring-zinc-200",
};

export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_CLASS[status]}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {GOAL_STATUS_LABELS[status]}
    </span>
  );
}
