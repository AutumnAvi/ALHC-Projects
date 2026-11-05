// Big move 1: the templates area's writes (project templates, Duplicate project, task templates). Every
// function takes the caller's ApiContext first, validates its own input, writes only through ctx.db (RLS
// and the RPCs decide), and throws ApiError on any refusal; no Next.js here.
//
// Templates and Duplicate project use one copy engine in SQL (see 20261006020000_templates.sql). Copies
// fire no rules or notifications, and every copied rule lands disabled.
import { ORDER_STEP } from "@/lib/api/core/constants";
import type { ApiContext } from "@/lib/api/core/context";
import { check, checkUpdated, nowIso } from "@/lib/api/core/db";
import { ApiError, invalid } from "@/lib/api/core/errors";
import { id, optionalIsoDate, optionalText, projectVisibility, text } from "@/lib/api/core/validate";
import { placeNewProject } from "@/lib/api/projects/placement";
import { getProjectRole } from "@/lib/api/projects/queries";
import type {
  DuplicateProjectInput,
  ProjectFromTemplateInput,
  SaveProjectTemplateInput,
  TaskTemplatePatch,
} from "@/lib/api/templates/model";
import { isUuid } from "@/lib/ids";
import type { TemplateCustomization } from "@/lib/project-roles";
import { hasRole } from "@/lib/roles";
import type { Json } from "@/lib/supabase/database.types";
import { MAX_TEMPLATE_SUBTASKS, parseCopyResult } from "@/lib/templates";
import { isProjectVisibility } from "@/lib/workspace";

// ---------------------------------------------------------------------------------------------
// Project templates and Duplicate project
// ---------------------------------------------------------------------------------------------

// Answers the saved template's id.
export async function saveProjectAsTemplate(
  ctx: ApiContext,
  projectId: string,
  input: SaveProjectTemplateInput,
): Promise<{ templateId?: string }> {
  const supabase = ctx.db;
  const saved = await supabase.rpc("save_project_as_template", {
    source_project: id(projectId),
    template_name: text(input.name, "Template name", { max: 100 }),
    template_description: optionalText(input.description, 2000),
    anchor_on: optionalIsoDate(input.startOn, "start date"),
    replace_template: input.replaceTemplateId ? id(input.replaceTemplateId, "template") : null,
  });
  check(saved);
  return { templateId: saved.data ?? undefined };
}

// Answers the new project's id.
export async function createProjectFromTemplate(
  ctx: ApiContext,
  templateId: string,
  input: ProjectFromTemplateInput,
): Promise<string> {
  const teamId = input.teamId ? id(input.teamId, "team") : null;
  const visibility = input.visibility ? projectVisibility(input.visibility) : null;
  const supabase = ctx.db;
  const custom = input.customization ? customizationJson(input.customization) : null;
  let created = custom
    ? await supabase.rpc("create_project_from_template_custom", {
        target_template: id(templateId, "template"),
        project_name: text(input.name, "Project name", { max: 200 }),
        start_on: optionalIsoDate(input.startOn, "start date"),
        customization: custom,
      })
    : null;
  if (created?.error?.code === "PGRST202") {
    throw invalid("Customizing a template before creating needs this release’s database update");
  }
  created ??= await supabase.rpc("create_project_from_template", {
    target_template: id(templateId, "template"),
    project_name: text(input.name, "Project name", { max: 200 }),
    start_on: optionalIsoDate(input.startOn, "start date"),
  });
  check(created);
  const projectId = parseCopyResult(created.data)?.projectId ?? null;
  if (!projectId) throw new ApiError("failed", "The project could not be created");
  await placeNewProject(ctx, projectId, teamId, visibility);
  return projectId;
}

// The customize step's edits as the database takes them: ids checked, text trimmed and capped.
function customizationJson(c: TemplateCustomization): Json | null {
  const entries = <T,>(o: Record<string, T>) => Object.entries(o ?? {}).filter(([k]) => isUuid(k)).slice(0, 2000);
  const named = (o: Record<string, { name?: string; skip?: boolean }>, max: number) =>
    Object.fromEntries(
      entries(o).map(([k, v]) => [k, v?.skip ? { skip: true } : { name: typeof v?.name === "string" ? v.name.trim().slice(0, max) : "" }]),
    );
  const out = {
    sections: named(c.sections, 200),
    fields: named(c.fields, 100),
    tasks: Object.fromEntries(
      entries(c.tasks).map(([k, v]) => [k, v?.skip ? { skip: true } : { title: typeof v?.title === "string" ? v.title.trim().slice(0, 1000) : "" }]),
    ),
    added_tasks: (Array.isArray(c.added_tasks) ? c.added_tasks : [])
      .filter((a) => a && typeof a.title === "string" && a.title.trim())
      .slice(0, 200)
      .map((a) => ({ section_id: a.section_id && isUuid(a.section_id) ? a.section_id : null, title: a.title.trim().slice(0, 1000) })),
    roles: Object.fromEntries(entries(c.roles).filter(([, v]) => typeof v === "string" && isUuid(v))),
  };
  const empty =
    !Object.keys(out.sections).length && !Object.keys(out.fields).length && !Object.keys(out.tasks).length &&
    !out.added_tasks.length && !Object.keys(out.roles).length;
  return empty ? null : (out as unknown as Json);
}

// Answers the copy's id.
export async function duplicateProject(ctx: ApiContext, projectId: string, input: DuplicateProjectInput): Promise<string> {
  const o = input.options;
  const supabase = ctx.db;
  const created = await supabase.rpc("duplicate_project", {
    source_project: id(projectId),
    project_name: text(input.name, "Project name", { max: 200 }),
    options: {
      tasks: Boolean(o.tasks),
      assignees: Boolean(o.tasks && o.assignees),
      dates: Boolean(o.tasks && o.dates),
      start_on: o.tasks && o.dates ? optionalIsoDate(o.startOn, "start date") : null,
      rules: Boolean(o.rules),
      forms: Boolean(o.forms),
      members: Boolean(o.members),
    },
  });
  check(created);
  const newProjectId = parseCopyResult(created.data)?.projectId ?? null;
  if (!newProjectId) throw new ApiError("failed", "The project could not be duplicated");
  // A duplicate stays in the source's team and keeps its privacy.
  const { data: source } = await supabase.from("projects").select("team_id, visibility").eq("id", projectId).maybeSingle();
  if (source) await placeNewProject(ctx, newProjectId, source.team_id, isProjectVisibility(source.visibility) ? source.visibility : null);
  return newProjectId;
}

export async function updateProjectTemplate(
  ctx: ApiContext,
  templateId: string,
  input: { name: string; description: string | null },
): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("update_project_template", {
      target_template: id(templateId, "template"),
      template_name: text(input.name, "Template name", { max: 100 }),
      template_description: optionalText(input.description, 2000),
    }),
  );
}

export async function deleteProjectTemplate(ctx: ApiContext, templateId: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("delete_project_template", { target_template: id(templateId, "template") }));
}

// ---------------------------------------------------------------------------------------------
// Task templates
// ---------------------------------------------------------------------------------------------

export async function saveTaskAsTemplate(
  ctx: ApiContext,
  taskId: string,
  projectId: string,
  input: { name: string; includeAssignee: boolean },
): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("save_task_as_template", {
      target_task: id(taskId, "task"),
      target_project: id(projectId),
      template_name: text(input.name, "Template name", { max: 100 }),
      include_assignee: Boolean(input.includeAssignee),
    }),
  );
}

// From quick-add: a normal task creation (stories, notifications, and task_created rules as usual).
// `lockedLeftOut`: the template's values of locked fields the viewer may not set (Oct 29 notes, batch
// 7) — the database leaves them out; the caller says so.
export async function createTaskFromTemplate(
  ctx: ApiContext,
  templateId: string,
  sectionId: string | null,
  title: string | null,
): Promise<{ lockedLeftOut: number; taskId: string | undefined; kind: string | undefined }> {
  const supabase = ctx.db;
  const templateKey = id(templateId, "template");
  const created = await supabase.rpc("create_task_from_template", {
    target_template: templateKey,
    target_section: sectionId ? id(sectionId, "section") : null,
    task_title: optionalText(title, 1000),
  });
  check(created);
  const taskId = typeof created.data === "string" ? created.data : undefined;
  let kind: string | undefined;
  // Nov 1 notes, batch 9a: an approval task from a template opens the guided approval setup.
  if (taskId) kind = (await supabase.from("tasks").select("kind").eq("id", taskId).maybeSingle()).data?.kind ?? undefined;
  const lockedLeftOut = await lockedTemplateValues(ctx, templateKey);
  return { lockedLeftOut, taskId, kind };
}

// How many of a task template's values are in locked fields the viewer can't set (a template's fields
// are its project's, so it's that project's Owners and Admins).
async function lockedTemplateValues(ctx: ApiContext, templateId: string): Promise<number> {
  const supabase = ctx.db;
  const { data: template } = await supabase
    .from("task_templates")
    .select("project_id, field_values")
    .eq("id", templateId)
    .maybeSingle();
  const values = Array.isArray(template?.field_values) ? template.field_values : [];
  const fieldIds = values.flatMap((v) =>
    v && typeof v === "object" && !Array.isArray(v) && typeof v.field_id === "string" && isUuid(v.field_id) && v.value != null
      ? [v.field_id]
      : [],
  );
  if (!template || fieldIds.length === 0) return 0;
  const locked = await supabase.from("custom_fields").select("id").in("id", fieldIds).eq("locked", true).is("deleted_at", null);
  // A database without the field lock (42703) has nothing locked.
  const lockedIds = locked.error ? [] : (locked.data ?? []);
  if (lockedIds.length === 0 || hasRole(await getProjectRole(ctx, template.project_id), "admin")) return 0;
  return lockedIds.length;
}

export async function createTaskTemplate(
  ctx: ApiContext,
  projectId: string,
  input: { name: string; title: string },
): Promise<void> {
  const supabase = ctx.db;
  const { data: last } = await supabase
    .from("task_templates")
    .select("sort_order")
    .eq("project_id", id(projectId))
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  check(
    await supabase.from("task_templates").insert({
      project_id: projectId,
      name: text(input.name, "Template name", { max: 100 }),
      title: text(input.title, "Task name", { max: 1000 }),
      sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
    }),
  );
}

export async function updateTaskTemplate(ctx: ApiContext, templateId: string, patch: TaskTemplatePatch): Promise<void> {
  const update: {
    name?: string;
    title?: string;
    notes?: string | null;
    subtasks?: string[];
    assignee_id?: null;
  } = {};
  if (patch.name !== undefined) update.name = text(patch.name, "Template name", { max: 100 });
  if (patch.title !== undefined) update.title = text(patch.title, "Task name", { max: 1000 });
  if (patch.notes !== undefined) update.notes = optionalText(patch.notes, 50000);
  if (patch.subtasks !== undefined) {
    const titles = patch.subtasks.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
    if (titles.length > MAX_TEMPLATE_SUBTASKS) throw invalid(`Up to ${MAX_TEMPLATE_SUBTASKS} subtasks`);
    if (titles.some((t) => t.length > 1000)) throw invalid("A subtask title is too long");
    update.subtasks = titles;
  }
  if (patch.clearAssignee) update.assignee_id = null;
  const supabase = ctx.db;
  checkUpdated(await supabase.from("task_templates").update(update).eq("id", id(templateId, "template")).select("id"));
}

export async function deleteTaskTemplate(ctx: ApiContext, templateId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("task_templates")
      .update({ deleted_at: nowIso() })
      .eq("id", id(templateId, "template"))
      .select("id"),
  );
}
