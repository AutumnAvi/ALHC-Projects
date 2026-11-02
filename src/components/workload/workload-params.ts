import "server-only";
import { displayName } from "@/components/avatar";
import type { Profile } from "@/lib/data";
import { getViewerTimeZone } from "@/lib/timezone";
import { isIsoDay, isWorkloadZoom, todayIn, workloadWindow, type WorkloadTask, type WorkloadZoom } from "@/lib/workload";
import { peopleWindow, type PersonSummary } from "@/lib/workload-people";
import type { WorkloadSummaryRow } from "@/lib/data";
import type { WorkloadPerson } from "./workload-view";

// URL state shared by the project and portfolio Workload pages: ?d=YYYY-MM-DD (anchor, default the
// viewer's today), ?wl=day (default weeks), ?m=<measure>, ?task=<id> (pane).
// Nov 2 notes (batch 13): ?view=grid = the day-by-day grid (default: the people view), ?person=<id> = the
// grid for one person, ?period=this_week|last_week|last_30|custom (+ from / to) = the people view's period.
export async function workloadParams(searchParams: Record<string, string | string[] | undefined>) {
  const timeZone = await getViewerTimeZone();
  const today = todayIn(timeZone);
  const anchor = isIsoDay(searchParams.d) ? searchParams.d : today;
  const zoom: WorkloadZoom = isWorkloadZoom(searchParams.wl) ? searchParams.wl : "week";
  const { start, end } = workloadWindow(anchor, zoom);
  return {
    today,
    anchor,
    zoom,
    start,
    end,
    measure: typeof searchParams.m === "string" ? searchParams.m : "",
    openTaskId: typeof searchParams.task === "string" ? searchParams.task : null,
    timeZone,
    mode: searchParams.view === "grid" ? ("grid" as const) : ("people" as const),
    person: typeof searchParams.person === "string" ? searchParams.person : null,
    period: peopleWindow(searchParams.period, today, searchParams.from, searchParams.to),
  };
}

// The people view's rows: everyone with work in the summary (members with nothing open or done in the
// period are left out — there's nothing to say about them), named from their profiles.
export function summaryPeople(rows: WorkloadSummaryRow[], profiles: Profile[]): PersonSummary[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return rows.map((row) => {
    const profile = byId.get(row.assigneeId);
    return {
      id: row.assigneeId,
      name: profile ? displayName(profile) : "Unknown person",
      completed: row.completed,
      open: row.open,
      overdue: row.overdue,
      completedDays: row.completedDays,
    };
  });
}

// Rows: the given members plus anyone else with tasks or a capacity in view, sorted by name.
export function workloadPeople(
  memberIds: string[],
  tasks: WorkloadTask[],
  capacities: Record<string, number>,
  profiles: Profile[],
): WorkloadPerson[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const ids = new Set([...memberIds, ...tasks.map((t) => t.assigneeId), ...Object.keys(capacities)]);
  return [...ids]
    .map((id) => {
      const profile = byId.get(id);
      return { id, name: profile ? displayName(profile) : "Unknown person" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
