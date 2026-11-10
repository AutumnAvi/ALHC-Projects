// Big move 1: the numbers area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, type Db, read } from "../core/context";
import { isMissingColumn, maybe, rpcMissing } from "../core/db";
import { numbersFromPlaces, placesFromLabels, taskNumbersFrom } from "./model";
import type { NumberingCounts } from "../../customize";
import { isUuid } from "../../ids";
import {
  numberWithItsProject,
  type RequestLabel,
  requestLabelFrom,
  type TaskNumber,
  type TaskNumbering,
  type TaskPlace,
} from "../../request-numbers";
import { numberingFromRow } from "../../row-mappers";

const NUMBERING_COLUMNS =
  "enabled, prefix, pad_width, add_to_title, assign_to, last_number, template, wrap_brackets, number_subtasks, subtask_separator, number_scope, section_ids, task_kinds, reuse_deleted, fill_gaps, reset_period, counter_field_id, project_code, renumber_on_move, time_zone, start_number";

export const getRequestSequence = read(async (ctx: ApiContext, projectId: string): Promise<TaskNumbering | null> => {
  const supabase = ctx.db;
  const full = await supabase
    .from("request_sequences")
    .select(NUMBERING_COLUMNS)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  if (isMissingColumn(full.error)) {
    const legacy = await supabase
      .from("request_sequences")
      .select("enabled, prefix, pad_width, add_to_title, assign_to, last_number")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .maybeSingle();
    const row = maybe(legacy, "task numbering");
    return row ? numberingFromRow({ ...row, advanced: false }) : null;
  }
  const row = maybe(full, "task numbering");
  return row ? numberingFromRow({ ...row, advanced: true }) : null;
});

// Same, with a client made earlier (CSV exports read inside a stream, where cookies() is gone).
async function requestLabelsWith(supabase: Db, ids: string[]): Promise<Map<string, RequestLabel>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const labels = new Map<string, RequestLabel>();
  if (unique.length === 0) return labels;
  let rpcMissing = false;
  for (let i = 0; i < unique.length; i += 5000) {
    const result = await supabase.rpc("task_request_labels", { task_ids: unique.slice(i, i + 5000) });
    if (result.error?.code === "PGRST202") {
      rpcMissing = true;
      break;
    }
    if (result.error) return new Map();
    const map = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data : {};
    for (const [taskId, value] of Object.entries(map)) {
      const label = requestLabelFrom(value);
      if (label) labels.set(taskId, label);
    }
  }
  return rpcMissing ? legacyRequestLabels(supabase, unique) : labels;
}

// A database without task_request_labels (the release before Oct 19's migration): two reads.
async function legacyRequestLabels(supabase: Db, unique: string[]): Promise<Map<string, RequestLabel>> {
  const tasks = await supabase.from("tasks").select("id, req_label, req_project_id, home_project_id").in("id", unique);
  if (isMissingColumn(tasks.error) || tasks.error) return new Map();
  const projectIds = [
    ...new Set(
      (tasks.data ?? []).flatMap((t) => [t.req_project_id, t.home_project_id].filter((id): id is string => Boolean(id))),
    ),
  ];
  if (projectIds.length === 0) return new Map();
  const sequences = await supabase
    .from("request_sequences")
    .select("project_id, wrap_brackets")
    .in("project_id", projectIds)
    .eq("enabled", true)
    .is("deleted_at", null);
  if (sequences.error) return new Map();
  const wrapFor = new Map((sequences.data ?? []).map((s) => [s.project_id, s.wrap_brackets !== false]));
  const labels = new Map<string, RequestLabel>();
  for (const task of tasks.data ?? []) {
    const projectId = task.req_project_id ?? task.home_project_id;
    const wrap = projectId ? wrapFor.get(projectId) : undefined;
    if (task.req_label && wrap !== undefined) labels.set(task.id, { text: task.req_label, wrap });
  }
  return labels;
}

// Oct 29 notes (batch 7, 55b): no home project. Every project of each task the viewer can read, in the
// stable order (the order the task was added to them: task_projects.created_at, then project id), with
// the number each one gives it — one invoker RPC (task_project_labels: RLS plus an explicit role check per
// project, so a project the viewer can't read, or its number, never comes back). Private tasks (no
// project) have no entry. Null when this database doesn't have the function yet.
async function taskPlacesWith(supabase: Db, ids: string[]): Promise<Map<string, TaskPlace[]> | null> {
  const unique = [...new Set(ids.filter((id) => isUuid(id)))];
  const places = new Map<string, TaskPlace[]>();
  for (let i = 0; i < unique.length; i += 2000) {
    const result = await supabase.rpc("task_project_labels", { task_ids: unique.slice(i, i + 2000) });
    if (rpcMissing(result.error)) return null;
    if (result.error) return places;
    for (const [taskId, list] of placesFromLabels(result.data)) places.set(taskId, list);
  }
  return places;
}

// The one helper behind every list outside a project (My tasks, Home, search, the palette, the Inbox, the
// team Calendar, Waiting on me, blockers, profile pages): where each task is (links and labels use the
// first place) and its numbers. A database without task_project_labels: no places, and each task's
// home-project label as its only number (the release before this one).
export async function visibleTaskPlaces(ctx: ApiContext, ids: string[]): Promise<Map<string, TaskPlace[]>> {
  return (await taskPlacesWith(ctx.db, ids)) ?? new Map();
}

// The same, but null on a database without task_project_labels, so a caller can fall back to the
// release before this one (each task's home-project label, and the project it already names).
export async function visibleTaskPlacesOrNull(ctx: ApiContext, ids: string[]): Promise<Map<string, TaskPlace[]> | null> {
  return taskPlacesWith(ctx.db, ids);
}

export async function visibleTaskNumbers(ctx: ApiContext, ids: string[]): Promise<Map<string, TaskNumber[]>> {
  const supabase = ctx.db;
  const places = await taskPlacesWith(supabase, ids);
  if (places) return numbersFromPlaces(places);
  const labels = await requestLabelsWith(supabase, ids);
  return new Map([...labels].map(([taskId, label]) => [taskId, [{ projectId: null, projectName: null, label }]] as const));
}

// The first number of each task the viewer can read (stable order), for places that show one number.
export async function firstVisibleNumbers(ctx: ApiContext, ids: string[]): Promise<Map<string, RequestLabel>> {
  const numbers = await visibleTaskNumbers(ctx, ids);
  return new Map([...numbers].map(([taskId, list]) => [taskId, list[0].label] as const));
}

// ---------------------------------------------------------------------------------------------
// Oct 27 notes (batch 6)
// ---------------------------------------------------------------------------------------------

// The labels shown inside one project (task_request_labels_in, invoker): that project's own numbers while
// it numbers tasks (its numbers for other projects' tasks too, and for their subtasks), else each task's
// home-project label as before. A database without the function falls back to the home labels.
export async function visibleRequestLabelsIn(ctx: ApiContext, projectId: string, ids: string[]): Promise<Map<string, RequestLabel>> {
  return requestLabelsInWith(ctx.db, projectId, ids);
}

// Same, with a client made earlier (the List CSV export reads inside a stream).
export async function requestLabelsInWith(
  supabase: Db,
  projectId: string,
  ids: string[],
): Promise<Map<string, RequestLabel>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const labels = new Map<string, RequestLabel>();
  if (unique.length === 0) return labels;
  for (let i = 0; i < unique.length; i += 5000) {
    const result = await supabase.rpc("task_request_labels_in", {
      target_project: projectId,
      task_ids: unique.slice(i, i + 5000),
    });
    if (rpcMissing(result.error)) return requestLabelsWith(supabase, unique);
    if (result.error) return new Map();
    const map = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data : {};
    for (const [taskId, value] of Object.entries(map)) {
      const label = requestLabelFrom(value);
      if (label) labels.set(taskId, label);
    }
  }
  return labels;
}

// Every number a task has in the projects the viewer reads (the pane's Projects row).
export async function loadTaskNumbers(supabase: Db, taskId: string): Promise<Record<string, RequestLabel>> {
  const result = await supabase.rpc("task_numbers", { target_task: taskId });
  return result.error ? {} : taskNumbersFrom(result.data);
}

// A task's number and the project named next to it, picked together (Oct 29 notes, 55b): the first
// number the viewer can read with the project that issued it, else (no number) the first project they can
// read. A database without task_project_labels: the release before this one — each task's home-project
// label, next to the project the RPC named.
export async function numbersWithTheirProjects(
  ctx: ApiContext,
  tasks: { id: string; projectId: string | null }[],
): Promise<Map<string, { label: RequestLabel | null; projectName: string | null }>> {
  const ids = tasks.map((t) => t.id);
  const places = await visibleTaskPlacesOrNull(ctx, ids);
  if (places) {
    return new Map(
      tasks.map((t) => {
        const paired = numberWithItsProject(places.get(t.id));
        return [t.id, { label: paired.label, projectName: paired.projectName }] as const;
      }),
    );
  }
  const projectIds = [...new Set(tasks.map((t) => t.projectId).filter((p): p is string => Boolean(p)))];
  const [labels, projects] = await Promise.all([
    firstVisibleNumbers(ctx, ids),
    projectIds.length ? ctx.db.from("projects").select("id, name").in("id", projectIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  const names = new Map((projects.data ?? []).map((p) => [p.id, p.name] as const));
  return new Map(
    tasks.map((t) => [t.id, { label: labels.get(t.id) ?? null, projectName: t.projectId ? (names.get(t.projectId) ?? null) : null }] as const),
  );
}

// Nov 8 notes (batch 30): Customize's numbering switch and page say how many tasks a change touches —
// `unnumbered`: active top-level tasks here without this project's number (what "Also number the N tasks
// already here" numbers), `labelled`: tasks whose stored label this project renders (what a format change
// relabels). Head counts through RLS; null when a count can't be read.
export async function numberingCounts(ctx: ApiContext, projectId: string): Promise<NumberingCounts> {
  if (!isUuid(projectId)) return { unnumbered: null, labelled: null };
  const supabase = ctx.db;
  const [all, numbered, labelled] = await Promise.all([
    supabase
      .from("task_projects")
      .select("task_id, task:tasks!inner(deleted_at)", { count: "exact", head: true })
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .is("task.deleted_at", null),
    supabase.from("task_project_numbers").select("task_id", { count: "exact", head: true }).eq("project_id", projectId),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("home_project_id", projectId)
      .is("deleted_at", null)
      .not("req_label", "is", null),
  ]);
  const unnumbered =
    all.error || all.count === null ? null : Math.max(0, all.count - (numbered.error ? 0 : (numbered.count ?? 0)));
  return { unnumbered, labelled: labelled.error ? null : labelled.count };
}
