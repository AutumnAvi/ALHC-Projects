"use server";
// Big move 1: the templates area's Server Actions (project templates, Duplicate project, task templates),
// thin wrappers around packages/core/src/api/templates/mutations.ts. Only what Next.js does (redirects, the
// request's context) stays here.
import { redirect } from "next/navigation";
import type { ActionResult } from "@alhc/core/api/core/result";
import type {
  DuplicateProjectInput,
  ProjectFromTemplateInput,
  SaveProjectTemplateInput,
  TaskTemplatePatch,
} from "@alhc/core/api/templates/model";
import * as templatesApi from "@alhc/core/api/templates/mutations";
import { run, runWith } from "@/lib/server/action";

// ---------------------------------------------------------------------------------------------
// Templates and Duplicate project (one copy engine in SQL: see 20261006020000_templates.sql).
// Copies fire no rules or notifications, and every copied rule lands disabled.
// ---------------------------------------------------------------------------------------------

export async function saveProjectAsTemplate(
  projectId: string,
  input: SaveProjectTemplateInput,
): Promise<ActionResult & { templateId?: string }> {
  return runWith((ctx) => templatesApi.saveProjectAsTemplate(ctx, projectId, input));
}

export async function createProjectFromTemplate(templateId: string, input: ProjectFromTemplateInput): Promise<ActionResult> {
  let projectId: string | null = null;
  const result = await run(async (ctx) => {
    projectId = await templatesApi.createProjectFromTemplate(ctx, templateId, input);
  });
  if (projectId && !result.error) redirect(`/projects/${projectId}`);
  return result;
}

export async function duplicateProject(projectId: string, input: DuplicateProjectInput): Promise<ActionResult> {
  let newProjectId: string | null = null;
  const result = await run(async (ctx) => {
    newProjectId = await templatesApi.duplicateProject(ctx, projectId, input);
  });
  if (newProjectId && !result.error) redirect(`/projects/${newProjectId}`);
  return result;
}

export async function updateProjectTemplate(
  templateId: string,
  input: { name: string; description: string | null },
): Promise<ActionResult> {
  return run((ctx) => templatesApi.updateProjectTemplate(ctx, templateId, input));
}

export async function deleteProjectTemplate(templateId: string): Promise<ActionResult> {
  return run((ctx) => templatesApi.deleteProjectTemplate(ctx, templateId));
}

// ---------------------------------------------------------------------------------------------
// Task templates
// ---------------------------------------------------------------------------------------------

export async function saveTaskAsTemplate(
  taskId: string,
  projectId: string,
  input: { name: string; includeAssignee: boolean },
): Promise<ActionResult> {
  return run((ctx) => templatesApi.saveTaskAsTemplate(ctx, taskId, projectId, input));
}

// From quick-add: a normal task creation. `lockedLeftOut`: the template's values of locked fields the
// viewer may not set (the database leaves them out; the caller says so).
export async function createTaskFromTemplate(
  templateId: string,
  sectionId: string | null,
  title: string | null,
): Promise<ActionResult & { lockedLeftOut?: number; taskId?: string; kind?: string }> {
  return runWith((ctx) => templatesApi.createTaskFromTemplate(ctx, templateId, sectionId, title));
}

export async function createTaskTemplate(projectId: string, input: { name: string; title: string }): Promise<ActionResult> {
  return run((ctx) => templatesApi.createTaskTemplate(ctx, projectId, input));
}

export async function updateTaskTemplate(templateId: string, patch: TaskTemplatePatch): Promise<ActionResult> {
  return run((ctx) => templatesApi.updateTaskTemplate(ctx, templateId, patch));
}

export async function deleteTaskTemplate(templateId: string): Promise<ActionResult> {
  return run((ctx) => templatesApi.deleteTaskTemplate(ctx, templateId));
}
