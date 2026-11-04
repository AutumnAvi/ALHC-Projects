// Big move 1: the imports area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "@/lib/api/core/context";
import { rows } from "@/lib/api/core/db";
import type { ImportRun, WorkspaceImportRun } from "@/lib/api/imports/model";

export const listImportRuns = read(async (ctx: ApiContext, projectId: string): Promise<ImportRun[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("import_runs")
    .select("id, source, status, file_names, summary, created_by, created_at, finished_at, creator:profiles(email, full_name)")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(20);
  return rows(result, "imports").map((r) => ({
    id: r.id,
    source: r.source,
    status: r.status === "completed" || r.status === "failed" ? r.status : "running",
    fileNames: r.file_names ?? [],
    summary: r.summary && typeof r.summary === "object" && !Array.isArray(r.summary) ? (r.summary as Record<string, unknown>) : {},
    createdBy: r.created_by,
    createdByName: r.creator ? (r.creator.full_name ?? r.creator.email) : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }));
});

// Past imports across the workspace. RLS shows a workspace admin the runs of projects they can read
// (any role), and project admins their own projects' runs; nothing else.
export const listWorkspaceImportRuns = read(async (ctx: ApiContext): Promise<WorkspaceImportRun[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("import_runs")
    .select(
      "id, project_id, source, status, file_names, summary, created_by, created_at, finished_at, creator:profiles(email, full_name), project:projects!inner(name, deleted_at)",
    )
    .is("deleted_at", null)
    .is("project.deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  return rows(result, "imports").map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectName: r.project.name,
    source: r.source,
    status: r.status === "completed" || r.status === "failed" ? r.status : "running",
    fileNames: r.file_names ?? [],
    summary: r.summary && typeof r.summary === "object" && !Array.isArray(r.summary) ? (r.summary as Record<string, unknown>) : {},
    createdBy: r.created_by,
    createdByName: r.creator ? (r.creator.full_name ?? r.creator.email) : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }));
});
