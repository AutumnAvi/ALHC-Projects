import "server-only";
import { displayName } from "@/components/avatar";
import type { Profile } from "@/lib/data";
import { getViewerTimeZone } from "@/lib/timezone";
import { isIsoDay, isWorkloadZoom, todayIn, workloadWindow, type WorkloadTask, type WorkloadZoom } from "@/lib/workload";
import type { WorkloadPerson } from "./workload-view";

// URL state shared by the project and portfolio Workload pages: ?d=YYYY-MM-DD (anchor, default the
// viewer's today), ?wl=day (default weeks), ?m=<measure>, ?task=<id> (pane).
export async function workloadParams(searchParams: Record<string, string | string[] | undefined>) {
  const today = todayIn(await getViewerTimeZone());
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
  };
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
