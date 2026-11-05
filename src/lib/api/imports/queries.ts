// Big move 1: the imports area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getSignedInUser } from "@/lib/api/auth/queries";
import { type ApiContext, read } from "@/lib/api/core/context";
import { check, rows } from "@/lib/api/core/db";
import { ApiError, invalid } from "@/lib/api/core/errors";
import { id } from "@/lib/api/core/validate";
import type {
  ImportFile,
  ImportParser,
  ImportPlanView,
  ImportRun,
  ParsedImport,
  WorkspaceImportRun,
} from "@/lib/api/imports/model";
import {
  IMPORTS_BUCKET,
  MAX_IMPORT_FILES,
  MAX_IMPORT_FILE_BYTES,
  importFileKind,
  importFileName,
  type ImportPerson,
  type ImportPreview,
} from "@/lib/imports-shared";

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

// ---------------------------------------------------------------------------------------------
// Asana import (Admin+). Export files are uploaded by the browser to the private `imports` bucket;
// the import downloads them with the caller's own client and parses them (the adapter's parser, as
// `parse`), then sends rpc("import_batch") batches (mutations.ts). Never calls the Asana API.
// ---------------------------------------------------------------------------------------------

// The uploaded export files of an import, downloaded with the caller's own client and parsed.
export async function loadImportPlan(
  ctx: ApiContext,
  projectId: string,
  paths: unknown,
  parse: ImportParser,
): Promise<ParsedImport & { files: string[] }> {
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) throw invalid("Sign in again to import");
  if (!Array.isArray(paths) || paths.length === 0) throw invalid("Choose at least one export file");
  if (paths.length > MAX_IMPORT_FILES) throw invalid(`Import up to ${MAX_IMPORT_FILES} files at a time`);
  await requireImportAdmin(ctx, projectId);
  const prefix = `${projectId}/${user.id}/`;
  const files: ImportFile[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || !path.startsWith(prefix) || path.includes("..") || path.split("/").length !== 3) {
      throw invalid("Invalid upload");
    }
    const name = importFileName(path);
    if (!importFileKind(name)) throw invalid(`${name}: only .json and .csv Asana exports can be imported`);
    const download = await supabase.storage.from(IMPORTS_BUCKET).download(path);
    if (download.error || !download.data) {
      throw new ApiError("failed", `Couldn’t read ${name}. Upload it again and retry.`);
    }
    if (download.data.size > MAX_IMPORT_FILE_BYTES) throw invalid(`${name} is larger than 50 MB`);
    files.push({ name, text: await download.data.text() });
  }
  // The parser refuses a file it can't read with ApiError("invalid", <why>).
  return { ...parse(files), files: files.map((f) => f.name) };
}

async function requireImportAdmin(ctx: ApiContext, projectId: string) {
  const supabase = ctx.db;
  const roleResult = await supabase.rpc("project_role", { target_project: projectId });
  check(roleResult);
  if (roleResult.data !== "owner" && roleResult.data !== "admin") {
    throw new ApiError("forbidden", "You need Admin access to import into this project");
  }
}

type PeopleBuckets = ImportPreview["people"];

export async function classifyPeople(ctx: ApiContext, projectId: string, plan: ImportPlanView): Promise<PeopleBuckets> {
  const supabase = ctx.db;
  const [members, profiles] = await Promise.all([
    supabase
      .from("project_members")
      .select("profile:profiles!project_members_profile_id_fkey!inner(email)")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase.from("profiles").select("email"),
  ]);
  check(members);
  check(profiles);
  const memberEmails = new Set((members.data ?? []).map((m) => m.profile.email.toLowerCase()));
  const accountEmails = new Set((profiles.data ?? []).map((p) => p.email.toLowerCase()));
  const buckets: PeopleBuckets = { matched: [], notMember: [], noAccount: [], noEmail: [] };
  for (const person of plan.people) {
    const entry: ImportPerson = { name: person.name, email: person.email, references: person.references };
    if (!person.email) buckets.noEmail.push(entry);
    else if (memberEmails.has(person.email)) buckets.matched.push(entry);
    else if (accountEmails.has(person.email)) buckets.notMember.push(entry);
    else buckets.noAccount.push(entry);
  }
  return buckets;
}

// Dry run: parses the uploaded files and reports what an import would add. Writes nothing.
export async function previewAsanaImport(
  ctx: ApiContext,
  projectId: string,
  paths: string[],
  parse: ImportParser,
): Promise<{ preview: ImportPreview }> {
  const project = id(projectId, "project");
  const loaded = await loadImportPlan(ctx, project, paths, parse);
  const { plan, files } = loaded;
  const supabase = ctx.db;

  const ids = loaded.externalIds();
  const all = [...new Set(Object.values(ids).flat())];
  const found: { project_id: string; kind: string; external_id: string }[] = [];
  for (let i = 0; i < all.length; i += 5000) {
    const lookup = await supabase.rpc("import_lookup", { import_source: "asana", external_ids: all.slice(i, i + 5000) });
    check(lookup);
    found.push(...(lookup.data ?? []));
  }
  const existing = (kind: keyof typeof ids) => {
    const here = new Set(found.filter((f) => f.project_id === project && f.kind === kind).map((f) => f.external_id));
    return ids[kind].filter((x) => here.has(x)).length;
  };
  const elsewhereIds = [
    ...new Set(found.filter((f) => f.kind === "project" && f.project_id !== project).map((f) => f.project_id)),
  ];
  const elsewhere = elsewhereIds.length
    ? ((await supabase.from("projects").select("id, name").in("id", elsewhereIds).is("deleted_at", null)).data ?? [])
    : [];

  // Sections and fields that already exist by name are reused, not duplicated.
  const [sectionRows, fieldRows] = await Promise.all([
    supabase.from("sections").select("name").eq("project_id", project).is("deleted_at", null),
    supabase.from("custom_fields").select("name, field_type").eq("project_id", project).is("deleted_at", null),
  ]);
  const sectionNames = new Set((sectionRows.data ?? []).map((r) => r.name.toLowerCase()));
  const fieldNames = new Set((fieldRows.data ?? []).map((r) => `${r.field_type}:${r.name.toLowerCase()}`));
  const mappedSections = new Set(found.filter((f) => f.project_id === project && f.kind === "section").map((f) => f.external_id));
  const mappedFields = new Set(found.filter((f) => f.project_id === project && f.kind === "field").map((f) => f.external_id));

  const people = await classifyPeople(ctx, project, plan);
  const preview: ImportPreview = {
    files,
    sourceProject: plan.project?.name ?? null,
    importedElsewhere: elsewhere.map((p) => ({ id: p.id, name: p.name })),
    counts: {
      tasks: { total: plan.tasks.length, existing: existing("task") },
      subtasks: { total: ids.subtask.length, existing: existing("subtask") },
      comments: { total: ids.comment.length, existing: existing("comment") },
      attachments: { total: ids.attachment.length, existing: existing("attachment") },
      sections: {
        total: plan.sections.length,
        existing: plan.sections.filter((s) => mappedSections.has(s.key) || sectionNames.has(s.name.toLowerCase())).length,
      },
      fields: {
        total: plan.fields.length,
        existing: plan.fields.filter((f) => mappedFields.has(f.key) || fieldNames.has(`${f.type}:${f.name.toLowerCase()}`)).length,
      },
      tags: plan.tagCount,
      dependencies: plan.dependencies.length,
      rules: plan.rules.length,
      attachmentFiles: plan.attachmentFiles.filter((f) => f.downloadUrl !== null).length,
      attachmentFilesNeedToken: plan.attachmentFiles.filter((f) => f.downloadUrl === null).length,
    },
    people,
    warnings: plan.warnings,
    steps: loaded.steps().length,
  };
  return { preview };
}
