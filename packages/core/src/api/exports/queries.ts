// Big move 1: the reads behind the CSV exports (src/lib/exports.ts builds the files from them). Every
// function takes the caller's ApiContext first and reads only through ctx.db — the signed-in person's own
// client, never the service role — so an export only ever contains rows RLS lets them read.
//
// The exports stream: the context is made in the request (before the stream starts) and handed in, and
// these reads run while the file is being written, a page at a time (keyset pages through task memberships
// and the overdue report; PostgREST's max_rows on the hosted project is 1,000).
import type { ApiContext } from "../core/context";
import { ApiError, codeOf, type DbErrorDetail } from "../core/errors";
import type { ReportCountRow } from "./model";
import { visibleRequestLabelsIn } from "../numbers/queries";
import type { OverdueTask } from "../reports/model";
import type { ProjectTask } from "../tasks/model";
import { reportFiltersJson, type ReportFilters } from "../../reports";
import type { Json } from "../../supabase/database.types";
import { parseTaskKind } from "../../task-kinds";
import { toJson, type ViewFilters } from "../../views";

// Rows per page of a paged read (the hosted PostgREST's max_rows).
const PAGE = 1000;

type Paged<T> = PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>;

// What a failed export read says ("Failed to export <what>: …"); the database's answer stays on it for logs.
function exportError(error: DbErrorDetail & { message: string }, what: string): ApiError {
  return new ApiError(codeOf(error), `Failed to export ${what}: ${error.message}`, error);
}

// Every row of a paged read, a page at a time (stops at a short page).
async function* pages<T>(read: (from: number, to: number) => Paged<T>, what: string): AsyncGenerator<T> {
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await read(from, from + PAGE - 1);
    if (error) throw exportError(error, what);
    const list = data ?? [];
    yield* list;
    if (list.length < PAGE) return;
  }
}

// The project's active task memberships with what ordering needs, by task id in keyset pages.
export async function exportTaskKeys(ctx: ApiContext, projectId: string): Promise<ProjectTask[]> {
  const supabase = ctx.db;
  const out: ProjectTask[] = [];
  let after: string | null = null;
  for (;;) {
    let query = supabase
      .from("task_projects")
      .select(
        "task_id, section_id, sort_order, task:tasks!inner(id, title, completed_at, start_on, due_on, assignee_id, home_project_id, created_at, kind)",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .is("task.deleted_at", null)
      .order("task_id")
      .limit(PAGE);
    if (after) query = query.gt("task_id", after);
    const { data, error } = await query;
    if (error) throw exportError(error, "tasks");
    const list = data ?? [];
    // The number this project gives each task (Oct 27 notes, batch 6: each project numbers the tasks it
    // holds, other projects' tasks included), with its bracket setting and only while numbering is on.
    // The title stays bare so sorting by name matches the List.
    const labels = await visibleRequestLabelsIn(ctx, projectId, list.map((m) => m.task.id));
    for (const m of list) {
      out.push({
        id: m.task.id,
        title: m.task.title,
        requestLabel: labels.get(m.task.id) ?? null,
        completedAt: m.task.completed_at,
        startOn: m.task.start_on,
        dueOn: m.task.due_on,
        assigneeId: m.task.assignee_id,
        // The database's internal pointer (not in the CSV; Oct 29 notes, 55b: never shown).
        homeProjectId: m.task.home_project_id ?? projectId,
        createdAt: m.task.created_at,
        sectionId: m.section_id,
        sortOrder: m.sort_order,
        subtaskCount: 0,
        subtaskDoneCount: 0,
        projectCount: 1,
        fieldValues: {},
        recurring: false,
        blockedBy: 0,
        kind: parseTaskKind(m.task.kind),
        approvalStatus: null,
        tagIds: [],
        commentCount: 0,
      });
    }
    if (list.length === 0) return out;
    after = list[list.length - 1].task_id;
  }
}

// The task ids a view's filters match: one array from filter_project_task_ids (Real features 4), or the
// row-returning filter on a database without it.
export async function exportMatchingIds(
  ctx: ApiContext,
  projectId: string,
  filters: ViewFilters,
  timeZone: string,
): Promise<Set<string>> {
  const supabase = ctx.db;
  const result = await supabase.rpc("filter_project_task_ids", { target_project: projectId, filters: toJson(filters), tz: timeZone });
  if (result.error?.code === "PGRST202") {
    const old = await supabase.rpc("filter_project_tasks", { target_project: projectId, filters: toJson(filters), tz: timeZone });
    if (old.error) throw exportError(old.error, "tasks");
    return new Set((old.data ?? []).map((r) => r.task_id));
  }
  if (result.error) throw exportError(result.error, "tasks");
  return new Set(result.data ?? []);
}

// Field values (of these fields) and tag ids for a chunk of tasks, read through RLS.
export async function exportCells(ctx: ApiContext, taskIds: string[], fieldIds: string[], withTags: boolean) {
  const supabase = ctx.db;
  const values = new Map<string, Record<string, Json>>();
  const tags = new Map<string, string[]>();
  await Promise.all([
    fieldIds.length
      ? (async () => {
          for await (const v of pages(
            (from, to) =>
              supabase
                .from("task_field_values")
                .select("task_id, field_id, value")
                .in("task_id", taskIds)
                .in("field_id", fieldIds)
                .not("value", "is", null)
                .order("task_id")
                .order("field_id")
                .range(from, to),
            "field values",
          )) {
            const record = values.get(v.task_id) ?? {};
            record[v.field_id] = v.value;
            values.set(v.task_id, record);
          }
        })()
      : Promise.resolve(),
    withTags
      ? (async () => {
          for await (const t of pages(
            (from, to) =>
              supabase
                .from("task_tags")
                .select("id, task_id, tag_id, tag:tags!inner(id)")
                .in("task_id", taskIds)
                .is("deleted_at", null)
                .is("tag.deleted_at", null)
                .order("id")
                .range(from, to),
            "tags",
          )) {
            const list = tags.get(t.task_id) ?? [];
            list.push(t.tag_id);
            tags.set(t.task_id, list);
          }
        })()
      : Promise.resolve(),
  ]);
  return { values, tags };
}

// Every row of a workspace report breakdown, a page at a time (a workspace can have more than 1,000
// sections), in a fixed order so pages never overlap.
export async function* exportWorkspaceReportRows(
  ctx: ApiContext,
  filters: ReportFilters,
  groupBy: "none" | "project" | "assignee" | "section",
  timeZone: string,
): AsyncGenerator<ReportCountRow> {
  const supabase = ctx.db;
  yield* pages<ReportCountRow>(
    (from, to) =>
      supabase
        .rpc("workspace_report", { filters: reportFiltersJson(filters), group_by: groupBy, tz: timeZone })
        .order("bucket", { nullsFirst: true })
        .order("project_id", { nullsFirst: true })
        .range(from, to),
    "report",
  );
}

// The all-projects report a page at a time, in its own order.
export async function* exportAllProjectsRows(ctx: ApiContext, timeZone: string) {
  const supabase = ctx.db;
  yield* pages(
    (from, to) => supabase.rpc("all_projects_report", { tz: timeZone }).range(from, to),
    "all-projects report",
  );
}

// The overdue report a page at a time: keyset pages of report_overdue_tasks_after (Real features 4), 5,000
// rows each in the report's own order; a database without it gets the old function's first 10,000.
const OVERDUE_PAGE = 5000;

type OverdueRow = {
  task_id: string;
  title: string;
  project_id: string;
  assignee_id: string | null;
  due_on: string;
  days_overdue: number;
  parent_task_id: string | null;
};

export async function* exportOverdueRows(ctx: ApiContext, filters: ReportFilters, timeZone: string): AsyncGenerator<OverdueTask> {
  const supabase = ctx.db;
  let cursor: OverdueRow | null = null;
  for (;;) {
    const result = await supabase.rpc("report_overdue_tasks_after", {
      filters: reportFiltersJson(filters),
      tz: timeZone,
      after_due: cursor?.due_on ?? null,
      after_title: cursor?.title ?? null,
      after_task: cursor?.task_id ?? null,
      max_results: OVERDUE_PAGE,
    });
    let list: OverdueRow[];
    if (result.error?.code === "PGRST202") {
      const old = await supabase.rpc("report_overdue_tasks", { filters: reportFiltersJson(filters), tz: timeZone, max_results: 10_000 });
      if (old.error) throw exportError(old.error, "overdue tasks");
      list = old.data ?? [];
    } else if (result.error) {
      throw exportError(result.error, "overdue tasks");
    } else {
      list = (Array.isArray(result.data) ? result.data : []) as OverdueRow[];
    }
    for (const r of list) {
      yield {
        taskId: r.task_id,
        title: r.title,
        projectId: r.project_id,
        assigneeId: r.assignee_id,
        dueOn: r.due_on,
        daysOverdue: Number(r.days_overdue),
        parentTaskId: r.parent_task_id,
      };
    }
    if (result.error || list.length < OVERDUE_PAGE) return;
    cursor = list[list.length - 1];
  }
}

// Section names by id (a chunk of a breakdown's sections; none asked = none read).
export async function exportSectionNames(ctx: ApiContext, ids: string[]): Promise<Map<string, string>> {
  const found = ids.length ? await ctx.db.from("sections").select("id, name").in("id", ids) : { data: [], error: null };
  if (found.error) throw exportError(found.error, "sections");
  return new Map((found.data ?? []).map((x) => [x.id, x.name] as const));
}
