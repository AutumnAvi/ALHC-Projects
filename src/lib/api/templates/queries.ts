// Big move 1: the templates area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "@/lib/api/core/context";
import { maybe, rows } from "@/lib/api/core/db";
import type { ProjectTemplate } from "@/lib/api/templates/model";
import { type TaskTemplate, toTaskTemplate } from "@/lib/row-mappers";
import { parseTemplateSummary } from "@/lib/templates";

// Workspace templates: everyone allowlisted can see and use them.
export const listProjectTemplates = read(async (ctx: ApiContext): Promise<ProjectTemplate[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("project_templates")
    .select("id, name, description, summary, is_example, source_project_id, created_by, updated_at, creator:profiles(email, full_name)")
    .is("deleted_at", null)
    .order("is_example", { ascending: false })
    .order("name");
  const templates = rows(result, "templates");
  const sourceIds = [...new Set(templates.map((t) => t.source_project_id).filter((id): id is string => Boolean(id)))];
  const [sources, manage] = await Promise.all([
    sourceIds.length
      ? supabase.from("projects").select("id, name").in("id", sourceIds).is("deleted_at", null)
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    Promise.all(
      templates.map(async (t) =>
        maybe(await supabase.rpc("can_manage_project_template", { target_template: t.id }), "template access"),
      ),
    ),
  ]);
  const sourceNames = new Map(rows(sources, "template sources").map((p) => [p.id, p.name]));
  return templates.map((t, index) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    summary: parseTemplateSummary(t.summary),
    isExample: t.is_example,
    sourceProject:
      t.source_project_id && sourceNames.has(t.source_project_id)
        ? { id: t.source_project_id, name: sourceNames.get(t.source_project_id)! }
        : null,
    createdByName: t.creator ? (t.creator.full_name ?? t.creator.email) : null,
    createdBy: t.created_by,
    updatedAt: t.updated_at,
    canManage: manage[index] === true,
  }));
});

const TASK_TEMPLATE_COLUMNS = "id, project_id, name, title, notes, subtasks, field_values, assignee_id, updated_at";

export const listTaskTemplates = read(async (ctx: ApiContext, projectId: string): Promise<TaskTemplate[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("task_templates")
    .select(TASK_TEMPLATE_COLUMNS)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "task templates").map(toTaskTemplate);
});

// Every task template the viewer can see (RLS: Viewer+ of its project), for the gallery.
export const listAllTaskTemplates = read(async (ctx: ApiContext): Promise<(TaskTemplate & { projectName: string })[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("task_templates")
    .select(`${TASK_TEMPLATE_COLUMNS}, project:projects!inner(name, deleted_at)`)
    .is("deleted_at", null)
    .is("project.deleted_at", null)
    .order("name");
  return rows(result, "task templates").map((t) => ({ ...toTaskTemplate(t), projectName: t.project.name }));
});
