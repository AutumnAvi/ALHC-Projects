"use server";
// Big move 1: the projects area's Server Actions, thin wrappers around packages/core/src/api/projects/mutations.ts.
// Only what Next.js does (redirects, cached pages, the request's context) stays here.
import { redirect } from "next/navigation";
import type { AccessGrantRole } from "@alhc/core/access-requests";
import type { ActionResult } from "@alhc/core/api/core/result";
import type { ProjectTeamChoice, StatusTemplateInput } from "@alhc/core/api/projects/model";
import * as projectsApi from "@alhc/core/api/projects/mutations";
import * as projectsQueries from "@alhc/core/api/projects/queries";
import { run, runWith } from "@/lib/server/action";
import { actionContext } from "@/lib/server/context";

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export async function createProject(formData: FormData): Promise<ActionResult> {
  let projectId: string | null = null;
  const result = await run(async (ctx) => {
    projectId = await projectsApi.createProject(ctx, {
      name: formData.get("name"),
      team: formData.get("team"),
      visibility: formData.get("visibility"),
    });
  });
  if (projectId && !result.error) {
    redirect(formData.get("then") === "import" ? `/projects/${projectId}/settings/import` : `/projects/${projectId}/list`);
  }
  return result;
}

export async function updateProjectTeam(
  projectId: string,
  patch: { teamId?: string; visibility?: string },
): Promise<ActionResult> {
  return run((ctx) => projectsApi.updateProjectTeam(ctx, projectId, patch));
}

export async function joinProject(projectId: string): Promise<ActionResult> {
  return run((ctx) => projectsApi.joinProject(ctx, projectId));
}

export async function updateProject(
  projectId: string,
  patch: { name?: string; description?: string | null; dueOn?: string | null },
): Promise<ActionResult> {
  return run((ctx) => projectsApi.updateProject(ctx, projectId, patch));
}

export async function deleteProject(projectId: string): Promise<ActionResult> {
  const result = await run((ctx) => projectsApi.deleteProject(ctx, projectId));
  if (!result.error) redirect("/");
  return result;
}

// Oct 26 notes (batch 4): every page that lists projects (sidebar, Home, Browse, pickers) changes, so drop
// the browser's cached copies too, not just this page's.
export async function setProjectArchived(projectId: string, archived: boolean): Promise<ActionResult> {
  return run((ctx) => projectsApi.setProjectArchived(ctx, projectId, archived), { revalidate: [["/", "layout"]] });
}

export async function setProjectStatus(
  projectId: string,
  status: string,
  note: string | null,
  title?: string | null,
): Promise<ActionResult> {
  return run((ctx) => projectsApi.setProjectStatus(ctx, projectId, status, note, title));
}

export async function listProjectTeamChoices(): Promise<ProjectTeamChoice[]> {
  return projectsQueries.listProjectTeamChoices(await actionContext());
}

export async function listProjectTemplateChoices() {
  return projectsQueries.listProjectTemplateChoices(await actionContext());
}

export async function setSectionsLocked(projectId: string, locked: boolean): Promise<ActionResult> {
  return run((ctx) => projectsApi.setSectionsLocked(ctx, projectId, locked));
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

export async function createSection(
  projectId: string,
  name: string,
  beforeSectionId: string | null = null,
): Promise<ActionResult> {
  return run((ctx) => projectsApi.createSection(ctx, projectId, name, beforeSectionId));
}

export async function renameSection(sectionId: string, name: string): Promise<ActionResult> {
  return run((ctx) => projectsApi.renameSection(ctx, sectionId, name));
}

export async function deleteSection(sectionId: string): Promise<ActionResult> {
  return run((ctx) => projectsApi.deleteSection(ctx, sectionId));
}

// ---------------------------------------------------------------------------------------------
// Access requests
// ---------------------------------------------------------------------------------------------

export async function requestProjectAccess(projectId: string): Promise<ActionResult & { status?: string }> {
  return runWith((ctx) => projectsApi.requestProjectAccess(ctx, projectId));
}

export async function decideAccessRequest(
  requestId: string,
  decision: "approve" | "decline",
  role: AccessGrantRole = "default",
): Promise<ActionResult & { status?: string }> {
  return runWith((ctx) => projectsApi.decideAccessRequest(ctx, requestId, decision, role));
}

// ---------------------------------------------------------------------------------------------
// Status templates
// ---------------------------------------------------------------------------------------------

export async function createStatusTemplate(projectId: string, input: StatusTemplateInput): Promise<ActionResult> {
  return run((ctx) => projectsApi.createStatusTemplate(ctx, projectId, input));
}

export async function updateStatusTemplate(templateId: string, input: StatusTemplateInput): Promise<ActionResult> {
  return run((ctx) => projectsApi.updateStatusTemplate(ctx, templateId, input));
}

export async function deleteStatusTemplate(templateId: string): Promise<ActionResult> {
  return run((ctx) => projectsApi.deleteStatusTemplate(ctx, templateId));
}
