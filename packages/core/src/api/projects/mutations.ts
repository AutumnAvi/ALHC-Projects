// Big move 1: the projects area's writes (projects, their sections, status, access requests, status
// templates). Every function takes the caller's ApiContext first, validates its own input, writes only
// through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no Next.js here.
import { isAccessGrantRole, type AccessGrantRole } from "../../access-requests";
import { DEFAULT_SECTIONS, ORDER_STEP } from "../core/constants";
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { ApiError, NEEDS_DATABASE_UPDATE, invalid, schemaMissing } from "../core/errors";
import { id, optionalDate, optionalText, projectVisibility, text } from "../core/validate";
import type { StatusTemplateInput } from "./model";
import { getWorkspace } from "../workspace/queries";
import { isProjectStatus } from "../../portfolios";
import { STATUS_TITLE_MAX } from "../../project-page";
import { statusTemplateProblem } from "../../status-templates";
import type { Json, TablesUpdate } from "../../supabase/database.types";

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

// A blank project with the default sections. Answers the new project's id.
export async function createProject(
  ctx: ApiContext,
  input: { name: unknown; team: unknown; visibility: unknown },
  // AI builder round 5: the AI makes projects in the Testing data pilot workspace (null = the workspace).
  opts: { workspaceId?: string | null } = {},
): Promise<string> {
  const name = text(input.name, "Project name", { max: 200 });
  const teamValue = input.team;
  const teamId = teamValue ? id(teamValue, "team") : null;
  const visibility = projectVisibility(input.visibility ?? "private");
  const supabase = ctx.db;
  const workspace = opts.workspaceId ? { id: id(opts.workspaceId, "workspace") } : await getWorkspace(ctx);
  if (!workspace) throw new ApiError("failed", "No workspace is available");

  const { data: last } = await supabase
    .from("projects")
    .select("sort_order")
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const inserted = await supabase
    .from("projects")
    .insert({
      workspace_id: workspace.id,
      name,
      sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
      // No team: the database puts the project in the workspace's default team.
      ...(teamId ? { team_id: teamId } : {}),
      visibility,
    })
    .select("id")
    .single();
  check(inserted);
  const projectId = inserted.data!.id;

  check(
    await supabase.from("sections").insert(
      DEFAULT_SECTIONS.map((sectionName, index) => ({
        project_id: projectId,
        name: sectionName,
        sort_order: (index + 1) * ORDER_STEP,
      })),
    ),
  );
  return projectId;
}

// Team and privacy (Admin+ through RLS; the database checks the team: active, and one you're in or the
// default team).
export async function updateProjectTeam(
  ctx: ApiContext,
  projectId: string,
  patch: { teamId?: string; visibility?: string },
): Promise<void> {
  const update: TablesUpdate<"projects"> = {};
  if (patch.teamId !== undefined) update.team_id = id(patch.teamId, "team");
  if (patch.visibility !== undefined) update.visibility = projectVisibility(patch.visibility);
  const supabase = ctx.db;
  checkUpdated(await supabase.from("projects").update(update).eq("id", id(projectId)).select("id"));
}

export async function joinProject(ctx: ApiContext, projectId: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("join_project", { target_project: id(projectId) }));
}

export async function updateProject(
  ctx: ApiContext,
  projectId: string,
  patch: { name?: string; description?: string | null; dueOn?: string | null },
): Promise<void> {
  const update: { name?: string; description?: string | null; due_on?: string | null } = {};
  if (patch.name !== undefined) update.name = text(patch.name, "Project name", { max: 200 });
  if (patch.description !== undefined) update.description = optionalText(patch.description);
  if (patch.dueOn !== undefined) update.due_on = optionalDate(patch.dueOn, "due date");
  const supabase = ctx.db;
  const result = await supabase.from("projects").update(update).eq("id", id(projectId)).select("id");
  // A preview deployed before 20261011020000_asana_parity_2.sql has no projects.due_on yet.
  if (result.error?.code === "PGRST204" && update.due_on !== undefined) {
    throw invalid("Project due dates need this release’s database update, which isn’t applied yet");
  }
  // Admin+ (projects_update_admin): RLS turns anything below into zero rows.
  checkUpdated(result, "Only project admins and owners can change the project’s details");
}

export async function deleteProject(ctx: ApiContext, projectId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("projects").update({ deleted_at: nowIso() }).eq("id", id(projectId)).select("id"),
    "Only the project’s Owners can delete it",
  );
}

// Archive / unarchive a project (Admin+ by your own role). Archived projects are read-only for everyone
// and leave the sidebar, Home, and pickers; members still open them. (Oct 26 notes, batch 4: every page
// that lists projects changes, so the caller drops its cached copies of them too.)
export async function setProjectArchived(ctx: ApiContext, projectId: string, archived: boolean): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("set_project_archived", { target_project: id(projectId), archive: archived === true }));
}

// Project status (Editor+, through set_project_status so who/when are stamped by the database).
// With a title (the status panel), through post_project_status_update, which hands the title to the same
// set_project_status. A preview deployed before 20261011020000_asana_parity_2.sql doesn't have it yet:
// then the title goes in front of the note, so nothing typed is lost.
export async function setProjectStatus(
  ctx: ApiContext,
  projectId: string,
  status: string,
  note: string | null,
  title?: string | null,
): Promise<void> {
  if (!isProjectStatus(status)) throw invalid("Choose a status");
  const summary = optionalText(note, 2000);
  const supabase = ctx.db;
  if (title === undefined) {
    check(await supabase.rpc("set_project_status", { target_project: id(projectId), new_status: status, note: summary }));
    return;
  }
  const heading = optionalText(title, STATUS_TITLE_MAX);
  const posted = await supabase.rpc("post_project_status_update", {
    target_project: id(projectId),
    new_status: status,
    update_title: heading,
    summary,
  });
  // The title goes in front of the summary only while both fit the note's 2,000 characters.
  const combined = heading && summary && heading.length + 2 + summary.length <= 2000 ? `${heading}\n\n${summary}` : (summary ?? heading);
  const result =
    posted.error?.code === "PGRST202"
      ? await supabase.rpc("set_project_status", { target_project: id(projectId), new_status: status, note: combined })
      : posted;
  // On hold is refused by the old status check until the migration (and its tail) is applied.
  if (status === "on_hold" && /status_check|Status must be/.test(result.error?.message ?? "")) {
    throw invalid("“On hold” isn’t available until this release’s database update is fully applied. Pick another status for now.");
  }
  check(result);
}

// Oct 27 notes (batch 5): Owner settings → Lock section order. Only the project's Owners change it (the
// database checks their own role); while it's on, only Owners add, rename, reorder, or delete sections.
export async function setSectionsLocked(ctx: ApiContext, projectId: string, locked: boolean): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase
    .from("projects")
    .update({ sections_locked: Boolean(locked) })
    .eq("id", id(projectId))
    .select("id");
  if (result.error?.code === "PGRST204" || result.error?.code === "42703") {
    throw invalid("Locking sections needs this release’s database update");
  }
  checkUpdated(result, "Only the project’s owners can lock or unlock its sections");
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

// Appends a section, or (beforeSectionId: "Add section above / below" on a section's menu) inserts it at
// the midpoint before that one. Only a gap too small to split (after many inserts in one spot) needs
// place_section afterwards to reindex.
export async function createSection(
  ctx: ApiContext,
  projectId: string,
  name: string,
  beforeSectionId: string | null = null,
): Promise<{ sectionId: string | undefined }> {
  const sectionName = text(name, "Section name", { max: 200 });
  const supabase = ctx.db;
  let sortOrder: number;
  let reindex = false;
  if (beforeSectionId) {
    const { data: before } = await supabase
      .from("sections")
      .select("sort_order")
      .eq("id", id(beforeSectionId, "section"))
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .maybeSingle();
    if (!before) throw invalid("That section was deleted. Refresh and try again.");
    const { data: previous } = await supabase
      .from("sections")
      .select("sort_order")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .lt("sort_order", before.sort_order)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    sortOrder = previous ? (previous.sort_order + before.sort_order) / 2 : before.sort_order - ORDER_STEP;
    reindex = previous !== null && before.sort_order - previous.sort_order < 1e-6;
  } else {
    const { data: last } = await supabase
      .from("sections")
      .select("sort_order")
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    sortOrder = (last?.sort_order ?? 0) + ORDER_STEP;
  }
  const inserted = await supabase
    .from("sections")
    .insert({ project_id: projectId, name: sectionName, sort_order: sortOrder })
    .select("id")
    .single();
  check(inserted);
  if (reindex && beforeSectionId && inserted.data) {
    check(await supabase.rpc("place_section", { target_section: inserted.data.id, before_section: beforeSectionId }));
  }
  // AI builder round 3: the assistant's Undo removes exactly the section it made.
  return { sectionId: inserted.data?.id };
}

export async function renameSection(ctx: ApiContext, sectionId: string, name: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("sections")
      .update({ name: text(name, "Section name", { max: 200 }) })
      .eq("id", id(sectionId))
      .select("id"),
  );
}

// Only an empty section is deleted (Asana): every active task in it counts, completed ones included, so
// tasks added since the page loaded aren't silently moved to "No section".
export async function deleteSection(ctx: ApiContext, sectionId: string): Promise<void> {
  const supabase = ctx.db;
  const { count, error } = await supabase
    .from("task_projects")
    .select("task_id, task:tasks!inner(deleted_at)", { count: "exact", head: true })
    .eq("section_id", id(sectionId, "section"))
    .is("deleted_at", null)
    .is("task.deleted_at", null);
  check({ error });
  if (count) {
    throw invalid(
      `This section still has ${count === 1 ? "1 task" : `${count} tasks`}. Move ${count === 1 ? "it" : "them"} to another section first.`,
    );
  }
  checkUpdated(await supabase.from("sections").update({ deleted_at: nowIso() }).eq("id", sectionId).select("id"));
}

// ---------------------------------------------------------------------------------------------
// Access requests
// ---------------------------------------------------------------------------------------------

// Oct 26 notes (batch 3): the not-a-member page's "Request to be added to this project" and the owners'
// Approve / Decline (Inbox, Share). The database decides who may do either.
export async function requestProjectAccess(ctx: ApiContext, projectId: string): Promise<{ status: string | undefined }> {
  const supabase = ctx.db;
  const { data, error } = await supabase.rpc("request_project_access", { target_project: id(projectId, "project") });
  if (error?.code === "PGRST202") throw invalid("Asking for access needs this release’s database update");
  if (error?.code === "P0002") throw invalid("This project doesn’t exist any more");
  check({ error });
  return { status: typeof data === "string" ? data : undefined };
}

export async function decideAccessRequest(
  ctx: ApiContext,
  requestId: string,
  decision: "approve" | "decline",
  role: AccessGrantRole = "default",
): Promise<{ status: string | undefined }> {
  if (decision !== "approve" && decision !== "decline") throw invalid("Approve or decline the request");
  if (!isAccessGrantRole(role)) throw invalid("Choose a role");
  const supabase = ctx.db;
  const { data, error } = await supabase.rpc("decide_project_access_request", {
    target_request: id(requestId, "request"),
    decision,
    member_role: role,
  });
  if (error?.code === "P0002") throw invalid("This request isn’t there any more, or you can’t decide it");
  check({ error });
  return { status: typeof data === "string" ? data : undefined };
}

// ---------------------------------------------------------------------------------------------
// Status templates (Real features 4)
// ---------------------------------------------------------------------------------------------

function statusTemplateRow(input: StatusTemplateInput) {
  const sections = (Array.isArray(input.sections) ? input.sections : []).map((s) => ({
    heading: typeof s?.heading === "string" ? s.heading.trim() : "",
    body: typeof s?.body === "string" ? s.body.replace(/\s+$/, "") : "",
  }));
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : null;
  const problem = statusTemplateProblem({ name, title, sections });
  if (problem) throw invalid(problem);
  if (input.status !== null && !isProjectStatus(input.status)) throw invalid("Choose a status");
  return { name, status: input.status, title, sections: sections as unknown as Json };
}

// Customize → Status templates (Editors and above, by RLS).
export async function createStatusTemplate(ctx: ApiContext, projectId: string, input: StatusTemplateInput): Promise<void> {
  const row = statusTemplateRow(input);
  const supabase = ctx.db;
  const project = id(projectId, "project");
  const { data: last } = await supabase
    .from("project_status_templates")
    .select("sort_order")
    .eq("project_id", project)
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const result = await supabase
    .from("project_status_templates")
    .insert({ project_id: project, ...row, sort_order: (last?.sort_order ?? 0) + ORDER_STEP });
  if (schemaMissing(result.error?.code)) throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  check(result, "Only project editors and above can add status templates");
}

export async function updateStatusTemplate(ctx: ApiContext, templateId: string, input: StatusTemplateInput): Promise<void> {
  const row = statusTemplateRow(input);
  const supabase = ctx.db;
  const result = await supabase
    .from("project_status_templates")
    .update(row)
    .eq("id", id(templateId, "status template"))
    .is("deleted_at", null)
    .select("id");
  if (schemaMissing(result.error?.code)) throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  checkUpdated(result, "Only project editors and above can change status templates");
}

export async function deleteStatusTemplate(ctx: ApiContext, templateId: string): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase
    .from("project_status_templates")
    .update({ deleted_at: nowIso() })
    .eq("id", id(templateId, "status template"))
    .is("deleted_at", null)
    .select("id");
  if (schemaMissing(result.error?.code)) throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  checkUpdated(result, "Only project editors and above can remove status templates");
}
