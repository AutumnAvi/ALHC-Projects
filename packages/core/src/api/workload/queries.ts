// Big move 1: the workload area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "../core/context";
import { rows } from "../core/db";
import { listFieldsForProjects } from "../fields/queries";
import type { WorkloadRow, WorkloadSummaryRow } from "./model";
import type { FieldDef } from "../../fields";
import type { WorkloadTask } from "../../workload";
import { parseCompletedDays } from "../../workload-people";

const toWorkloadTask = (r: WorkloadRow): WorkloadTask => ({
  id: r.task_id,
  title: r.title,
  assigneeId: r.assignee_id,
  startOn: r.start_on,
  dueOn: r.due_on,
  value: r.value === null ? null : Number(r.value),
  projectId: r.project_id,
  canEdit: r.can_edit,
});

// Nov 2 notes (batch 13, note 86): per assignee in a project or a portfolio's rollup, open and overdue
// tasks today and tasks completed in [start, end] by local day (workload_people_summary, invoker: only
// projects the viewer can read). null when the database doesn't have it yet (a preview before this
// release's migration), so the page can say so instead of breaking.
export async function workloadPeopleSummary(
  ctx: ApiContext, scope: { projectId: string } | { portfolioId: string },
  rangeStart: string,
  rangeEnd: string,
  timeZone: string,
): Promise<WorkloadSummaryRow[] | null> {
  const supabase = ctx.db;
  const result = await supabase.rpc("workload_people_summary", {
    target_project: "projectId" in scope ? scope.projectId : null,
    target_portfolio: "portfolioId" in scope ? scope.portfolioId : null,
    range_start: rangeStart,
    range_end: rangeEnd,
    tz: timeZone,
  });
  if (result.error?.code === "PGRST202") return null;
  return rows(result, "workload summary").map((r) => ({
    assigneeId: r.assignee_id,
    open: Number(r.open_count),
    overdue: Number(r.overdue_count),
    completed: Number(r.completed_count),
    completedDays: parseCompletedDays(r.completed_days),
  }));
}

export async function projectWorkload(
  ctx: ApiContext, projectId: string,
  rangeStart: string,
  rangeEnd: string,
  valueFieldId: string | null,
): Promise<WorkloadTask[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("project_workload", {
    target_project: projectId,
    range_start: rangeStart,
    range_end: rangeEnd,
    value_field: valueFieldId,
  });
  return rows(result, "workload").map(toWorkloadTask);
}

export async function portfolioWorkload(
  ctx: ApiContext, portfolioId: string,
  rangeStart: string,
  rangeEnd: string,
  valueFieldName: string | null,
): Promise<WorkloadTask[]> {
  const supabase = ctx.db;
  const result = await supabase.rpc("portfolio_workload", {
    target_portfolio: portfolioId,
    range_start: rangeStart,
    range_end: rangeEnd,
    value_field_name: valueFieldName,
  });
  return rows(result, "workload").map(toWorkloadTask);
}

// Weekly capacity per person in a project's or a portfolio's workload.
export const listWorkloadCapacities = read(
  async (ctx: ApiContext, scope: "project" | "portfolio", scopeId: string): Promise<Record<string, number>> => {
    const supabase = ctx.db;
    const result = await supabase
      .from("workload_capacities")
      .select("profile_id, weekly_capacity")
      .eq(scope === "project" ? "project_id" : "portfolio_id", scopeId)
      .is("deleted_at", null);
    const out: Record<string, number> = {};
    for (const row of rows(result, "capacities")) out[row.profile_id] = Number(row.weekly_capacity);
    return out;
  },
);

// Number fields of a set of projects (workload "measure by" choices).
export async function listNumberFields(ctx: ApiContext, projectIds: string[]): Promise<FieldDef[]> {
  if (projectIds.length === 0) return [];
  return (await listFieldsForProjects(ctx, projectIds)).filter((f) => f.fieldType === "number");
}
