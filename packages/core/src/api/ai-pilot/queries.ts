// AI builder pilot (experimental): the seed script's reads, as the signed-in operator (RLS decides).
import type { Json } from "../../supabase/database.types";
import type { ApiContext } from "../core/context";
import { maybe, rows } from "../core/db";
import { id } from "../core/validate";

export async function findPilotByMarker(ctx: ApiContext, marker: string): Promise<{ workspaceId: string } | null> {
  const row = maybe(
    await ctx.db.from("ai_pilot_workspaces").select("workspace_id, marker").eq("marker", id(marker, "marker")).is("cleaned_at", null).maybeSingle(),
    "pilot registry",
  );
  return row ? { workspaceId: row.workspace_id } : null;
}

export async function isPilotAdmin(ctx: ApiContext, workspaceId: string): Promise<boolean> {
  const res = await ctx.db.rpc("ai_pilot_admin", { target_workspace: id(workspaceId, "workspace") });
  return maybe(res, "pilot access") === true;
}

export async function getProjectState(ctx: ApiContext, projectId: string) {
  return maybe(
    await ctx.db.from("projects").select("id, workspace_id, name, deleted_at").eq("id", id(projectId, "project")).maybeSingle(),
    "project",
  );
}

// Who else is in a practice project, and whether it has automations (the seed refuses to write into a
// project where anyone else could be notified or anything could run).
export async function projectSafety(ctx: ApiContext, projectId: string): Promise<{ memberIds: string[]; rules: number }> {
  const [members, rules] = await Promise.all([
    ctx.db.from("project_members").select("profile_id").eq("project_id", projectId).is("deleted_at", null),
    ctx.db.from("rules").select("id").eq("project_id", projectId).is("deleted_at", null),
  ]);
  return { memberIds: rows(members, "members").map((m) => m.profile_id), rules: rows(rules, "automations").length };
}

// The importer's map for a project: "<kind>:<external id>" → local id.
export async function importedIds(ctx: ApiContext, projectId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const page = rows(
      await ctx.db
        .from("import_external_ids")
        .select("kind, external_id, local_id")
        .eq("project_id", projectId)
        .order("id")
        .range(from, from + 999),
      "imported ids",
    );
    for (const r of page) map.set(`${r.kind}:${r.external_id}`, r.local_id);
    if (page.length < 1000) return map;
  }
}

export async function fieldOptions(ctx: ApiContext, fieldId: string): Promise<{ id: string; name: string }[]> {
  const row = maybe(await ctx.db.from("custom_fields").select("options").eq("id", fieldId).maybeSingle(), "field");
  const options = (row?.options ?? []) as Json;
  return Array.isArray(options)
    ? options.flatMap((o) => (o && typeof o === "object" && !Array.isArray(o) && typeof o.id === "string" && typeof o.name === "string" ? [{ id: o.id, name: o.name }] : []))
    : [];
}

async function count(query: PromiseLike<{ count: number | null; error: { code?: string; message?: string } | null }>, what: string) {
  const res = await query;
  if (res.error) maybe({ data: null, error: res.error }, what);
  return res.count ?? 0;
}

// What a practice project holds now (verification after the seed).
export async function projectCounts(ctx: ApiContext, projectId: string) {
  const db = ctx.db;
  const [sections, fields, memberships, tasks, subtasks, comments] = await Promise.all([
    count(db.from("sections").select("id", { count: "exact", head: true }).eq("project_id", projectId).is("deleted_at", null), "sections"),
    db.from("custom_fields").select("options").eq("project_id", projectId).is("deleted_at", null),
    count(db.from("task_projects").select("task_id", { count: "exact", head: true }).eq("project_id", projectId).is("deleted_at", null), "memberships"),
    count(db.from("tasks").select("id", { count: "exact", head: true }).eq("home_project_id", projectId).is("parent_task_id", null).is("deleted_at", null), "tasks"),
    count(db.from("tasks").select("id", { count: "exact", head: true }).eq("home_project_id", projectId).not("parent_task_id", "is", null).is("deleted_at", null), "subtasks"),
    count(db.from("comments").select("id, tasks!inner(home_project_id)", { count: "exact", head: true }).eq("tasks.home_project_id", projectId).is("deleted_at", null), "comments"),
  ]);
  const fieldRows = rows(fields, "fields");
  return {
    sections,
    fields: fieldRows.length,
    options: fieldRows.reduce((n, f) => n + (Array.isArray(f.options) ? f.options.length : 0), 0),
    memberships,
    tasks,
    subtasks,
    comments,
  };
}
