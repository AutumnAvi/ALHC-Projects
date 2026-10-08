"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getWorkspace, listMyTeamIds, listProjectTemplates, listTeams } from "@/lib/data";
import { MAX_ATTACHMENT_BYTES } from "@/lib/attachments";
import { drainOutbox } from "@/lib/email";
import { drainIntegrationOutbox, generateSigningSecret } from "@/lib/integrations";
import { ImportParseError, buildImportPlan, importSteps, planExternalIds, type ImportPlan } from "@/lib/asana-import";
import {
  IMPORTS_BUCKET,
  MAX_IMPORT_FILES,
  MAX_IMPORT_FILE_BYTES,
  addTotals,
  importFileKind,
  importFileName,
  type ImportPerson,
  type ImportPreview,
  type ImportProgress,
  type ImportTotals,
} from "@/lib/imports-shared";
import {
  MAX_SECRET_LENGTH,
  SLACK_FORMATS,
  WEBHOOK_URL_ERROR,
  isAllowedHeaderName,
  isAllowedWebhookUrl,
  isIntegrationSetting,
  toProjectIntegrations,
  type ProjectIntegrations,
} from "@/lib/integrations-shared";
import { isFieldType, isOptionColor, type FieldOption } from "@/lib/fields";
import {
  isChoice,
  isQuestionType,
  parseQuestions,
  validateSubmission,
  type FormAnswers,
  type FormQuestion,
} from "@/lib/forms";
import { isTriggerType, type RuleAction, type RuleCondition } from "@/lib/rules";
import { isUuid } from "@/lib/ids";
import { isReactionKey } from "@/lib/reactions";
import {
  MAX_SHIFT_MOVES,
  isDependencyKind,
  isLagDays,
  parseShiftResult,
  parseUndoResult,
  type DependencyKind,
  type ShiftChange,
  type ShiftMove,
  type ShiftPlanRow,
  type ShiftResult,
  type UndoResult,
} from "@/lib/dependencies";
import { MAX_TAG_NAME } from "@/lib/tags";
import { parseColumnWidths, type ColumnWidths } from "@/lib/column-widths";
import {
  isDuplicateTaskOptionKey,
  parseDuplicateTaskResult,
  type DuplicateTaskOptions,
  type DuplicateTaskResult,
} from "@/lib/duplicate-task";
import { MAX_BULK_TASKS, parseBulkResult, type BulkOperation, type BulkResult } from "@/lib/bulk";
import { isFrequency, recurrenceJson, type Recurrence } from "@/lib/recurrence";
import { isPortfolioRole, isProjectRole } from "@/lib/roles";
import {
  EMAIL_PATTERN,
  LOGO_MAX_BYTES,
  isProjectVisibility,
  parseInviteResult,
  senderNameProblem,
  splitEmails,
  type InviteResult,
  type ProjectVisibility,
} from "@/lib/workspace";
import { isGoalStatus, isProgressMode } from "@/lib/goals";
import { isTeamProjectRole, isTeamRole, parseTeamInviteResult, type TeamInviteResult } from "@/lib/teams";
import { MAX_PORTFOLIO_FIELD_TEXT, isPortfolioFieldType, isProjectStatus } from "@/lib/portfolios";
import { MAX_TEMPLATE_SUBTASKS, parseCopyResult, type DuplicateOptions } from "@/lib/templates";
import {
  VIEW_LAYOUTS,
  isIsoDate,
  isViewLayout,
  isWidgetKind,
  parseFilters,
  parseViewConfig,
  toJson,
  type ViewConfig,
  type ViewFilters,
  type WidgetKind,
} from "@/lib/views";
import type { Json, TablesInsert, TablesUpdate } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { TASK_KINDS, type TaskKind } from "@/lib/task-kinds";
import {
  DEFAULT_WIDGET_TITLES,
  isPersonalWidgetKind,
  isSeriesInterval,
  reportFiltersJson,
  type ReportFilters,
} from "@/lib/reports";

export type ActionResult = { error?: string };

const ORDER_STEP = 1024;
const DEFAULT_SECTIONS = ["To do", "In progress", "Done"];
const START_AFTER_DUE = "The start date must be on or before the due date";

class InputError extends Error {}
class DbError extends Error {}

function id(value: unknown, label = "id"): string {
  if (!isUuid(value)) throw new InputError(`Invalid ${label}`);
  return value;
}

function text(value: unknown, label: string, { max = 500 } = {}): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new InputError(`${label} can’t be empty`);
  if (trimmed.length > max) throw new InputError(`${label} is too long`);
  return trimmed;
}

function optionalText(value: unknown, max = 20000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > max) throw new InputError("Text is too long");
  return trimmed || null;
}

// Any write can make rules queue email, Slack messages, or webhooks, so deliver the outboxes once the
// response is sent (a small integration batch keeps rule fires snappy between cron runs).
function deliverQueuedEmail() {
  after(async () => {
    try {
      await drainOutbox();
    } catch (error) {
      console.error("Email delivery failed", error);
    }
    try {
      await drainIntegrationOutbox({ max: 10 });
    } catch (error) {
      console.error("Integration delivery failed", error);
    }
  });
}

async function run(fn: () => Promise<void>): Promise<ActionResult> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof InputError) return { error: error.message };
    if (error instanceof DbError) return { error: error.message };
    throw error;
  }
  deliverQueuedEmail();
  refresh();
  return {};
}

const NOT_ALLOWED = "Your role in this project doesn’t allow that";

type DbResult = { error: { message: string; code?: string; hint?: string | null } | null };

// Row-level security errors name tables; members just need to know their role doesn't allow it.
function check(result: DbResult, notAllowed = NOT_ALLOWED) {
  const error = result.error;
  if (!error) return;
  if (error.code === "42501" && error.message.includes("row-level security")) throw new DbError(notAllowed);
  throw new DbError(error.hint ? `${error.message}. ${error.hint}` : error.message);
}

// RLS turns a forbidden UPDATE into "0 rows" rather than an error; use with .select("id").
function checkUpdated(result: DbResult & { data: unknown[] | null }, notAllowed = NOT_ALLOWED) {
  check(result, notAllowed);
  if (!result.data?.length) throw new DbError(notAllowed);
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export async function createProject(formData: FormData): Promise<ActionResult> {
  let projectId: string | null = null;
  const result = await run(async () => {
    const name = text(formData.get("name"), "Project name", { max: 200 });
    const teamValue = formData.get("team");
    const teamId = teamValue ? id(teamValue, "team") : null;
    const visibility = projectVisibility(formData.get("visibility") ?? "private");
    const supabase = await createClient();
    const workspace = await getWorkspace();
    if (!workspace) throw new DbError("No workspace is available");

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
    projectId = inserted.data!.id;

    check(
      await supabase.from("sections").insert(
        DEFAULT_SECTIONS.map((sectionName, index) => ({
          project_id: projectId!,
          name: sectionName,
          sort_order: (index + 1) * ORDER_STEP,
        })),
      ),
    );
  });
  if (projectId && !result.error) {
    redirect(formData.get("then") === "import" ? `/projects/${projectId}/settings/import` : `/projects/${projectId}/list`);
  }
  return result;
}

function projectVisibility(value: unknown): ProjectVisibility {
  if (!isProjectVisibility(value)) throw new InputError("Choose who can find the project");
  return value;
}

// Team and privacy (Admin+ through RLS; the database checks the team: active, and one you're in or the
// default team).
export async function updateProjectTeam(
  projectId: string,
  patch: { teamId?: string; visibility?: string },
): Promise<ActionResult> {
  return run(async () => {
    const update: TablesUpdate<"projects"> = {};
    if (patch.teamId !== undefined) update.team_id = id(patch.teamId, "team");
    if (patch.visibility !== undefined) update.visibility = projectVisibility(patch.visibility);
    const supabase = await createClient();
    checkUpdated(await supabase.from("projects").update(update).eq("id", id(projectId)).select("id"));
  });
}

// After a template or a duplicate is created: put it in the chosen team (best effort — the project
// already exists in the default team if this is refused).
async function placeNewProject(projectId: string, teamId: string | null, visibility: ProjectVisibility | null) {
  if (!teamId && !visibility) return;
  const supabase = await createClient();
  await supabase
    .from("projects")
    .update({ ...(teamId ? { team_id: teamId } : {}), ...(visibility ? { visibility } : {}) })
    .eq("id", projectId);
}

export async function joinProject(projectId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("join_project", { target_project: id(projectId) }));
  });
}

export async function updateProject(
  projectId: string,
  patch: { name?: string; description?: string | null },
): Promise<ActionResult> {
  return run(async () => {
    const update: { name?: string; description?: string | null } = {};
    if (patch.name !== undefined) update.name = text(patch.name, "Project name", { max: 200 });
    if (patch.description !== undefined) update.description = optionalText(patch.description);
    const supabase = await createClient();
    check(await supabase.from("projects").update(update).eq("id", id(projectId)));
  });
}

export async function deleteProject(projectId: string): Promise<ActionResult> {
  const result = await run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("projects").update({ deleted_at: now() }).eq("id", id(projectId)),
    );
  });
  if (!result.error) redirect("/");
  return result;
}

// ---------------------------------------------------------------------------------------------
// Templates and Duplicate project (one copy engine in SQL: see 20261006020000_templates.sql).
// Copies fire no rules or notifications, and every copied rule lands disabled.
// ---------------------------------------------------------------------------------------------

function optionalIsoDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isIsoDate(value)) throw new InputError(`Choose a valid ${label}`);
  return value;
}

export async function saveProjectAsTemplate(
  projectId: string,
  input: { name: string; description: string | null; startOn: string | null; replaceTemplateId: string | null },
): Promise<ActionResult & { templateId?: string }> {
  let templateId: string | undefined;
  const result = await run(async () => {
    const supabase = await createClient();
    const saved = await supabase.rpc("save_project_as_template", {
      source_project: id(projectId),
      template_name: text(input.name, "Template name", { max: 100 }),
      template_description: optionalText(input.description, 2000),
      anchor_on: optionalIsoDate(input.startOn, "start date"),
      replace_template: input.replaceTemplateId ? id(input.replaceTemplateId, "template") : null,
    });
    check(saved);
    templateId = saved.data ?? undefined;
  });
  return { ...result, templateId };
}

export async function createProjectFromTemplate(
  templateId: string,
  input: { name: string; startOn: string | null; teamId?: string | null; visibility?: string | null },
): Promise<ActionResult> {
  let projectId: string | null = null;
  const result = await run(async () => {
    const teamId = input.teamId ? id(input.teamId, "team") : null;
    const visibility = input.visibility ? projectVisibility(input.visibility) : null;
    const supabase = await createClient();
    const created = await supabase.rpc("create_project_from_template", {
      target_template: id(templateId, "template"),
      project_name: text(input.name, "Project name", { max: 200 }),
      start_on: optionalIsoDate(input.startOn, "start date"),
    });
    check(created);
    projectId = parseCopyResult(created.data)?.projectId ?? null;
    if (!projectId) throw new DbError("The project could not be created");
    await placeNewProject(projectId, teamId, visibility);
  });
  if (projectId && !result.error) redirect(`/projects/${projectId}`);
  return result;
}

export async function duplicateProject(
  projectId: string,
  input: { name: string; options: DuplicateOptions },
): Promise<ActionResult> {
  let newProjectId: string | null = null;
  const result = await run(async () => {
    const o = input.options;
    const supabase = await createClient();
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
    newProjectId = parseCopyResult(created.data)?.projectId ?? null;
    if (!newProjectId) throw new DbError("The project could not be duplicated");
    // A duplicate stays in the source's team and keeps its privacy.
    const { data: source } = await supabase.from("projects").select("team_id, visibility").eq("id", projectId).maybeSingle();
    if (source) await placeNewProject(newProjectId, source.team_id, isProjectVisibility(source.visibility) ? source.visibility : null);
  });
  if (newProjectId && !result.error) redirect(`/projects/${newProjectId}`);
  return result;
}

export async function updateProjectTemplate(
  templateId: string,
  input: { name: string; description: string | null },
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("update_project_template", {
        target_template: id(templateId, "template"),
        template_name: text(input.name, "Template name", { max: 100 }),
        template_description: optionalText(input.description, 2000),
      }),
    );
  });
}

export async function deleteProjectTemplate(templateId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("delete_project_template", { target_template: id(templateId, "template") }));
  });
}

export async function saveTaskAsTemplate(
  taskId: string,
  projectId: string,
  input: { name: string; includeAssignee: boolean },
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("save_task_as_template", {
        target_task: id(taskId, "task"),
        target_project: id(projectId),
        template_name: text(input.name, "Template name", { max: 100 }),
        include_assignee: Boolean(input.includeAssignee),
      }),
    );
  });
}

// From quick-add: a normal task creation (stories, notifications, and task_created rules as usual).
export async function createTaskFromTemplate(
  templateId: string,
  sectionId: string | null,
  title: string | null,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("create_task_from_template", {
        target_template: id(templateId, "template"),
        target_section: sectionId ? id(sectionId, "section") : null,
        task_title: optionalText(title, 1000),
      }),
    );
  });
}

export async function createTaskTemplate(
  projectId: string,
  input: { name: string; title: string },
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
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
  });
}

export async function updateTaskTemplate(
  templateId: string,
  patch: { name?: string; title?: string; notes?: string | null; subtasks?: string[]; clearAssignee?: boolean },
): Promise<ActionResult> {
  return run(async () => {
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
      if (titles.length > MAX_TEMPLATE_SUBTASKS) throw new InputError(`Up to ${MAX_TEMPLATE_SUBTASKS} subtasks`);
      if (titles.some((t) => t.length > 1000)) throw new InputError("A subtask title is too long");
      update.subtasks = titles;
    }
    if (patch.clearAssignee) update.assignee_id = null;
    const supabase = await createClient();
    checkUpdated(await supabase.from("task_templates").update(update).eq("id", id(templateId, "template")).select("id"));
  });
}

export async function deleteTaskTemplate(templateId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase
        .from("task_templates")
        .update({ deleted_at: now() })
        .eq("id", id(templateId, "template"))
        .select("id"),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Members (all checks — role, allowlist, last owner — live in the SQL RPCs)
// ---------------------------------------------------------------------------------------------

function role(value: unknown): string {
  if (!isProjectRole(value)) throw new InputError("Choose a role");
  return value;
}

// pending: they haven't signed in yet — the membership waits for their first sign-in.
export type InviteActionResult = ActionResult & { pending?: boolean };

export async function inviteProjectMember(
  projectId: string,
  email: string,
  memberRole: string,
): Promise<InviteActionResult> {
  let pending = false;
  const result = await run(async () => {
    const address = text(email, "Email", { max: 320 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new InputError("Enter a valid email address");
    const supabase = await createClient();
    const added = await supabase.rpc("add_project_member", {
      target_project: id(projectId),
      member_email: address,
      member_role: role(memberRole),
    });
    check(added);
    pending = added.data === null;
  });
  return { ...result, pending };
}

// Cancels a pending invite (project / portfolio Admin+, team leads and workspace admins; RLS decides).
export async function cancelPendingInvite(inviteId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("pending_memberships").update({ deleted_at: now() }).eq("id", id(inviteId, "invite")).select("id"),
      "Only the people who manage this can cancel the invite",
    );
  });
}

// The bulk bar's "Add <name> to this project and assign?": the same add_project_member path as an
// invite (Admin+ of the project, the person allowlisted and signed in), looked up by profile.
export async function addProjectMemberByProfile(
  projectId: string,
  profileId: string,
  memberRole = "editor",
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const { data: profile } = await supabase.from("profiles").select("email").eq("id", id(profileId, "person")).maybeSingle();
    if (!profile?.email) throw new InputError("That person isn’t in this workspace");
    // Already a member (e.g. added since the page loaded): keep their role; add_project_member would reset it.
    const { data: existing } = await supabase
      .from("project_members")
      .select("id")
      .eq("project_id", id(projectId))
      .eq("profile_id", profileId)
      .is("deleted_at", null)
      .maybeSingle();
    if (existing) return;
    check(
      await supabase.rpc("add_project_member", {
        target_project: id(projectId),
        member_email: profile.email,
        member_role: role(memberRole),
      }),
    );
  });
}

export async function changeProjectMemberRole(
  projectId: string,
  profileId: string,
  memberRole: string,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("update_project_member_role", {
        target_project: id(projectId),
        target_profile: id(profileId, "person"),
        new_role: role(memberRole),
      }),
    );
  });
}

export async function removeProjectMember(projectId: string, profileId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("remove_project_member", {
        target_project: id(projectId),
        target_profile: id(profileId, "person"),
      }),
    );
  });
}

// Leaving loses access, so send the person home instead of re-rendering a project they can't see.
export async function leaveProject(projectId: string, profileId: string): Promise<ActionResult> {
  const result = await removeProjectMember(projectId, profileId);
  if (!result.error) redirect("/");
  return result;
}

export async function transferProjectOwnership(projectId: string, profileId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("transfer_project_ownership", {
        target_project: id(projectId),
        target_profile: id(profileId, "person"),
      }),
    );
  });
}

// Project status (Editor+, through set_project_status so who/when are stamped by the database).
// Archive / unarchive a project (Admin+ by your own role). Archived projects are read-only for everyone
// and leave the sidebar, Home, and pickers; members still open them.
export async function setProjectArchived(projectId: string, archived: boolean): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("set_project_archived", { target_project: id(projectId), archive: archived === true }));
  });
}

export async function setProjectStatus(
  projectId: string,
  status: string,
  note: string | null,
): Promise<ActionResult> {
  return run(async () => {
    if (!isProjectStatus(status)) throw new InputError("Choose a status");
    const supabase = await createClient();
    check(
      await supabase.rpc("set_project_status", {
        target_project: id(projectId),
        new_status: status,
        note: optionalText(note, 2000),
      }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Portfolios (membership and project rules live in the SQL RPCs; see 20261005070000_portfolios.sql)
// ---------------------------------------------------------------------------------------------

// The sidebar's New project → "Use a template" step: every workspace template (read with RLS).
// Teams a new project can go in: the viewer's teams plus the default team (open to everyone), default
// first. Read with the viewer's client.
export async function listProjectTeamChoices(): Promise<{ id: string; name: string; isDefault: boolean }[]> {
  const [workspace, teams, mine] = await Promise.all([getWorkspace(), listTeams(), listMyTeamIds()]);
  const defaultId = workspace?.defaultTeamId ?? null;
  return teams
    .filter((t) => t.id === defaultId || mine.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, isDefault: t.id === defaultId }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

export async function listProjectTemplateChoices() {
  const templates = await listProjectTemplates();
  return templates.map(({ id, name, description, summary }) => ({ id, name, description, summary }));
}

export async function createPortfolio(formData: FormData): Promise<ActionResult> {
  let portfolioId: string | null = null;
  const result = await run(async () => {
    const name = text(formData.get("name"), "Portfolio name", { max: 100 });
    const supabase = await createClient();
    const workspace = await getWorkspace();
    if (!workspace) throw new DbError("No workspace is available");
    const inserted = await supabase
      .from("portfolios")
      .insert({ workspace_id: workspace.id, name })
      .select("id")
      .single();
    check(inserted);
    portfolioId = inserted.data!.id;
  });
  if (portfolioId && !result.error) redirect(`/portfolios/${portfolioId}`);
  return result;
}

export async function updatePortfolio(
  portfolioId: string,
  patch: { name?: string; notes?: string | null },
): Promise<ActionResult> {
  return run(async () => {
    const update: { name?: string; notes?: string | null } = {};
    if (patch.name !== undefined) update.name = text(patch.name, "Portfolio name", { max: 100 });
    if (patch.notes !== undefined) update.notes = optionalText(patch.notes);
    const supabase = await createClient();
    checkUpdated(await supabase.from("portfolios").update(update).eq("id", id(portfolioId)).select("id"));
  });
}

export async function deletePortfolio(portfolioId: string): Promise<ActionResult> {
  const result = await run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("portfolios").update({ deleted_at: now() }).eq("id", id(portfolioId)).select("id"),
    );
  });
  if (!result.error) redirect("/portfolios");
  return result;
}

export async function addPortfolioProject(portfolioId: string, projectId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("add_portfolio_project", {
        target_portfolio: id(portfolioId),
        target_project: id(projectId, "project"),
      }),
    );
  });
}

export async function removePortfolioProject(portfolioId: string, projectId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("remove_portfolio_project", {
        target_portfolio: id(portfolioId),
        target_project: id(projectId, "project"),
      }),
    );
  });
}

// Moves a project one place among the projects the viewer can see. Uses a midpoint position so
// projects hidden from the viewer keep theirs.
export async function movePortfolioProject(
  portfolioId: string,
  projectId: string,
  direction: -1 | 1,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("portfolio_projects")
      .select("project_id, sort_order")
      .eq("portfolio_id", id(portfolioId))
      .is("deleted_at", null)
      .order("sort_order")
      .order("created_at");
    const list = data ?? [];
    const index = list.findIndex((row) => row.project_id === projectId);
    if (index === -1) throw new InputError("That project is not in this portfolio");
    let position: number;
    if (direction < 0) {
      if (index === 0) return;
      const after = list[index - 1].sort_order;
      const before = index >= 2 ? list[index - 2].sort_order : after - ORDER_STEP;
      position = (before + after) / 2;
    } else {
      if (index === list.length - 1) return;
      const before = list[index + 1].sort_order;
      const after = index + 2 < list.length ? list[index + 2].sort_order : before + ORDER_STEP;
      position = (before + after) / 2;
    }
    check(
      await supabase.rpc("move_portfolio_project", {
        target_portfolio: portfolioId,
        target_project: id(projectId, "project"),
        new_sort_order: position,
      }),
    );
  });
}

function portfolioRole(value: unknown): string {
  if (!isPortfolioRole(value)) throw new InputError("Choose a role");
  return value;
}

export async function invitePortfolioMember(
  portfolioId: string,
  email: string,
  memberRole: string,
): Promise<InviteActionResult> {
  let pending = false;
  const result = await run(async () => {
    const address = text(email, "Email", { max: 320 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new InputError("Enter a valid email address");
    const supabase = await createClient();
    const added = await supabase.rpc("add_portfolio_member", {
      target_portfolio: id(portfolioId),
      member_email: address,
      member_role: portfolioRole(memberRole),
    });
    check(added);
    pending = added.data === null;
  });
  return { ...result, pending };
}

export async function changePortfolioMemberRole(
  portfolioId: string,
  profileId: string,
  memberRole: string,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("update_portfolio_member_role", {
        target_portfolio: id(portfolioId),
        target_profile: id(profileId, "person"),
        new_role: portfolioRole(memberRole),
      }),
    );
  });
}

export async function removePortfolioMember(portfolioId: string, profileId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("remove_portfolio_member", {
        target_portfolio: id(portfolioId),
        target_profile: id(profileId, "person"),
      }),
    );
  });
}

// Leaving loses access, so send the person to the portfolio list instead.
export async function leavePortfolio(portfolioId: string, profileId: string): Promise<ActionResult> {
  const result = await removePortfolioMember(portfolioId, profileId);
  if (!result.error) redirect("/portfolios");
  return result;
}

export async function transferPortfolioOwnership(portfolioId: string, profileId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("transfer_portfolio_ownership", {
        target_portfolio: id(portfolioId),
        target_profile: id(profileId, "person"),
      }),
    );
  });
}

// Nested portfolios (Editor+ on the parent, Viewer+ on the child; cycles rejected in SQL).
export async function addPortfolioChild(portfolioId: string, childId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("add_portfolio_child", {
        target_portfolio: id(portfolioId),
        child_portfolio: id(childId, "portfolio"),
      }),
    );
  });
}

export async function removePortfolioChild(portfolioId: string, childId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("remove_portfolio_child", {
        target_portfolio: id(portfolioId),
        child_portfolio: id(childId, "portfolio"),
      }),
    );
  });
}

// Portfolio custom fields (Editor+). Options are only for single-select fields.
function portfolioFieldOptions(value: unknown): FieldOption[] {
  if (!Array.isArray(value)) throw new InputError("Invalid options");
  if (value.length > 100) throw new InputError("Too many options");
  const seen = new Set<string>();
  return value.map((option) => {
    const o = option as Partial<FieldOption> | null;
    const optionId = typeof o?.id === "string" ? o.id.trim() : "";
    if (!optionId || optionId.length > 64 || seen.has(optionId)) throw new InputError("Invalid option");
    seen.add(optionId);
    return { id: optionId, name: text(o?.name, "Option name", { max: 100 }), color: isOptionColor(o?.color) ? o.color : "zinc" };
  });
}

export async function createPortfolioField(
  portfolioId: string,
  input: { name: string; fieldType: string; options?: FieldOption[] },
): Promise<ActionResult> {
  return run(async () => {
    if (!isPortfolioFieldType(input.fieldType)) throw new InputError("Choose a field type");
    const options = input.fieldType === "single_select" ? portfolioFieldOptions(input.options ?? []) : [];
    const supabase = await createClient();
    const { data: last } = await supabase
      .from("portfolio_fields")
      .select("sort_order")
      .eq("portfolio_id", id(portfolioId))
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1);
    check(
      await supabase.from("portfolio_fields").insert({
        portfolio_id: portfolioId,
        name: text(input.name, "Field name", { max: 100 }),
        field_type: input.fieldType,
        options,
        sort_order: (last?.[0]?.sort_order ?? 0) + ORDER_STEP,
      }),
      "Only portfolio editors and above can add fields",
    );
  });
}

export async function updatePortfolioField(
  fieldId: string,
  patch: { name?: string; options?: FieldOption[] },
): Promise<ActionResult> {
  return run(async () => {
    const update: TablesUpdate<"portfolio_fields"> = {};
    if (patch.name !== undefined) update.name = text(patch.name, "Field name", { max: 100 });
    if (patch.options !== undefined) update.options = portfolioFieldOptions(patch.options);
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("portfolio_fields").update(update).eq("id", id(fieldId, "field")).select("id"),
      "Only portfolio editors and above can change fields",
    );
  });
}

export async function deletePortfolioField(fieldId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase
        .from("portfolio_fields")
        .update({ deleted_at: now() })
        .eq("id", id(fieldId, "field"))
        .select("id"),
      "Only portfolio editors and above can delete fields",
    );
  });
}

// Sets one project's value (null clears). The database checks the type, options, and roles.
export async function setPortfolioFieldValue(
  fieldId: string,
  projectId: string,
  value: string | number | null,
): Promise<ActionResult> {
  return run(async () => {
    let json: Json = null;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new InputError("Enter a number");
      json = value;
    } else if (typeof value === "string" && value.trim()) {
      if (value.length > MAX_PORTFOLIO_FIELD_TEXT) throw new InputError("Text is too long");
      json = value.trim();
    }
    const supabase = await createClient();
    check(
      await supabase.rpc("set_portfolio_field_value", {
        target_field: id(fieldId, "field"),
        target_project: id(projectId, "project"),
        new_value: json,
      }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

export async function createSection(projectId: string, name: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const { data: last } = await supabase
      .from("sections")
      .select("sort_order")
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    check(
      await supabase.from("sections").insert({
        project_id: projectId,
        name: text(name, "Section name", { max: 200 }),
        sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
      }),
    );
  });
}

export async function renameSection(sectionId: string, name: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("sections")
        .update({ name: text(name, "Section name", { max: 200 }) })
        .eq("id", id(sectionId)),
    );
  });
}

export async function deleteSection(sectionId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("sections").update({ deleted_at: now() }).eq("id", id(sectionId)),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// My Tasks sections (personal; RLS limits every write to the viewer's own rows)
// ---------------------------------------------------------------------------------------------

export async function createMyTaskSection(name: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("ensure_my_task_sections"));
    const { data: last } = await supabase
      .from("my_task_sections")
      .select("sort_order")
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    check(
      await supabase.from("my_task_sections").insert({
        name: text(name, "Section name", { max: 100 }),
        sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
      }),
    );
  });
}

// Only custom sections can be renamed or deleted (the database refuses the system ones).
export async function renameMyTaskSection(sectionId: string, name: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase
        .from("my_task_sections")
        .update({ name: text(name, "Section name", { max: 100 }) })
        .eq("id", id(sectionId, "section"))
        .select("id"),
    );
  });
}

// Its tasks move to the end of Recently assigned (database trigger).
export async function deleteMyTaskSection(sectionId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase
        .from("my_task_sections")
        .update({ deleted_at: now() })
        .eq("id", id(sectionId, "section"))
        .select("id"),
    );
  });
}

export async function placeMyTaskSection(sectionId: string, beforeId: string | null): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("place_my_task_section", {
        target_section: id(sectionId, "section"),
        before_section: beforeId ? id(beforeId, "section") : null,
      }),
    );
  });
}

// Places one of the viewer's tasks in one of their sections, before `beforeId` (null = end).
export async function placeMyTask(taskId: string, sectionId: string, beforeId: string | null): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("place_my_task", {
        target_task: id(taskId, "task"),
        target_section: id(sectionId, "section"),
        before_task: beforeId ? id(beforeId, "task") : null,
      }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------------------------

// Weekly capacity of one person in a project's or a portfolio's workload; null clears it.
export async function setWorkloadCapacity(
  scope: { projectId: string } | { portfolioId: string },
  profileId: string,
  capacity: number | null,
): Promise<ActionResult> {
  return run(async () => {
    if (capacity !== null && (!Number.isFinite(capacity) || capacity <= 0 || capacity > 100000)) {
      throw new InputError("Capacity must be a number greater than 0");
    }
    const supabase = await createClient();
    check(
      await supabase.rpc("set_workload_capacity", {
        target_project: "projectId" in scope ? id(scope.projectId, "project") : null,
        target_portfolio: "portfolioId" in scope ? id(scope.portfolioId, "portfolio") : null,
        target_profile: id(profileId, "person"),
        new_capacity: capacity,
      }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

export async function createTask(
  projectId: string,
  sectionId: string | null,
  title: string,
  kind: TaskKind = "task",
  // Asana's toolbar "+ Add task": the new task goes to the top of its section.
  atTop = false,
): Promise<ActionResult> {
  return run(async () => {
    const taskKind = taskKindInput(kind);
    const supabase = await createClient();
    const created = await supabase.rpc("create_task", {
      target_project: id(projectId),
      target_section: sectionId ? id(sectionId, "section") : null,
      task_title: text(title, "Task name"),
    });
    check(created);
    if (taskKind !== "task" && created.data) {
      checkUpdated(await supabase.from("tasks").update({ kind: taskKind }).eq("id", created.data).select("id"));
    }
    if (atTop && created.data) {
      let first = supabase
        .from("task_projects")
        .select("task_id, tasks!inner(deleted_at)")
        .eq("project_id", id(projectId))
        .is("deleted_at", null)
        .is("tasks.deleted_at", null)
        .neq("task_id", created.data)
        .order("sort_order")
        .limit(1);
      first = sectionId ? first.eq("section_id", id(sectionId, "section")) : first.is("section_id", null);
      const { data: top } = await first.maybeSingle();
      if (top) {
        check(
          await supabase.rpc("place_task", {
            target_task: created.data,
            target_project: id(projectId),
            target_section: sectionId ? id(sectionId, "section") : null,
            before_task: top.task_id,
          }),
        );
      }
    }
  });
}

// Quick-add in My Tasks: a private task (no project) assigned to the caller. Only they and whoever they
// assign it to can read it until it's added to a project.
// With a section (the inline "Add task…" row of a My Tasks section), the task is placed at its end.
export async function createPrivateTask(title: string, mySectionId: string | null = null): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const created = await supabase.rpc("create_private_task", { task_title: text(title, "Task name", { max: 1000 }) });
    check(created);
    if (mySectionId && created.data) {
      check(
        await supabase.rpc("place_my_task", {
          target_task: created.data,
          target_section: id(mySectionId, "section"),
          before_task: null,
        }),
      );
    }
  });
}

// List column widths for the signed-in person in one project (set_list_column_widths, own row, Viewer+).
// No refresh: the List already shows the widths it sent.
export async function saveListColumnWidths(projectId: string, widths: ColumnWidths): Promise<ActionResult> {
  try {
    const supabase = await createClient();
    check(
      await supabase.rpc("set_list_column_widths", {
        target_project: id(projectId),
        new_widths: parseColumnWidths(widths) as Json,
      }),
    );
    return {};
  } catch (error) {
    if (error instanceof InputError || error instanceof DbError) return { error: error.message };
    throw error;
  }
}

// Duplicate a task (duplicate_task): the copy lands where the caller is an Editor (see the migration).
export async function duplicateTask(
  taskId: string,
  options: DuplicateTaskOptions,
): Promise<ActionResult & { result?: DuplicateTaskResult }> {
  let result: DuplicateTaskResult | undefined;
  const outcome = await run(async () => {
    const payload: Record<string, boolean | string> = {};
    for (const [key, value] of Object.entries(options ?? {})) {
      if (key === "title") {
        const title = optionalText(value, 1000);
        if (title) payload.title = title;
      } else if (isDuplicateTaskOptionKey(key) && typeof value === "boolean") {
        payload[key] = value;
      } else {
        throw new InputError("Unknown duplicate option");
      }
    }
    const supabase = await createClient();
    const response = await supabase.rpc("duplicate_task", { target_task: id(taskId, "task"), options: payload });
    check(response);
    result = parseDuplicateTaskResult(response.data) ?? undefined;
    if (!result) throw new DbError("The task couldn’t be duplicated");
  });
  return outcome.error ? outcome : { result };
}

// Like / unlike a task (Commenter+, own like only; the database checks both).
export async function setTaskLiked(taskId: string, liked: boolean): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const task = id(taskId, "task");
    if (liked) {
      const result = await supabase.from("task_likes").insert({ task_id: task });
      if (result.error?.code === "23505") return; // already liked
      check(result);
    } else {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new InputError("Sign in again to unlike");
      check(
        await supabase
          .from("task_likes")
          .update({ deleted_at: now() })
          .eq("task_id", task)
          .eq("profile_id", user.id)
          .is("deleted_at", null),
      );
    }
  });
}

function taskKindInput(value: unknown): TaskKind {
  if (!TASK_KINDS.includes(value as TaskKind)) throw new InputError("Choose a task type");
  return value as TaskKind;
}

// Task, milestone, or approval. The database clears a milestone's start date and opens (or cancels)
// the assignee's approval request; an assignee below Commenter is refused for approval tasks.
export async function setTaskKind(taskId: string, kind: TaskKind): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("tasks").update({ kind: taskKindInput(kind) }).eq("id", id(taskId)).select("id"),
    );
  });
}

function optionalDate(value: string | null, label: string): string | null {
  if (value && !isIsoDate(value)) throw new InputError(`Invalid ${label}`);
  return value || null;
}

// An instant (ISO 8601 with offset or Z) for due/start times.
function optionalInstant(value: string | null, label: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InputError(`Invalid ${label}`);
  }
  return new Date(value).toISOString();
}

function timeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) throw new InputError("Invalid time zone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new InputError("Invalid time zone");
  }
  return value;
}

// Dates are plain days; times are optional instants. Setting a time also sets its date (the database
// keeps due_on/start_on equal to the local date in timeZone), and moving only the date keeps the time.
export async function updateTask(
  taskId: string,
  patch: {
    title?: string;
    notes?: string | null;
    assigneeId?: string | null;
    startOn?: string | null;
    dueOn?: string | null;
    startAt?: string | null;
    dueAt?: string | null;
    timeZone?: string;
  },
): Promise<ActionResult> {
  return run(async () => {
    const update: {
      title?: string;
      notes?: string | null;
      assignee_id?: string | null;
      start_on?: string | null;
      due_on?: string | null;
      start_at?: string | null;
      due_at?: string | null;
      time_zone?: string;
    } = {};
    if (patch.title !== undefined) update.title = text(patch.title, "Task name");
    if (patch.notes !== undefined) update.notes = optionalText(patch.notes);
    if (patch.assigneeId !== undefined) {
      update.assignee_id = patch.assigneeId ? id(patch.assigneeId, "assignee") : null;
    }
    if (patch.startOn !== undefined) update.start_on = optionalDate(patch.startOn, "start date");
    if (patch.dueOn !== undefined) update.due_on = optionalDate(patch.dueOn, "due date");
    if (patch.startAt !== undefined) update.start_at = optionalInstant(patch.startAt, "start time");
    if (patch.dueAt !== undefined) update.due_at = optionalInstant(patch.dueAt, "due time");
    if (patch.timeZone !== undefined) update.time_zone = timeZone(patch.timeZone);
    if (update.start_on && update.due_on && update.start_on > update.due_on) {
      throw new InputError(START_AFTER_DUE);
    }
    if (update.start_at && update.due_at && update.start_at > update.due_at) {
      throw new InputError(START_AFTER_DUE);
    }
    const supabase = await createClient();
    const result = await supabase.from("tasks").update(update).eq("id", id(taskId)).select("id");
    if (/tasks_start_(on_before_due_on|at_before_due_at)/.test(result.error?.message ?? "")) {
      throw new InputError(START_AFTER_DUE);
    }
    checkUpdated(result);
  });
}

function recurrence(value: Recurrence | null): Json | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !isFrequency(value.freq)) throw new InputError("Invalid repeat");
  const interval = Number(value.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw new InputError("Repeat every 1 to 365 days, weeks, months, or years");
  }
  const weekdays = Array.isArray(value.weekdays)
    ? value.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [];
  const input = value.ends;
  let ends: Recurrence["ends"];
  if (!input || input.type === "never") {
    ends = { type: "never" };
  } else if (input.type === "after") {
    if (!(Number.isInteger(input.count) && input.count >= 1 && input.count <= 1000)) {
      throw new InputError("A repeat can end after 1 to 1000 occurrences");
    }
    ends = { type: "after", count: input.count };
  } else if (input.type === "until") {
    if (!isIsoDate(input.until)) throw new InputError("Choose the date the repeat ends");
    ends = { type: "until", until: input.until };
  } else {
    throw new InputError("Invalid repeat end");
  }
  return recurrenceJson({
    freq: value.freq,
    interval,
    weekdays,
    ends,
    timezone: value.timezone ? timeZone(value.timezone) : undefined,
  });
}

// Sets or clears a task's repeat rule; completing the task then creates the next occurrence.
export async function setTaskRecurrence(taskId: string, rule: Recurrence | null): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("tasks").update({ recurrence: recurrence(rule) }).eq("id", id(taskId)).select("id"),
    );
  });
}

export async function setTaskCompleted(taskId: string, completed: boolean): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase
        .from("tasks")
        .update({ completed_at: completed ? now() : null })
        .eq("id", id(taskId))
        .select("id"),
    );
  });
}

export async function deleteTask(taskId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.from("tasks").update({ deleted_at: now() }).eq("id", id(taskId)));
  });
}

export async function restoreTask(taskId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("restore_task", { target_task: id(taskId) }));
  });
}

// Adds a dependency, or changes the kind / lag of an existing one (Editor on both tasks, which may be in
// different projects or be subtasks). Finish-to-start: `successorId` can't be completed until
// `predecessorId` is, and starts on or after its due date + lag; start-to-start never blocks.
export async function setTaskDependency(
  predecessorId: string,
  successorId: string,
  kind: DependencyKind = "finish_to_start",
  lagDays = 0,
): Promise<ActionResult> {
  return run(async () => {
    if (!isDependencyKind(kind)) throw new InputError("Unknown dependency type");
    if (!isLagDays(lagDays)) throw new InputError("Lag is a whole number of days between -365 and 365");
    const supabase = await createClient();
    check(
      await supabase.rpc("set_task_dependency", {
        predecessor: id(predecessorId, "task"),
        successor: id(successorId, "task"),
        dependency_kind: kind,
        dependency_lag: lagDays,
      }),
    );
  });
}

// Read-only server calls: same error handling as run(), but no refresh (nothing changed).
async function read<T>(fn: () => Promise<T>): Promise<{ error?: string; data?: T }> {
  try {
    return { data: await fn() };
  } catch (error) {
    if (error instanceof InputError || error instanceof DbError) return { error: error.message };
    throw error;
  }
}

// What moving a task to these dates would do to the tasks that depend on it (nothing changes yet).
export async function previewDependencyShift(
  taskId: string,
  dates: { startOn: string | null; dueOn: string | null },
): Promise<{ error?: string; data?: ShiftPlanRow[] }> {
  return read(async () => {
    const startOn = optionalDate(dates.startOn, "start date");
    const dueOn = optionalDate(dates.dueOn, "due date");
    if (startOn && dueOn && startOn > dueOn) throw new InputError(START_AFTER_DUE);
    const supabase = await createClient();
    const result = await supabase.rpc("preview_dependency_shift", {
      target_task: id(taskId, "task"),
      new_start_on: startOn,
      new_due_on: dueOn,
    });
    check(result);
    return (result.data ?? []).map((r) => ({
      taskId: r.task_id,
      title: r.title,
      startOn: r.start_on,
      dueOn: r.due_on,
      newStart: r.new_start,
      newDue: r.new_due,
      shiftDays: r.shift_days,
      status: r.status === "move" ? ("move" as const) : ("skipped" as const),
      reason: r.reason,
    }));
  });
}

function shiftMovesInput(moves: ShiftMove[]) {
  if (!Array.isArray(moves) || moves.length === 0 || moves.length > MAX_SHIFT_MOVES) {
    throw new InputError(`Choose 1 to ${MAX_SHIFT_MOVES} tasks`);
  }
  return moves.map((m) => {
    const move: Record<string, string | null> = { task_id: id(m.taskId, "task") };
    if (m.startOn !== undefined) move.start_on = optionalDate(m.startOn, "start date");
    if (m.dueOn !== undefined) move.due_on = optionalDate(m.dueOn, "due date");
    if (move.start_on && move.due_on && move.start_on > move.due_on) throw new InputError(START_AFTER_DUE);
    return move;
  });
}

function toPlanRows(
  data: {
    task_id: string;
    title: string;
    start_on: string | null;
    due_on: string | null;
    new_start: string | null;
    new_due: string | null;
    shift_days: number;
    status: string;
    reason: string | null;
  }[],
): ShiftPlanRow[] {
  return data.map((r) => ({
    taskId: r.task_id,
    title: r.title,
    startOn: r.start_on,
    dueOn: r.due_on,
    newStart: r.new_start,
    newDue: r.new_due,
    shiftDays: r.shift_days,
    status: r.status === "move" ? ("move" as const) : ("skipped" as const),
    reason: r.reason,
  }));
}

// What moving several tasks at once (e.g. a bulk due date) would do to their dependents; pullEarlier
// also brings dependents earlier when their predecessors move earlier. Nothing changes yet.
export async function previewDependencyShifts(
  moves: ShiftMove[],
  pullEarlier = false,
): Promise<{ error?: string; data?: ShiftPlanRow[] }> {
  return read(async () => {
    const supabase = await createClient();
    const result = await supabase.rpc("preview_dependency_shifts", {
      moves: shiftMovesInput(moves),
      pull_earlier: pullEarlier === true,
    });
    check(result);
    return toPlanRows(result.data ?? []);
  });
}

// Moves the tasks and the confirmed dependents; tasks that can't move are reported in skipped. The
// result's changes feed undoDependencyShift.
export async function applyDependencyShifts(
  moves: ShiftMove[],
  confirmedIds: string[],
  pullEarlier = false,
): Promise<ActionResult & { result?: ShiftResult }> {
  let result: ShiftResult | undefined;
  const outcome = await run(async () => {
    if (!Array.isArray(confirmedIds) || confirmedIds.length > 500) throw new InputError("Too many tasks to move at once");
    const supabase = await createClient();
    const response = await supabase.rpc("apply_dependency_shifts", {
      moves: shiftMovesInput(moves),
      confirmed_tasks: [...new Set(confirmedIds.map((t) => id(t, "task")))],
      pull_earlier: pullEarlier === true,
    });
    if (/tasks_start_(on_before_due_on|at_before_due_at)/.test(response.error?.message ?? "")) {
      throw new InputError(START_AFTER_DUE);
    }
    check(response);
    result = parseShiftResult(response.data);
  });
  return outcome.error ? outcome : { result };
}

// Moves the task and the confirmed dependents in one call; the result's changes feed undoDependencyShift.
export async function applyDependencyShift(
  taskId: string,
  dates: { startOn: string | null; dueOn: string | null },
  confirmedIds: string[],
): Promise<ActionResult & { result?: ShiftResult }> {
  let result: ShiftResult | undefined;
  const outcome = await run(async () => {
    const startOn = optionalDate(dates.startOn, "start date");
    const dueOn = optionalDate(dates.dueOn, "due date");
    if (startOn && dueOn && startOn > dueOn) throw new InputError(START_AFTER_DUE);
    if (!Array.isArray(confirmedIds) || confirmedIds.length > 500) throw new InputError("Too many tasks to move at once");
    const supabase = await createClient();
    const response = await supabase.rpc("apply_dependency_shift", {
      target_task: id(taskId, "task"),
      new_start_on: startOn,
      new_due_on: dueOn,
      confirmed_tasks: [...new Set(confirmedIds.map((t) => id(t, "task")))],
    });
    if (/tasks_start_(on_before_due_on|at_before_due_at)/.test(response.error?.message ?? "")) {
      throw new InputError(START_AFTER_DUE);
    }
    check(response);
    result = parseShiftResult(response.data);
  });
  return outcome.error ? outcome : { result };
}

// Puts back the dates a shift changed (tasks edited since keep their new dates and are reported).
export async function undoDependencyShift(changes: ShiftChange[]): Promise<ActionResult & { result?: UndoResult }> {
  let result: UndoResult | undefined;
  const outcome = await run(async () => {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 501) throw new InputError("Nothing to undo");
    const payload = changes.map((c) => ({
      task_id: id(c.task_id, "task"),
      old_start_on: optionalDate(c.old_start_on, "start date"),
      old_due_on: optionalDate(c.old_due_on, "due date"),
      new_start_on: optionalDate(c.new_start_on, "start date"),
      new_due_on: optionalDate(c.new_due_on, "due date"),
    }));
    const supabase = await createClient();
    const response = await supabase.rpc("undo_dependency_shift", { changes: payload });
    check(response);
    result = parseUndoResult(response.data);
  });
  return outcome.error ? outcome : { result };
}

export async function removeTaskDependency(dependencyId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("remove_task_dependency", { target_dependency: id(dependencyId, "dependency") }));
  });
}

async function lastSortOrder(projectId: string, sectionId: string | null) {
  const supabase = await createClient();
  let query = supabase
    .from("task_projects")
    .select("sort_order")
    .eq("project_id", projectId)
    .is("deleted_at", null);
  query = sectionId ? query.eq("section_id", sectionId) : query.is("section_id", null);
  const { data } = await query.order("sort_order", { ascending: false }).limit(1).maybeSingle();
  return data?.sort_order ?? 0;
}

// Moves a task within one of its projects. Without sortOrder the task goes to the end of the section.
export async function moveTask(
  taskId: string,
  projectId: string,
  sectionId: string | null,
  sortOrder?: number,
): Promise<ActionResult> {
  return run(async () => {
    const targetSection = sectionId ? id(sectionId, "section") : null;
    const order =
      sortOrder !== undefined && Number.isFinite(sortOrder)
        ? sortOrder
        : (await lastSortOrder(id(projectId), targetSection)) + ORDER_STEP;
    const supabase = await createClient();
    check(
      await supabase
        .from("task_projects")
        .update({ section_id: targetSection, sort_order: order })
        .eq("task_id", id(taskId))
        .eq("project_id", id(projectId)),
    );
  });
}

// Places a task in a section of one of its projects, before `beforeId` (null = end of the section).
// The database picks the midpoint and reindexes the section when the gap gets too small.
export async function placeTask(
  taskId: string,
  projectId: string,
  sectionId: string | null,
  beforeId: string | null,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("place_task", {
        target_task: id(taskId, "task"),
        target_project: id(projectId, "project"),
        target_section: sectionId ? id(sectionId, "section") : null,
        before_task: beforeId ? id(beforeId, "task") : null,
      }),
    );
  });
}

export async function placeSection(sectionId: string, beforeId: string | null): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("place_section", {
        target_section: id(sectionId, "section"),
        before_section: beforeId ? id(beforeId, "section") : null,
      }),
    );
  });
}

function bulkOperation(input: BulkOperation): Json {
  switch (input?.action) {
    case "complete":
    case "reopen":
    case "delete":
      return { action: input.action };
    case "assign":
      return { action: "assign", assignee_id: input.assignee_id ? id(input.assignee_id, "assignee") : null };
    case "set_due":
      return { action: "set_due", due_on: optionalDate(input.due_on, "due date") };
    case "move_section":
    case "add_to_project":
      return {
        action: input.action,
        project_id: id(input.project_id, "project"),
        section_id: input.section_id ? id(input.section_id, "section") : null,
      };
    case "my_section":
      return { action: "my_section", section_id: id(input.section_id, "section") };
    case "add_tag":
    case "remove_tag":
      return { action: input.action, tag_id: id(input.tag_id, "tag") };
    case "set_field":
      if (input.value !== null && JSON.stringify(input.value).length > 20000) throw new InputError("Value is too long");
      return { action: "set_field", field_id: id(input.field_id, "field"), value: input.value ?? null };
    default:
      throw new InputError("Unknown bulk action");
  }
}

// One operation on up to 200 tasks. Tasks that can't be changed are skipped with a reason (the rest
// still go through); stories, inbox items, and rules fire per task as for single edits.
export async function bulkEditTasks(
  taskIds: string[],
  operation: BulkOperation,
): Promise<ActionResult & { result?: BulkResult }> {
  let result: BulkResult | undefined;
  const outcome = await run(async () => {
    if (!Array.isArray(taskIds) || taskIds.length === 0) throw new InputError("Select at least one task");
    const ids = [...new Set(taskIds.map((t) => id(t, "task")))];
    if (ids.length > MAX_BULK_TASKS) throw new InputError(`Select at most ${MAX_BULK_TASKS} tasks at a time`);
    const supabase = await createClient();
    const op = bulkOperation(operation);
    // My Tasks sections are personal, so they have their own RPC (same result shape).
    const response =
      operation.action === "my_section"
        ? await supabase.rpc("move_my_tasks", { target_tasks: ids, target_section: id(operation.section_id, "section") })
        : await supabase.rpc("bulk_update_tasks", { target_tasks: ids, operation: op });
    check(response);
    result = parseBulkResult(response.data);
  });
  return outcome.error ? outcome : { result };
}

export async function addTaskToProject(taskId: string, projectId: string): Promise<ActionResult> {
  return run(async () => {
    const order = (await lastSortOrder(id(projectId), null)) + ORDER_STEP;
    const supabase = await createClient();
    check(
      await supabase.from("task_projects").upsert(
        {
          task_id: id(taskId),
          project_id: projectId,
          section_id: null,
          sort_order: order,
          deleted_at: null,
        },
        { onConflict: "task_id,project_id" },
      ),
    );
  });
}

export async function removeTaskFromProject(
  taskId: string,
  projectId: string,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("task_projects")
        .update({ deleted_at: now() })
        .eq("task_id", id(taskId))
        .eq("project_id", id(projectId)),
    );
  });
}

export async function setHomeProject(taskId: string, projectId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("tasks")
        .update({ home_project_id: id(projectId) })
        .eq("id", id(taskId)),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------------------------

// Subtasks are tasks (parent_task_id). Assignee, dates, notes, and fields go through updateTask and
// friends like any task; these cover creating, renaming, completing, ordering, and deleting from a list.

export async function createSubtask(parentId: string, title: string, beforeId?: string | null): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("create_subtask", {
        parent_task: id(parentId, "task"),
        task_title: text(title, "Subtask name"),
        before_task: beforeId ? id(beforeId, "subtask") : null,
      }),
    );
  });
}

export async function updateSubtask(
  subtaskId: string,
  patch: { title?: string; completed?: boolean },
): Promise<ActionResult> {
  return run(async () => {
    const update: { title?: string; completed_at?: string | null } = {};
    if (patch.title !== undefined) update.title = text(patch.title, "Subtask name");
    if (patch.completed !== undefined) update.completed_at = patch.completed ? now() : null;
    const supabase = await createClient();
    checkUpdated(await supabase.from("tasks").update(update).eq("id", id(subtaskId)).select("id"));
  });
}

// Moves a subtask before another one under the same parent (null = to the end).
// Makes a task a subtask of another task (Editor on both; it leaves its projects) — tags, fields, comments,
// and dependencies stay with it.
export async function convertToSubtask(taskId: string, parentId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("convert_to_subtask", { target_task: id(taskId, "task"), new_parent: id(parentId, "task") }));
  });
}

// Makes a subtask a top-level task of a project the viewer edits (default: its parent's home project).
export async function convertToTask(
  taskId: string,
  projectId?: string | null,
  sectionId?: string | null,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("convert_to_task", {
        target_task: id(taskId, "task"),
        target_project: projectId ? id(projectId, "project") : null,
        target_section: sectionId ? id(sectionId, "section") : null,
      }),
    );
  });
}

export async function placeSubtask(subtaskId: string, beforeId: string | null): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("place_subtask", {
        target_task: id(subtaskId, "subtask"),
        before_task: beforeId ? id(beforeId, "subtask") : null,
      }),
    );
  });
}

export async function deleteSubtask(subtaskId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.from("tasks").update({ deleted_at: now() }).eq("id", id(subtaskId)));
  });
}

// ---------------------------------------------------------------------------------------------
// Comments + followers
// ---------------------------------------------------------------------------------------------

export async function addComment(taskId: string, body: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("comments")
        .insert({ task_id: id(taskId), body: text(body, "Comment", { max: 10000 }) }),
    );
  });
}

// Authors edit only the text; the database stamps edited_at and notifies people the edit newly mentions.
export async function editComment(commentId: string, body: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const result = await supabase
      .from("comments")
      .update({ body: text(body, "Comment", { max: 10000 }) })
      .eq("id", id(commentId))
      .is("deleted_at", null)
      .select("id");
    check(result);
    if (!result.data?.length) throw new InputError("You can only edit your own comments");
  });
}

// Adds the viewer's reaction, or removes it (soft delete) when they already reacted with that emoji.
export async function toggleReaction(commentId: string, emoji: string): Promise<ActionResult> {
  return run(async () => {
    if (!isReactionKey(emoji)) throw new InputError("Unknown reaction");
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new InputError("Sign in again to react");
    const existing = await supabase
      .from("comment_reactions")
      .select("id")
      .eq("comment_id", id(commentId))
      .eq("profile_id", user.id)
      .eq("emoji", emoji)
      .is("deleted_at", null);
    check(existing);
    if (existing.data?.length) {
      checkUpdated(
        await supabase
          .from("comment_reactions")
          .update({ deleted_at: now() })
          .in("id", existing.data.map((r) => r.id))
          .select("id"),
      );
      return;
    }
    const inserted = await supabase.from("comment_reactions").insert({ comment_id: commentId, emoji });
    // A double click can race the unique index; the reaction is there either way.
    if (inserted.error?.code === "23505") return;
    check(inserted);
  });
}

export async function deleteComment(commentId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const result = await supabase
      .from("comments")
      .update({ deleted_at: now() })
      .eq("id", id(commentId))
      .select("id");
    check(result);
    if (!result.data?.length) throw new InputError("You can only delete your own comments");
  });
}

// ---------------------------------------------------------------------------------------------
// Tags (workspace names: anyone allowlisted creates; creator or workspace admin manages. Links follow
// the task: Editors+ add and remove, through RLS.)
// ---------------------------------------------------------------------------------------------

const TAG_TAKEN = "A tag with that name already exists";

function tagError(result: DbResult) {
  if (result.error?.code === "23505") throw new InputError(TAG_TAKEN);
  check(result, "Only the tag’s creator or a workspace admin can change it");
}

export async function createTag(name: string, color: string = "zinc"): Promise<ActionResult & { tagId?: string }> {
  let tagId: string | undefined;
  const outcome = await run(async () => {
    if (!isOptionColor(color)) throw new InputError("Unknown color");
    const supabase = await createClient();
    const result = await supabase
      .from("tags")
      .insert({ name: text(name, "Tag name", { max: MAX_TAG_NAME }), color })
      .select("id")
      .single();
    tagError(result);
    tagId = result.data?.id;
  });
  return outcome.error ? outcome : { tagId };
}

export async function updateTag(
  tagId: string,
  patch: { name?: string; color?: string; archived?: boolean },
): Promise<ActionResult> {
  return run(async () => {
    const update: TablesUpdate<"tags"> = {};
    if (patch.name !== undefined) update.name = text(patch.name, "Tag name", { max: MAX_TAG_NAME });
    if (patch.color !== undefined) {
      if (!isOptionColor(patch.color)) throw new InputError("Unknown color");
      update.color = patch.color;
    }
    if (patch.archived !== undefined) update.archived_at = patch.archived ? now() : null;
    const supabase = await createClient();
    const result = await supabase.from("tags").update(update).eq("id", id(tagId, "tag")).is("deleted_at", null).select("id");
    tagError(result);
    if (!result.data?.length) throw new InputError("Only the tag’s creator or a workspace admin can change it");
  });
}

export async function addTaskTag(taskId: string, tagId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const result = await supabase.from("task_tags").insert({ task_id: id(taskId, "task"), tag_id: id(tagId, "tag") });
    // Already there (a double click, or another tab): nothing to do.
    if (result.error?.code === "23505") return;
    check(result);
  });
}

// Creates a tag (or reuses one with that name) and adds it to the task.
export async function addNewTaskTag(taskId: string, name: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const clean = text(name, "Tag name", { max: MAX_TAG_NAME });
    const existing = await supabase
      .from("tags")
      .select("id, name")
      .is("deleted_at", null)
      .ilike("name", clean.replace(/[\\%_]/g, (c) => `\\${c}`));
    check(existing);
    let tagId = existing.data?.find((t) => t.name.toLowerCase() === clean.toLowerCase())?.id;
    if (!tagId) {
      const created = await supabase.from("tags").insert({ name: clean }).select("id").single();
      tagError(created);
      tagId = created.data?.id;
    }
    if (!tagId) throw new InputError("Couldn’t create the tag");
    const result = await supabase.from("task_tags").insert({ task_id: id(taskId, "task"), tag_id: tagId });
    if (result.error?.code === "23505") return;
    check(result);
  });
}

// Board grouped by tag: dragging a card from one tag's column to another swaps the tags; to "No tag"
// removes the column's tag. Either step is skipped when there is nothing to do.
export async function moveTaskTag(taskId: string, fromTagId: string | null, toTagId: string | null): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    if (toTagId && toTagId !== fromTagId) {
      const added = await supabase.from("task_tags").insert({ task_id: id(taskId, "task"), tag_id: id(toTagId, "tag") });
      if (added.error?.code !== "23505") check(added);
    }
    if (fromTagId && fromTagId !== toTagId) {
      checkUpdated(
        await supabase
          .from("task_tags")
          .update({ deleted_at: now() })
          .eq("task_id", id(taskId, "task"))
          .eq("tag_id", id(fromTagId, "tag"))
          .is("deleted_at", null)
          .select("id"),
      );
    }
  });
}

export async function removeTaskTag(taskId: string, tagId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase
        .from("task_tags")
        .update({ deleted_at: now() })
        .eq("task_id", id(taskId, "task"))
        .eq("tag_id", id(tagId, "tag"))
        .is("deleted_at", null)
        .select("id"),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Project Messages (threads + replies; Commenters+ post, authors edit and delete their own; the
// database parses @mentions and writes inbox items)
// ---------------------------------------------------------------------------------------------

const MAX_MESSAGE = 20000;

export async function createMessageThread(projectId: string, title: string, body: string): Promise<ActionResult> {
  let threadId: string | undefined;
  const outcome = await run(async () => {
    const supabase = await createClient();
    const result = await supabase
      .from("project_messages")
      .insert({
        project_id: id(projectId, "project"),
        title: text(title, "Title", { max: 200 }),
        body: text(body, "Message", { max: MAX_MESSAGE }),
      })
      .select("id")
      .single();
    check(result, "Commenters and above can post messages in this project");
    threadId = result.data?.id;
  });
  if (outcome.error || !threadId) return outcome;
  redirect(`/projects/${projectId}/messages/${threadId}`);
}

export async function replyToThread(threadId: string, body: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const thread = await supabase
      .from("project_messages")
      .select("project_id")
      .eq("id", id(threadId, "thread"))
      .is("deleted_at", null)
      .maybeSingle();
    check(thread);
    if (!thread.data) throw new InputError("This thread was deleted");
    check(
      await supabase
        .from("project_messages")
        .insert({ project_id: thread.data.project_id, thread_id: threadId, body: text(body, "Reply", { max: MAX_MESSAGE }) }),
      "Commenters and above can reply in this project",
    );
  });
}

export async function editMessage(messageId: string, patch: { title?: string; body: string }): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const update: TablesUpdate<"project_messages"> = { body: text(patch.body, "Message", { max: MAX_MESSAGE }) };
    if (patch.title !== undefined) update.title = text(patch.title, "Title", { max: 200 });
    const result = await supabase
      .from("project_messages")
      .update(update)
      .eq("id", id(messageId, "message"))
      .is("deleted_at", null)
      .select("id");
    check(result);
    if (!result.data?.length) throw new InputError("You can only edit your own messages");
  });
}

export async function deleteMessage(messageId: string, projectId?: string): Promise<ActionResult> {
  const outcome = await run(async () => {
    const supabase = await createClient();
    const result = await supabase
      .from("project_messages")
      .update({ deleted_at: now() })
      .eq("id", id(messageId, "message"))
      .select("id");
    check(result);
    if (!result.data?.length) throw new InputError("You can only delete your own messages");
  });
  // Deleting a thread leaves its page; go back to the list.
  if (!outcome.error && projectId) redirect(`/projects/${id(projectId, "project")}/messages`);
  return outcome;
}

export async function toggleMessageReaction(messageId: string, emoji: string): Promise<ActionResult> {
  return run(async () => {
    if (!isReactionKey(emoji)) throw new InputError("Unknown reaction");
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new InputError("Sign in again to react");
    const existing = await supabase
      .from("project_message_reactions")
      .select("id")
      .eq("message_id", id(messageId, "message"))
      .eq("profile_id", user.id)
      .eq("emoji", emoji)
      .is("deleted_at", null);
    check(existing);
    if (existing.data?.length) {
      checkUpdated(
        await supabase
          .from("project_message_reactions")
          .update({ deleted_at: now() })
          .in("id", existing.data.map((r) => r.id))
          .select("id"),
      );
      return;
    }
    const inserted = await supabase.from("project_message_reactions").insert({ message_id: messageId, emoji });
    if (inserted.error?.code === "23505") return;
    check(inserted, "Commenters and above can react to messages");
  });
}

export async function setFollowing(
  taskId: string,
  profileId: string,
  following: boolean,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("task_followers").upsert(
        {
          task_id: id(taskId),
          profile_id: id(profileId, "person"),
          deleted_at: following ? null : now(),
        },
        { onConflict: "task_id,profile_id" },
      ),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------------------------

function fieldOptions(value: unknown): FieldOption[] {
  if (!Array.isArray(value) || value.length > 100) throw new InputError("Invalid options");
  const seen = new Set<string>();
  return value.map((option) => {
    const o = option as Partial<FieldOption>;
    if (typeof o.id !== "string" || !o.id || o.id.length > 64 || seen.has(o.id)) {
      throw new InputError("Invalid option id");
    }
    seen.add(o.id);
    return {
      id: o.id,
      name: text(o.name, "Option name", { max: 100 }),
      color: isOptionColor(o.color) ? o.color : "zinc",
    };
  });
}

export async function createField(
  projectId: string,
  input: { name: string; fieldType: string; boundToSections?: boolean },
): Promise<ActionResult> {
  return run(async () => {
    if (!isFieldType(input.fieldType)) throw new InputError("Unknown field type");
    const bound = Boolean(input.boundToSections);
    if (bound && input.fieldType !== "single_select") {
      throw new InputError("Only single-select fields can mirror sections");
    }
    const supabase = await createClient();
    const { data: last } = await supabase
      .from("custom_fields")
      .select("sort_order")
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const result = await supabase.from("custom_fields").insert({
      project_id: projectId,
      name: text(input.name, "Field name", { max: 100 }),
      field_type: input.fieldType,
      bound_to_sections: bound,
      show_in_views: bound,
      sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
    });
    if (result.error?.code === "23505") {
      throw new InputError("This project already has a section-bound field");
    }
    check(result);
  });
}

export async function updateField(
  fieldId: string,
  patch: { name?: string; options?: FieldOption[]; showInViews?: boolean },
): Promise<ActionResult> {
  return run(async () => {
    const update: { name?: string; options?: Json; show_in_views?: boolean } = {};
    if (patch.name !== undefined) update.name = text(patch.name, "Field name", { max: 100 });
    if (patch.options !== undefined) update.options = fieldOptions(patch.options);
    if (patch.showInViews !== undefined) update.show_in_views = Boolean(patch.showInViews);
    const supabase = await createClient();
    check(await supabase.from("custom_fields").update(update).eq("id", id(fieldId)));
  });
}

export async function deleteField(fieldId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("custom_fields").update({ deleted_at: now() }).eq("id", id(fieldId)),
    );
  });
}

export async function setFieldValue(
  taskId: string,
  fieldId: string,
  value: Json,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("task_field_values").upsert(
        { task_id: id(taskId), field_id: id(fieldId, "field"), value },
        { onConflict: "task_id,field_id" },
      ),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Attachments (bytes are uploaded from the browser straight to Storage; this records metadata)
// ---------------------------------------------------------------------------------------------

export async function registerAttachment(input: {
  taskId: string;
  storagePath: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
}): Promise<ActionResult> {
  return run(async () => {
    const taskId = id(input.taskId);
    if (!input.storagePath.startsWith(`${taskId}/`) || input.storagePath.includes("..")) {
      throw new InputError("Invalid attachment path");
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new InputError("Invalid file size");
    }
    if (input.sizeBytes > MAX_ATTACHMENT_BYTES) throw new InputError("Files are limited to 25 MB");
    const supabase = await createClient();
    check(
      await supabase.from("task_attachments").insert({
        task_id: taskId,
        storage_path: input.storagePath,
        file_name: text(input.fileName, "File name", { max: 255 }),
        content_type: input.contentType?.slice(0, 255) || null,
        size_bytes: input.sizeBytes,
      }),
    );
  });
}

export async function deleteAttachment(attachmentId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("task_attachments")
        .update({ deleted_at: now() })
        .eq("id", id(attachmentId)),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------

export async function markInboxRead(itemIds: string[] | "all"): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    let query = supabase.from("inbox_items").update({ read_at: now() }).is("read_at", null);
    if (itemIds !== "all") query = query.in("id", itemIds.map((itemId) => id(itemId)));
    check(await query);
  });
}

export async function markInboxUnread(itemId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.from("inbox_items").update({ read_at: null }).eq("id", id(itemId)));
  });
}

// Archive (or unarchive) items, or every unarchived item. RLS limits all of it to the viewer's own rows.
export async function archiveInboxItems(itemIds: string[] | "all", archived = true): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    let query = supabase.from("inbox_items").update({ archived_at: archived ? now() : null });
    query = archived ? query.is("archived_at", null) : query.not("archived_at", "is", null);
    if (itemIds !== "all") query = query.in("id", itemIds.map((itemId) => id(itemId)));
    check(await query);
  });
}

// ---------------------------------------------------------------------------------------------
// Workspace admins (Settings → Workspace). Admins add and remove admins; the last one stays.
// ---------------------------------------------------------------------------------------------

export async function addWorkspaceAdmin(email: string): Promise<ActionResult> {
  return run(async () => {
    const address = text(email, "Email", { max: 320 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new InputError("Enter a valid email address");
    const workspace = await getWorkspace();
    if (!workspace) throw new InputError("No workspace found");
    const supabase = await createClient();
    check(await supabase.rpc("add_workspace_admin", { target_workspace: workspace.id, member_email: address }));
  });
}

export async function removeWorkspaceAdmin(profileId: string): Promise<ActionResult> {
  return run(async () => {
    const workspace = await getWorkspace();
    if (!workspace) throw new InputError("No workspace found");
    const supabase = await createClient();
    check(
      await supabase.rpc("remove_workspace_admin", { target_workspace: workspace.id, target_profile: id(profileId) }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Workspace members and settings (Asana feel, batch 2). Workspace admins only; the database checks.
// The invite email goes through the email outbox (drained after the response, like every email).
// ---------------------------------------------------------------------------------------------

const WORKSPACE_ADMINS_ONLY = "Only workspace admins can change this";

export async function inviteToWorkspace(
  emails: string,
): Promise<ActionResult & { results?: InviteResult[] }> {
  const results: InviteResult[] = [];
  const outcome = await run(async () => {
    const addresses = splitEmails(emails);
    if (addresses.length === 0) throw new InputError("Enter at least one email address");
    if (addresses.length > 50) throw new InputError("Invite at most 50 people at a time");
    const bad = addresses.find((a) => a.length > 320 || !EMAIL_PATTERN.test(a));
    if (bad) throw new InputError(`“${bad}” isn’t a valid email address`);
    const supabase = await createClient();
    for (const address of addresses) {
      const invited = await supabase.rpc("invite_to_workspace", { member_email: address });
      check(invited, WORKSPACE_ADMINS_ONLY);
      const parsed = parseInviteResult(invited.data);
      if (parsed) results.push(parsed);
    }
  });
  return { ...outcome, results };
}

export async function resendWorkspaceInvite(address: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("resend_workspace_invite", { member_email: email(address) }), WORKSPACE_ADMINS_ONLY);
  });
}

export async function removeWorkspaceMember(address: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("remove_workspace_member", { member_email: email(address) }), WORKSPACE_ADMINS_ONLY);
  });
}

export async function updateWorkspaceSettings(patch: {
  name?: string;
  emailSenderName?: string | null;
  defaultTeamId?: string;
}): Promise<ActionResult> {
  return run(async () => {
    const workspace = await getWorkspace();
    if (!workspace) throw new InputError("No workspace found");
    const update: TablesUpdate<"workspaces"> = {};
    if (patch.name !== undefined) update.name = text(patch.name, "Workspace name", { max: 100 });
    if (patch.emailSenderName !== undefined) {
      const sender = optionalText(patch.emailSenderName, 200);
      const problem = sender ? senderNameProblem(sender) : null;
      if (problem) throw new InputError(problem);
      update.email_sender_name = sender;
    }
    if (patch.defaultTeamId !== undefined) update.default_team_id = id(patch.defaultTeamId, "team");
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("workspaces").update(update).eq("id", workspace.id).select("id"),
      WORKSPACE_ADMINS_ONLY,
    );
  });
}

// The browser uploads the logo to the workspace-assets bucket (admins only, by Storage policy), then
// records its path here; null removes the logo.
export async function setWorkspaceLogo(path: string | null, size?: number): Promise<ActionResult> {
  return run(async () => {
    const workspace = await getWorkspace();
    if (!workspace) throw new InputError("No workspace found");
    if (path !== null) {
      if (typeof path !== "string" || !path.startsWith(`${workspace.id}/`) || path.length > 300) {
        throw new InputError("Upload the logo again");
      }
      if (size !== undefined && size > LOGO_MAX_BYTES) throw new InputError("The logo must be 2 MB or smaller");
    }
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("workspaces").update({ logo_path: path }).eq("id", workspace.id).select("id"),
      WORKSPACE_ADMINS_ONLY,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Teams directory (see 20261006050000_goals_teams.sql). Leads and workspace admins manage a team; a
// team never grants project access — the group invite adds ordinary project members (Project Admin+).
// ---------------------------------------------------------------------------------------------

const TEAM_NOT_ALLOWED = "Only the team’s leads and workspace admins can change it";

function email(value: unknown): string {
  const address = text(value, "Email", { max: 320 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new InputError("Enter a valid email address");
  return address;
}

function teamRole(value: unknown): string {
  if (!isTeamRole(value)) throw new InputError("Choose lead or member");
  return value;
}

export async function createTeam(formData: FormData): Promise<ActionResult> {
  let teamId: string | null = null;
  const result = await run(async () => {
    const name = text(formData.get("name"), "Team name", { max: 100 });
    const workspace = await getWorkspace();
    if (!workspace) throw new DbError("No workspace is available");
    const supabase = await createClient();
    const inserted = await supabase
      .from("teams")
      .insert({ workspace_id: workspace.id, name, description: optionalText(formData.get("description"), 2000) })
      .select("id")
      .single();
    check(inserted, TEAM_NOT_ALLOWED);
    teamId = inserted.data!.id;
  });
  if (teamId && !result.error) redirect(`/teams/${teamId}`);
  return result;
}

export async function updateTeam(
  teamId: string,
  patch: { name?: string; description?: string | null },
): Promise<ActionResult> {
  return run(async () => {
    const update: { name?: string; description?: string | null } = {};
    if (patch.name !== undefined) update.name = text(patch.name, "Team name", { max: 100 });
    if (patch.description !== undefined) update.description = optionalText(patch.description, 2000);
    const supabase = await createClient();
    checkUpdated(await supabase.from("teams").update(update).eq("id", id(teamId)).select("id"), TEAM_NOT_ALLOWED);
  });
}

export async function deleteTeam(teamId: string): Promise<ActionResult> {
  const result = await run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("teams").update({ deleted_at: now() }).eq("id", id(teamId)).select("id"),
      TEAM_NOT_ALLOWED,
    );
  });
  if (!result.error) redirect("/teams");
  return result;
}

export async function addTeamMember(teamId: string, address: string, memberRole: string): Promise<InviteActionResult> {
  let pending = false;
  const result = await run(async () => {
    const supabase = await createClient();
    const added = await supabase.rpc("add_team_member", {
      target_team: id(teamId),
      member_email: email(address),
      member_role: teamRole(memberRole),
    });
    check(added, TEAM_NOT_ALLOWED);
    pending = added.data === null;
  });
  return { ...result, pending };
}

export async function changeTeamMemberRole(teamId: string, profileId: string, memberRole: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("update_team_member_role", {
        target_team: id(teamId),
        target_profile: id(profileId, "person"),
        new_role: teamRole(memberRole),
      }),
      TEAM_NOT_ALLOWED,
    );
  });
}

// Removes someone (leads and workspace admins), or the caller themselves (leave).
export async function removeTeamMember(teamId: string, profileId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("remove_team_member", { target_team: id(teamId), target_profile: id(profileId, "person") }),
      TEAM_NOT_ALLOWED,
    );
  });
}

// Group invite: every team member who isn't in the project yet joins it with one role, as ordinary
// project members. People already in the project keep their role; anyone who can't be added is
// skipped with a reason.
export async function addTeamToProject(
  projectId: string,
  teamId: string,
  memberRole: string,
): Promise<ActionResult & { result?: TeamInviteResult }> {
  let result: TeamInviteResult | undefined;
  const outcome = await run(async () => {
    if (!isTeamProjectRole(memberRole)) throw new InputError("Choose admin, editor, commenter, or viewer");
    const supabase = await createClient();
    const response = await supabase.rpc("add_team_to_project", {
      target_project: id(projectId),
      target_team: id(teamId, "team"),
      member_role: memberRole,
    });
    check(response);
    result = parseTeamInviteResult(response.data);
  });
  return outcome.error ? outcome : { result };
}

// ---------------------------------------------------------------------------------------------
// Goals. Anyone allowlisted reads them; the owner, a lead of the goal's team, or a workspace admin
// edits (goal_editable() in RLS). Linking needs Viewer+ on the project or portfolio.
// ---------------------------------------------------------------------------------------------

const GOAL_NOT_ALLOWED = "Only the goal’s owner, a lead of its team, or a workspace admin can change it";

function optionalId(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return id(value, label);
}

function goalPeriod(start: unknown, end: unknown) {
  const periodStart = optionalIsoDate(start, "Start date");
  const periodEnd = optionalIsoDate(end, "End date");
  if (periodStart && periodEnd && periodStart > periodEnd) throw new InputError("The period must start before it ends");
  return { period_start: periodStart, period_end: periodEnd };
}

export type GoalInput = {
  title: string;
  parentId?: string | null;
  teamId?: string | null;
  ownerId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  progressMode?: string;
};

export async function createGoal(
  input: GoalInput,
  { open = false }: { open?: boolean } = {},
): Promise<ActionResult> {
  let goalId: string | null = null;
  const result = await run(async () => {
    const workspace = await getWorkspace();
    if (!workspace) throw new DbError("No workspace is available");
    const mode = input.progressMode ?? "manual";
    if (!isProgressMode(mode)) throw new InputError("Choose how progress is measured");
    const supabase = await createClient();
    const owner = optionalId(input.ownerId, "owner");
    const inserted = await supabase
      .from("goals")
      .insert({
        workspace_id: workspace.id,
        title: text(input.title, "Goal title", { max: 200 }),
        parent_id: optionalId(input.parentId, "parent goal"),
        team_id: optionalId(input.teamId, "team"),
        ...(owner ? { owner_id: owner } : {}),
        ...goalPeriod(input.periodStart, input.periodEnd),
        progress_mode: mode,
      })
      .select("id")
      .single();
    check(inserted, "You can only create goals you own, goals for a team you lead, or any goal as a workspace admin");
    goalId = inserted.data!.id;
  });
  if (open && goalId && !result.error) redirect(`/goals/${goalId}`);
  return result;
}

export async function updateGoal(
  goalId: string,
  patch: {
    title?: string;
    notes?: string | null;
    parentId?: string | null;
    teamId?: string | null;
    ownerId?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    progressMode?: string;
    manualProgress?: number;
  },
): Promise<ActionResult> {
  return run(async () => {
    const update: TablesUpdate<"goals"> = {};
    if (patch.title !== undefined) update.title = text(patch.title, "Goal title", { max: 200 });
    if (patch.notes !== undefined) update.notes = optionalText(patch.notes, 10000);
    if (patch.parentId !== undefined) update.parent_id = optionalId(patch.parentId, "parent goal");
    if (patch.teamId !== undefined) update.team_id = optionalId(patch.teamId, "team");
    if (patch.ownerId !== undefined) update.owner_id = optionalId(patch.ownerId, "owner");
    if (patch.periodStart !== undefined || patch.periodEnd !== undefined) {
      const period = goalPeriod(patch.periodStart, patch.periodEnd);
      if (patch.periodStart !== undefined) update.period_start = period.period_start;
      if (patch.periodEnd !== undefined) update.period_end = period.period_end;
    }
    if (patch.progressMode !== undefined) {
      if (!isProgressMode(patch.progressMode)) throw new InputError("Choose how progress is measured");
      update.progress_mode = patch.progressMode;
    }
    if (patch.manualProgress !== undefined) {
      const value = Math.round(Number(patch.manualProgress));
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new InputError("Progress is a number from 0 to 100");
      update.manual_progress = value;
    }
    const supabase = await createClient();
    checkUpdated(await supabase.from("goals").update(update).eq("id", id(goalId)).select("id"), GOAL_NOT_ALLOWED);
  });
}

export async function deleteGoal(goalId: string): Promise<ActionResult> {
  const result = await run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("goals").update({ deleted_at: now() }).eq("id", id(goalId)).select("id"),
      GOAL_NOT_ALLOWED,
    );
  });
  if (!result.error) redirect("/goals");
  return result;
}

export async function linkGoal(
  goalId: string,
  target: { projectId: string } | { portfolioId: string },
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const row: TablesInsert<"goal_links"> =
      "projectId" in target
        ? { goal_id: id(goalId), project_id: id(target.projectId, "project") }
        : { goal_id: id(goalId), portfolio_id: id(target.portfolioId, "portfolio") };
    const result = await supabase.from("goal_links").insert(row);
    if (result.error?.code === "23505") throw new InputError("That’s already linked to this goal");
    check(result, "You can link only goals you can edit, and only projects or portfolios you can open");
  });
}

export async function unlinkGoal(linkId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("goal_links").update({ deleted_at: now() }).eq("id", id(linkId)).select("id"),
      GOAL_NOT_ALLOWED,
    );
  });
}

// Posting an update also sets the goal's status (trigger).
export async function postGoalStatusUpdate(goalId: string, status: string, body: string | null): Promise<ActionResult> {
  return run(async () => {
    if (!isGoalStatus(status)) throw new InputError("Choose a status");
    const supabase = await createClient();
    check(
      await supabase.from("goal_status_updates").insert({ goal_id: id(goalId), status, body: optionalText(body, 5000) }),
      GOAL_NOT_ALLOWED,
    );
  });
}

export async function deleteGoalStatusUpdate(updateId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("goal_status_updates").update({ deleted_at: now() }).eq("id", id(updateId)).select("id"),
      "Only the author can delete a status update",
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Request numbers + project workflow settings
// ---------------------------------------------------------------------------------------------

export async function saveRequestNumbering(
  projectId: string,
  input: {
    enabled: boolean;
    prefix: string;
    padWidth: number;
    addToTitle: boolean;
    assignTo: "all_tasks" | "form_submissions";
    nextNumber?: number | null;
  },
): Promise<ActionResult> {
  return run(async () => {
    const prefix = input.prefix.trim();
    if (prefix.length > 20) throw new InputError("Prefix is limited to 20 characters");
    if (!Number.isInteger(input.padWidth) || input.padWidth < 0 || input.padWidth > 8) {
      throw new InputError("Padding must be between 0 and 8 digits");
    }
    if (input.assignTo !== "all_tasks" && input.assignTo !== "form_submissions") {
      throw new InputError("Unknown numbering scope");
    }
    const row: {
      project_id: string;
      enabled: boolean;
      prefix: string;
      pad_width: number;
      add_to_title: boolean;
      assign_to: string;
      deleted_at: null;
      last_number?: number;
    } = {
      project_id: id(projectId),
      enabled: Boolean(input.enabled),
      prefix,
      pad_width: input.padWidth,
      add_to_title: Boolean(input.addToTitle),
      assign_to: input.assignTo,
      deleted_at: null,
    };
    if (input.nextNumber !== undefined && input.nextNumber !== null) {
      if (!Number.isInteger(input.nextNumber) || input.nextNumber < 1) {
        throw new InputError("The next number must be a positive whole number");
      }
      row.last_number = input.nextNumber - 1;
    }
    const supabase = await createClient();
    check(await supabase.from("request_sequences").upsert(row, { onConflict: "project_id" }));
  });
}

export async function updateProjectWorkflow(
  projectId: string,
  patch: { approvalCompletesTask: boolean },
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase
        .from("projects")
        .update({ approval_completes_task: Boolean(patch.approvalCompletesTask) })
        .eq("id", id(projectId)),
    );
  });
}

// Admin+ (set_project_integration). An empty value clears the setting. Values are never echoed back.
export async function setProjectIntegration(
  projectId: string,
  setting: string,
  value: string,
): Promise<ActionResult & { settings?: ProjectIntegrations }> {
  let settings: ProjectIntegrations | undefined;
  const result = await run(async () => {
    if (!isIntegrationSetting(setting)) throw new InputError("Unknown integration setting");
    const trimmed = typeof value === "string" ? value.trim() : "";
    if ((setting === "slack_webhook_url" || setting === "webhook_url") && trimmed && !isAllowedWebhookUrl(trimmed)) {
      throw new InputError(WEBHOOK_URL_ERROR);
    }
    if (setting === "webhook_secret" && trimmed.length > MAX_SECRET_LENGTH) {
      throw new InputError("The shared secret is limited to 500 characters");
    }
    if (setting === "webhook_secret_header" && trimmed && !isAllowedHeaderName(trimmed)) {
      throw new InputError("Header names use letters, digits, and dashes (and can’t be a standard transport header)");
    }
    const supabase = await createClient();
    const response = await supabase.rpc("set_project_integration", {
      target_project: id(projectId),
      setting,
      new_value: trimmed || null,
    });
    check(response);
    settings = toProjectIntegrations(response.data);
  });
  return result.error ? result : { settings };
}

// Admin+: a new project signing secret for Call webhook requests to the project URL. Generated here and
// returned once so the admin can copy it into the receiver; the database never hands it back.
export async function generateProjectSigningSecret(
  projectId: string,
): Promise<ActionResult & { secret?: string; settings?: ProjectIntegrations }> {
  let secret: string | undefined;
  let settings: ProjectIntegrations | undefined;
  const result = await run(async () => {
    const supabase = await createClient();
    const generated = generateSigningSecret();
    const response = await supabase.rpc("set_project_integration", {
      target_project: id(projectId),
      setting: "signing_secret",
      new_value: generated,
    });
    check(response);
    settings = toProjectIntegrations(response.data);
    secret = generated;
  });
  return result.error ? result : { secret, settings };
}

export async function clearProjectSigningSecret(
  projectId: string,
): Promise<ActionResult & { settings?: ProjectIntegrations }> {
  let settings: ProjectIntegrations | undefined;
  const result = await run(async () => {
    const supabase = await createClient();
    const response = await supabase.rpc("set_project_integration", {
      target_project: id(projectId),
      setting: "signing_secret",
      new_value: null,
    });
    check(response);
    settings = toProjectIntegrations(response.data);
  });
  return result.error ? result : { settings };
}

// Delivery log (Admin+ of the delivery's project; the RPCs check). A retry is sent right after the
// response, reusing the stored payload; cancel stops a delivery that is still waiting.
// ---------------------------------------------------------------------------------------------
// Inbound webhooks (Settings → Inbound, Admin+). Tokens and signing secrets are generated by the
// database and returned once by these actions; nothing can read them afterwards.
// ---------------------------------------------------------------------------------------------

type InboundEndpointInput = {
  name: string;
  sectionId: string | null;
  assigneeId: string | null;
  tagIds: string[];
};

function inboundEndpointInput(input: InboundEndpointInput) {
  if (!Array.isArray(input.tagIds) || input.tagIds.length > 20) throw new InputError("Choose up to 20 tags");
  return {
    name: text(input.name, "Endpoint name", { max: 100 }),
    section_id: input.sectionId ? id(input.sectionId, "section") : null,
    assignee_id: input.assigneeId ? id(input.assigneeId, "assignee") : null,
    tag_ids: input.tagIds.map((t) => id(t, "tag")),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function createInboundEndpoint(
  projectId: string,
  input: InboundEndpointInput & { signed: boolean },
): Promise<ActionResult & { endpointId?: string; token?: string; signingSecret?: string }> {
  let out: { endpointId?: string; token?: string; signingSecret?: string } = {};
  const result = await run(async () => {
    const values = inboundEndpointInput(input);
    const supabase = await createClient();
    const response = await supabase.rpc("create_inbound_endpoint", {
      target_project: id(projectId),
      endpoint_name: values.name,
      target_section: values.section_id,
      default_assignee: values.assignee_id,
      default_tags: values.tag_ids,
      with_signing_secret: Boolean(input.signed),
    });
    check(response);
    const data = jsonRecord(response.data);
    out = {
      endpointId: typeof data.id === "string" ? data.id : undefined,
      token: typeof data.token === "string" ? data.token : undefined,
      signingSecret: typeof data.signing_secret === "string" ? data.signing_secret : undefined,
    };
  });
  return result.error ? result : out;
}

export async function updateInboundEndpoint(
  endpointId: string,
  input: Partial<InboundEndpointInput> & { enabled?: boolean },
): Promise<ActionResult> {
  return run(async () => {
    const patch: TablesUpdate<"inbound_endpoints"> = {};
    if (input.name !== undefined) patch.name = text(input.name, "Endpoint name", { max: 100 });
    if (input.sectionId !== undefined) patch.section_id = input.sectionId ? id(input.sectionId, "section") : null;
    if (input.assigneeId !== undefined) patch.assignee_id = input.assigneeId ? id(input.assigneeId, "assignee") : null;
    if (input.tagIds !== undefined) {
      if (!Array.isArray(input.tagIds) || input.tagIds.length > 20) throw new InputError("Choose up to 20 tags");
      patch.tag_ids = input.tagIds.map((t) => id(t, "tag"));
    }
    if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("inbound_endpoints").update(patch).eq("id", id(endpointId)).is("deleted_at", null).select("id"),
    );
  });
}

export async function deleteInboundEndpoint(endpointId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase
        .from("inbound_endpoints")
        .update({ deleted_at: now() })
        .eq("id", id(endpointId))
        .is("deleted_at", null)
        .select("id"),
    );
  });
}

export async function rotateInboundToken(endpointId: string): Promise<ActionResult & { token?: string }> {
  let token: string | undefined;
  const result = await run(async () => {
    const supabase = await createClient();
    const response = await supabase.rpc("rotate_inbound_token", { target_endpoint: id(endpointId) });
    check(response);
    const value = jsonRecord(response.data).token;
    token = typeof value === "string" ? value : undefined;
  });
  return result.error ? result : { token };
}

export async function setInboundSigningSecret(
  endpointId: string,
  enable: boolean,
): Promise<ActionResult & { signingSecret?: string }> {
  let signingSecret: string | undefined;
  const result = await run(async () => {
    const supabase = await createClient();
    const response = await supabase.rpc("set_inbound_signing_secret", { target_endpoint: id(endpointId), enable });
    check(response);
    const value = jsonRecord(response.data).signing_secret;
    signingSecret = typeof value === "string" ? value : undefined;
  });
  return result.error ? result : { signingSecret };
}

export async function retryIntegrationDelivery(deliveryId: string): Promise<ActionResult> {
  const result = await run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("retry_integration_delivery", { target_delivery: id(deliveryId) }));
  });
  if (!result.error) {
    after(async () => {
      try {
        await drainIntegrationOutbox({ onlyId: deliveryId, max: 1 });
      } catch (error) {
        console.error("Integration delivery failed", error);
      }
    });
  }
  return result;
}

// Send a waiting email now, or give a failed one one more attempt (Admin+; the RPC re-checks). run()
// drains the email outbox right after the response.
export async function retryEmailDelivery(emailId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("retry_email_delivery", { target_email: id(emailId) }));
  });
}

// "Email me about comments" (Settings → Profile). Own row only (profiles_update_own).
export async function setEmailComments(enabled: boolean): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new InputError("Sign in again to change this");
    checkUpdated(
      await supabase.from("profiles").update({ email_comments: enabled === true }).eq("id", user.id).select("id"),
      "Couldn’t save your notification setting",
    );
  });
}

export async function cancelIntegrationDelivery(deliveryId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("cancel_integration_delivery", { target_delivery: id(deliveryId) }));
  });
}

export async function assignRequestNumber(taskId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("assign_request_number", { target_task: id(taskId) }));
  });
}

// ---------------------------------------------------------------------------------------------
// Approvals (state changes go through RPCs; triggers write stories, inbox items, and fire rules)
// ---------------------------------------------------------------------------------------------

export async function requestApproval(
  taskId: string,
  input: { approverId: string; note?: string; asSubtask?: boolean; title?: string },
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("request_approval", {
        target_task: id(taskId),
        approver: id(input.approverId, "approver"),
        approval_note: optionalText(input.note, 2000),
        as_subtask: input.asSubtask ?? true,
        subtask_title: optionalText(input.title, 500),
      }),
    );
  });
}

export async function decideApproval(
  approvalId: string,
  decision: "approved" | "changes_requested" | "rejected",
  note?: string,
): Promise<ActionResult> {
  return run(async () => {
    if (!["approved", "changes_requested", "rejected"].includes(decision)) {
      throw new InputError("Unknown decision");
    }
    const supabase = await createClient();
    check(
      await supabase.rpc("decide_approval", {
        target_approval: id(approvalId),
        decision,
        decision_note: optionalText(note, 2000),
      }),
    );
  });
}

export async function cancelApproval(approvalId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.rpc("cancel_approval", { target_approval: id(approvalId) }));
  });
}

export async function resubmitApproval(approvalId: string, note?: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("resubmit_approval", {
        target_approval: id(approvalId),
        approval_note: optionalText(note, 2000),
      }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------

function cleanQuestions(value: unknown): FormQuestion[] {
  if (!Array.isArray(value) || value.length > 100) throw new InputError("Forms are limited to 100 questions");
  const parsed = parseQuestions(value as Json);
  if (parsed.length !== value.length) throw new InputError("A question is missing its label or type");
  const seen = new Set<string>();
  return parsed.map((q) => {
    if (!q.id || q.id.length > 64 || seen.has(q.id)) throw new InputError("Question ids must be unique");
    const parentIsEarlier = q.show_if ? seen.has(q.show_if.question_id) : true;
    seen.add(q.id);
    if (!isQuestionType(q.type)) throw new InputError("Unknown question type");
    const question: FormQuestion = { ...q, label: text(q.label, "Question", { max: 500 }) };
    if (q.help !== undefined) question.help = optionalText(q.help, 1000) ?? undefined;
    if (!question.help) delete question.help;
    if (isChoice(q.type)) {
      const options = (q.options ?? []).map((o) => ({ id: o.id, label: text(o.label, "Option", { max: 200 }) }));
      if (options.length === 0) throw new InputError(`Add at least one option to “${question.label}”`);
      question.options = options;
    } else {
      delete question.options;
    }
    if (!parentIsEarlier || question.show_if?.option_ids.length === 0) delete question.show_if;
    return question;
  });
}

export async function createForm(projectId: string, title: string): Promise<ActionResult> {
  let formId: string | null = null;
  const result = await run(async () => {
    const supabase = await createClient();
    const sections = await supabase
      .from("sections")
      .select("id")
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .order("sort_order")
      .limit(1);
    const inserted = await supabase
      .from("forms")
      .insert({
        project_id: projectId,
        title: text(title, "Form name", { max: 200 }),
        destination_section_id: sections.data?.[0]?.id ?? null,
        questions: [
          {
            id: crypto.randomUUID(),
            type: "short_text",
            label: "What do you need?",
            required: true,
            maps_to: { target: "title" },
          },
          {
            id: crypto.randomUUID(),
            type: "long_text",
            label: "Details",
            maps_to: { target: "notes" },
          },
        ],
      })
      .select("id")
      .single();
    check(inserted);
    formId = inserted.data!.id;
  });
  if (formId && !result.error) redirect(`/projects/${projectId}/forms/${formId}`);
  return result;
}

export async function updateForm(
  formId: string,
  patch: {
    title?: string;
    description?: string | null;
    questions?: FormQuestion[];
    destinationSectionId?: string | null;
    acceptingResponses?: boolean;
    sendConfirmation?: boolean;
    confirmationMessage?: string | null;
  },
): Promise<ActionResult> {
  return run(async () => {
    const update: {
      title?: string;
      description?: string | null;
      questions?: Json;
      destination_section_id?: string | null;
      accepting_responses?: boolean;
      send_confirmation?: boolean;
      confirmation_message?: string | null;
    } = {};
    if (patch.title !== undefined) update.title = text(patch.title, "Form name", { max: 200 });
    if (patch.description !== undefined) update.description = optionalText(patch.description, 5000);
    if (patch.questions !== undefined) update.questions = cleanQuestions(patch.questions) as Json;
    if (patch.destinationSectionId !== undefined) {
      update.destination_section_id = patch.destinationSectionId ? id(patch.destinationSectionId, "section") : null;
    }
    if (patch.acceptingResponses !== undefined) update.accepting_responses = Boolean(patch.acceptingResponses);
    if (patch.sendConfirmation !== undefined) update.send_confirmation = Boolean(patch.sendConfirmation);
    if (patch.confirmationMessage !== undefined) {
      update.confirmation_message = optionalText(patch.confirmationMessage, 2000);
    }
    const supabase = await createClient();
    check(await supabase.from("forms").update(update).eq("id", id(formId)));
  });
}

export async function deleteForm(formId: string, projectId: string): Promise<ActionResult> {
  const result = await run(async () => {
    const supabase = await createClient();
    check(await supabase.from("forms").update({ deleted_at: now() }).eq("id", id(formId)));
  });
  if (!result.error) redirect(`/projects/${id(projectId)}/forms`);
  return result;
}

export type SubmitFormResult = {
  error?: string;
  fieldErrors?: Record<string, string>;
  requestLabel?: string | null;
  message?: string | null;
};

// Public: callable by anonymous visitors. Validation runs here and again in submit_form.
export async function submitForm(
  formId: string,
  input: { email: string; answers: FormAnswers; website?: string },
): Promise<SubmitFormResult> {
  if (!isUuid(formId)) return { error: "This form does not exist" };
  // Honeypot: real visitors never see or fill the "website" input.
  if (input.website) return { requestLabel: null, message: null };
  const supabase = await createClient();
  const form = await supabase.rpc("get_public_form", { target_form: formId });
  const data = form.data && typeof form.data === "object" && !Array.isArray(form.data) ? form.data : null;
  if (form.error || !data) return { error: "This form does not exist" };
  const questions = parseQuestions(data.questions ?? []);
  const email = input.email.trim() || (typeof data.viewer_email === "string" ? data.viewer_email : "");
  const { errors, clean } = validateSubmission(questions, email, input.answers ?? {});
  if (Object.keys(errors).length) return { error: "Check the highlighted answers", fieldErrors: errors };

  const result = await supabase.rpc("submit_form", {
    target_form: formId,
    submitter_email: email,
    answers: clean as Json,
  });
  if (result.error) return { error: result.error.message };
  const out = (result.data ?? {}) as { request_label?: string | null; message?: string | null };
  deliverQueuedEmail();
  return { requestLabel: out.request_label ?? null, message: out.message ?? null };
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

type RuleInput = {
  name: string;
  triggerType: string;
  triggerConfig: Record<string, Json>;
  conditions: RuleCondition[];
  actions: RuleAction[];
};

// Same checks the database makes (integration_url_ok / integration_header_ok), for a clearer message.
// Plain URLs and secrets are moved out of rules.actions by a trigger before the rule is stored.
function checkIntegrationAction(action: RuleAction) {
  if (action.type !== "send_slack" && action.type !== "call_webhook") return;
  const urlKey = action.type === "send_slack" ? "webhook_url" : "url";
  const url = action[urlKey];
  if (typeof url === "string" && url.trim() && !isAllowedWebhookUrl(url.trim())) throw new InputError(WEBHOOK_URL_ERROR);
  if (action.type === "send_slack" && "format" in action && !SLACK_FORMATS.some((f) => f.value === action.format)) {
    throw new InputError("Send Slack message: choose plain text or Block Kit");
  }
  if (action.type === "call_webhook") {
    if (typeof action.secret === "string" && action.secret.length > MAX_SECRET_LENGTH) {
      throw new InputError("The shared secret is limited to 500 characters");
    }
    const header = action.secret_header;
    if (typeof header === "string" && header && !isAllowedHeaderName(header)) {
      throw new InputError("Header names use letters, digits, and dashes (and can’t be a standard transport header)");
    }
  }
}

// A Call webhook action's own signing secret is generated here (the builder sends
// generate_signing_secret: true), stored by the database trigger like the shared secret, and returned
// once with the save result. A typed value is refused; "" removes the saved one.
export type RevealedSigningSecret = { action: number; secret: string };

function prepareSigningSecret(action: RuleAction, index: number, revealed: RevealedSigningSecret[]): RuleAction {
  const { generate_signing_secret: generate, ...rest } = action;
  if (action.type !== "call_webhook") return rest;
  if (typeof rest.signing_secret === "string" && rest.signing_secret !== "") {
    throw new InputError("Call webhook: signing secrets are generated by the app");
  }
  if (generate !== true) return rest;
  if (rest.use_project_webhook === true) {
    throw new InputError("Call webhook: the project webhook is signed with the project’s signing secret (Settings → Integrations)");
  }
  const ownUrl = (typeof rest.url === "string" && rest.url.trim() !== "") || (rest.url_ref !== undefined && rest.url !== "");
  if (!ownUrl) {
    throw new InputError("Call webhook: add this action’s own URL to sign it with its own secret");
  }
  const secret = generateSigningSecret();
  revealed.push({ action: index + 1, secret });
  return { ...rest, signing_secret: secret };
}

function ruleRow(input: RuleInput, revealed: RevealedSigningSecret[] = []) {
  if (!isTriggerType(input.triggerType)) throw new InputError("Choose a trigger");
  if (!Array.isArray(input.actions) || input.actions.length === 0) throw new InputError("Add at least one action");
  input.actions.forEach(checkIntegrationAction);
  const actions = input.actions.map((action, index) => prepareSigningSecret(action, index, revealed));
  return {
    name: text(input.name, "Rule name", { max: 200 }),
    trigger_type: input.triggerType,
    trigger_config: (input.triggerConfig ?? {}) as Json,
    conditions: (input.conditions ?? []) as Json,
    actions: actions as Json,
  };
}

export type RuleSaveResult = ActionResult & { signingSecrets?: RevealedSigningSecret[] };

export async function createRule(projectId: string, input: RuleInput): Promise<RuleSaveResult> {
  const revealed: RevealedSigningSecret[] = [];
  const result = await run(async () => {
    const supabase = await createClient();
    const { data: last } = await supabase
      .from("rules")
      .select("sort_order")
      .eq("project_id", id(projectId))
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    check(
      await supabase
        .from("rules")
        .insert({ project_id: projectId, ...ruleRow(input, revealed), sort_order: (last?.sort_order ?? 0) + ORDER_STEP }),
    );
  });
  return result.error || revealed.length === 0 ? result : { signingSecrets: revealed };
}

export async function updateRule(ruleId: string, input: RuleInput): Promise<RuleSaveResult> {
  const revealed: RevealedSigningSecret[] = [];
  const result = await run(async () => {
    const supabase = await createClient();
    checkUpdated(await supabase.from("rules").update(ruleRow(input, revealed)).eq("id", id(ruleId)).select("id"));
  });
  return result.error || revealed.length === 0 ? result : { signingSecrets: revealed };
}

export async function setRuleEnabled(ruleId: string, enabled: boolean): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(await supabase.from("rules").update({ enabled: Boolean(enabled) }).eq("id", id(ruleId)));
  });
}

export async function deleteRule(ruleId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("rules").update({ deleted_at: now(), enabled: false }).eq("id", id(ruleId)),
    );
  });
}

export async function installRulePreset(
  projectId: string,
  presetKey: string,
  inputs: Record<string, Json>,
  enable: boolean,
): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.rpc("install_rule_preset", {
        target_project: id(projectId),
        preset: text(presetKey, "Preset", { max: 100 }),
        inputs: inputs as Json,
        enable: Boolean(enable),
      }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------------------------

async function nextOrder(table: "project_views" | "dashboard_widgets", projectId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from(table)
    .select("sort_order")
    .eq("project_id", id(projectId))
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.sort_order ?? 0) + ORDER_STEP;
}

export async function createView(
  projectId: string,
  input: { name?: string; layout: string; config?: ViewConfig },
): Promise<ActionResult> {
  let viewId: string | null = null;
  const result = await run(async () => {
    if (!isViewLayout(input.layout)) throw new InputError("Unknown view layout");
    const fallback = VIEW_LAYOUTS.find((l) => l.value === input.layout)!.label;
    const supabase = await createClient();
    const inserted = await supabase
      .from("project_views")
      .insert({
        project_id: id(projectId),
        name: text(input.name || fallback, "View name", { max: 100 }),
        layout: input.layout,
        config: toJson(parseViewConfig(input.config ?? {})),
        sort_order: await nextOrder("project_views", projectId),
      })
      .select("id")
      .single();
    check(inserted);
    viewId = inserted.data!.id;
  });
  if (viewId && !result.error) redirect(`/projects/${projectId}/views/${viewId}`);
  return result;
}

export async function updateView(
  viewId: string,
  patch: { name?: string; config?: ViewConfig },
): Promise<ActionResult> {
  return run(async () => {
    const update: { name?: string; config?: Json } = {};
    if (patch.name !== undefined) update.name = text(patch.name, "View name", { max: 100 });
    if (patch.config !== undefined) update.config = toJson(parseViewConfig(patch.config));
    const supabase = await createClient();
    check(await supabase.from("project_views").update(update).eq("id", id(viewId)));
  });
}

export async function duplicateView(viewId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: view } = await supabase
    .from("project_views")
    .select("project_id, name, layout, config")
    .eq("id", id(viewId))
    .is("deleted_at", null)
    .maybeSingle();
  if (!view) return { error: "This view no longer exists" };
  return createView(view.project_id, {
    name: `${view.name} copy`.slice(0, 100),
    layout: view.layout,
    config: parseViewConfig(view.config),
  });
}

export async function deleteView(viewId: string): Promise<ActionResult> {
  let projectId: string | null = null;
  const result = await run(async () => {
    const supabase = await createClient();
    const { data: view } = await supabase
      .from("project_views")
      .select("project_id")
      .eq("id", id(viewId))
      .is("deleted_at", null)
      .maybeSingle();
    if (!view) throw new InputError("This view no longer exists");
    const { count } = await supabase
      .from("project_views")
      .select("id", { count: "exact", head: true })
      .eq("project_id", view.project_id)
      .is("deleted_at", null);
    if ((count ?? 0) <= 1) throw new InputError("A project needs at least one view");
    check(await supabase.from("project_views").update({ deleted_at: now() }).eq("id", viewId));
    projectId = view.project_id;
  });
  if (projectId && !result.error) redirect(`/projects/${projectId}`);
  return result;
}

// Swaps a view or widget with its neighbour (direction -1 = earlier, 1 = later).
async function moveRow(table: "project_views" | "dashboard_widgets", rowId: string, direction: number) {
  const supabase = await createClient();
  const { data: row } = await supabase
    .from(table)
    .select("project_id")
    .eq("id", id(rowId))
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) throw new InputError("This item no longer exists");
  const { data: siblings } = await supabase
    .from(table)
    .select("id, sort_order")
    .eq("project_id", row.project_id)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  const list = siblings ?? [];
  const index = list.findIndex((s) => s.id === rowId);
  const target = index + (direction < 0 ? -1 : 1);
  if (index === -1 || target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  for (const [i, item] of list.entries()) {
    const order = (i + 1) * ORDER_STEP;
    if (item.sort_order !== order) {
      check(await supabase.from(table).update({ sort_order: order }).eq("id", item.id));
    }
  }
}

export async function moveView(viewId: string, direction: -1 | 1): Promise<ActionResult> {
  return run(() => moveRow("project_views", viewId, direction));
}

// ---------------------------------------------------------------------------------------------
// Dashboard widgets
// ---------------------------------------------------------------------------------------------

const STARTER_WIDGETS: { kind: WidgetKind; title: string; filters: ViewFilters }[] = [
  { kind: "count", title: "Incomplete tasks", filters: {} },
  { kind: "count", title: "Overdue", filters: { due: { kind: "overdue" } } },
  { kind: "count", title: "Completed in the last 7 days", filters: { completion: "completed", completed_within_days: 7 } },
  { kind: "by_section", title: "Incomplete by section", filters: {} },
  { kind: "by_assignee", title: "Incomplete by assignee", filters: {} },
];

export async function installStarterWidgets(projectId: string): Promise<ActionResult> {
  return run(async () => {
    const start = await nextOrder("dashboard_widgets", projectId);
    const supabase = await createClient();
    check(
      await supabase.from("dashboard_widgets").insert(
        STARTER_WIDGETS.map((w, i) => ({
          project_id: projectId,
          kind: w.kind,
          title: w.title,
          filters: toJson(w.filters),
          sort_order: start + i * ORDER_STEP,
        })),
      ),
    );
  });
}

export async function createWidget(
  projectId: string,
  input: { kind: string; title: string; filters?: ViewFilters },
): Promise<ActionResult> {
  return run(async () => {
    if (!isWidgetKind(input.kind)) throw new InputError("Unknown widget type");
    const supabase = await createClient();
    check(
      await supabase.from("dashboard_widgets").insert({
        project_id: id(projectId),
        kind: input.kind,
        title: text(input.title, "Widget title", { max: 100 }),
        filters: toJson(parseFilters(input.filters ?? {})),
        sort_order: await nextOrder("dashboard_widgets", projectId),
      }),
    );
  });
}

export async function updateWidget(
  widgetId: string,
  patch: { kind?: string; title?: string; filters?: ViewFilters },
): Promise<ActionResult> {
  return run(async () => {
    const update: { kind?: string; title?: string; filters?: Json } = {};
    if (patch.kind !== undefined) {
      if (!isWidgetKind(patch.kind)) throw new InputError("Unknown widget type");
      update.kind = patch.kind;
    }
    if (patch.title !== undefined) update.title = text(patch.title, "Widget title", { max: 100 });
    if (patch.filters !== undefined) update.filters = toJson(parseFilters(patch.filters));
    const supabase = await createClient();
    check(await supabase.from("dashboard_widgets").update(update).eq("id", id(widgetId)));
  });
}

export async function deleteWidget(widgetId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    check(
      await supabase.from("dashboard_widgets").update({ deleted_at: now() }).eq("id", id(widgetId)),
    );
  });
}

export async function moveWidget(widgetId: string, direction: -1 | 1): Promise<ActionResult> {
  return run(() => moveRow("dashboard_widgets", widgetId, direction));
}

// ---------------------------------------------------------------------------------------------
// Asana import (Admin+). Export files are uploaded by the browser to the private `imports` bucket;
// these actions download and parse them server-side and send rpc("import_batch") batches. Never
// calls the Asana API.
// ---------------------------------------------------------------------------------------------

const IMPORT_TIME_BUDGET_MS = 20_000;

async function loadImportPlan(projectId: string, paths: unknown) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new InputError("Sign in again to import");
  if (!Array.isArray(paths) || paths.length === 0) throw new InputError("Choose at least one export file");
  if (paths.length > MAX_IMPORT_FILES) throw new InputError(`Import up to ${MAX_IMPORT_FILES} files at a time`);
  await requireImportAdmin(supabase, projectId);
  const prefix = `${projectId}/${user.id}/`;
  const files: { name: string; text: string }[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || !path.startsWith(prefix) || path.includes("..") || path.split("/").length !== 3) {
      throw new InputError("Invalid upload");
    }
    const name = importFileName(path);
    if (!importFileKind(name)) throw new InputError(`${name}: only .json and .csv Asana exports can be imported`);
    const download = await supabase.storage.from(IMPORTS_BUCKET).download(path);
    if (download.error || !download.data) {
      throw new DbError(`Couldn’t read ${name}. Upload it again and retry.`);
    }
    if (download.data.size > MAX_IMPORT_FILE_BYTES) throw new InputError(`${name} is larger than 50 MB`);
    files.push({ name, text: await download.data.text() });
  }
  try {
    return { supabase, plan: buildImportPlan(files), files: files.map((f) => f.name) };
  } catch (error) {
    if (error instanceof ImportParseError) throw new InputError(error.message);
    throw error;
  }
}

async function requireImportAdmin(supabase: Awaited<ReturnType<typeof createClient>>, projectId: string) {
  const roleResult = await supabase.rpc("project_role", { target_project: projectId });
  check(roleResult);
  if (roleResult.data !== "owner" && roleResult.data !== "admin") {
    throw new DbError("You need Admin access to import into this project");
  }
}

type PeopleBuckets = ImportPreview["people"];

async function classifyPeople(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string,
  plan: ImportPlan,
): Promise<PeopleBuckets> {
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
  projectId: string,
  paths: string[],
): Promise<ActionResult & { preview?: ImportPreview }> {
  try {
    const project = id(projectId, "project");
    const { supabase, plan, files } = await loadImportPlan(project, paths);

    const ids = planExternalIds(plan);
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

    const people = await classifyPeople(supabase, project, plan);
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
      },
      people,
      warnings: plan.warnings,
      steps: importSteps(plan).length,
    };
    return { preview };
  } catch (error) {
    if (error instanceof InputError || error instanceof DbError) return { error: error.message };
    throw error;
  }
}

// Runs (or resumes) an import: one call works through as many batches as fit in ~20 s and returns
// where it stopped; the page calls again until done. Batches are idempotent, so retrying a step that
// failed halfway never duplicates rows.
export async function runAsanaImport(input: {
  projectId: string;
  paths: string[];
  runId?: string | null;
  step?: number;
  totals?: ImportTotals;
  inviteRole?: "editor" | null;
}): Promise<ActionResult & { progress?: ImportProgress }> {
  const started = Date.now();
  try {
    const project = id(input.projectId, "project");
    const { supabase, plan, files } = await loadImportPlan(project, input.paths);
    const steps = importSteps(plan);
    let totals = addTotals({}, input.totals);
    let step = Number.isInteger(input.step) && input.step! >= 0 ? input.step! : 0;
    let runId = input.runId ?? null;

    if (!runId) {
      // Optionally invite people who already have an account, so their assignments survive.
      if (input.inviteRole === "editor") {
        const people = await classifyPeople(supabase, project, plan);
        for (const person of people.notMember) {
          if (!person.email) continue;
          check(
            await supabase.rpc("add_project_member", {
              target_project: project,
              member_email: person.email,
              member_role: "editor",
            }),
          );
        }
      }
      const newRun = await supabase.rpc("start_import_run", {
        target_project: project,
        import_source: "asana",
        file_names: files,
      });
      check(newRun);
      runId = newRun.data!;
      step = 0;
    } else {
      id(runId, "import");
    }

    while (step < steps.length && (step === 0 || Date.now() - started < IMPORT_TIME_BUDGET_MS)) {
      const result = await supabase.rpc("import_batch", { target_run: runId, batch: steps[step] });
      check(result);
      totals = addTotals(totals, result.data);
      step++;
    }

    const done = step >= steps.length;
    if (done) {
      check(
        await supabase.rpc("finish_import_run", {
          target_run: runId,
          run_status: "completed",
          run_summary: { totals, warnings: plan.warnings, source_project: plan.project?.name ?? null } as unknown as Json,
        }),
      );
      // The uploaded exports are no longer needed once everything landed.
      await supabase.storage.from(IMPORTS_BUCKET).remove(input.paths);
      refresh();
    }
    return { progress: { runId, step, steps: steps.length, done, totals } };
  } catch (error) {
    if (error instanceof InputError || error instanceof DbError) return { error: error.message };
    throw error;
  }
}

// Removes uploaded export files that won't be imported (e.g. after "Start over").
export async function discardImportUploads(projectId: string, paths: string[]): Promise<ActionResult> {
  try {
    const project = id(projectId, "project");
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return {};
    const own = (Array.isArray(paths) ? paths : []).filter(
      (p) => typeof p === "string" && p.startsWith(`${project}/${user.id}/`) && !p.includes(".."),
    );
    if (own.length) await supabase.storage.from(IMPORTS_BUCKET).remove(own);
    return {};
  } catch (error) {
    if (error instanceof InputError) return { error: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Personal dashboards (Reporting and export). Owner-only RLS: nobody else can read or change them, and
// the widget guard validates the report filter (validate_report_filters()).
// ---------------------------------------------------------------------------------------------

export async function createPersonalDashboard(formData: FormData): Promise<ActionResult> {
  let dashboardId: string | null = null;
  const result = await run(async () => {
    const name = text(formData.get("name"), "Dashboard name", { max: 100 });
    const supabase = await createClient();
    const { data: last } = await supabase
      .from("personal_dashboards")
      .select("sort_order")
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const inserted = await supabase
      .from("personal_dashboards")
      .insert({ name, sort_order: (last?.sort_order ?? 0) + ORDER_STEP })
      .select("id")
      .single();
    check(inserted);
    dashboardId = inserted.data!.id;
    check(
      await supabase.from("personal_dashboard_widgets").insert([
        { dashboard_id: dashboardId, kind: "count", title: "Open tasks", filters: { status: "open" }, sort_order: ORDER_STEP },
        { dashboard_id: dashboardId, kind: "count", title: "Overdue", filters: { status: "overdue" }, sort_order: 2 * ORDER_STEP },
        {
          dashboard_id: dashboardId,
          kind: "completed_series",
          title: "Completed per week",
          series_interval: "week",
          sort_order: 3 * ORDER_STEP,
        },
        { dashboard_id: dashboardId, kind: "by_project", title: "Open tasks by project", filters: { status: "open" }, sort_order: 4 * ORDER_STEP },
      ]),
    );
  });
  if (dashboardId && !result.error) redirect(`/reports/dashboards/${dashboardId}`);
  return result;
}

export async function renamePersonalDashboard(dashboardId: string, name: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase
        .from("personal_dashboards")
        .update({ name: text(name, "Dashboard name", { max: 100 }) })
        .eq("id", id(dashboardId))
        .select("id"),
      "This dashboard no longer exists",
    );
  });
}

export async function deletePersonalDashboard(dashboardId: string): Promise<ActionResult> {
  const result = await run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("personal_dashboards").update({ deleted_at: now() }).eq("id", id(dashboardId)).select("id"),
      "This dashboard no longer exists",
    );
  });
  if (!result.error) redirect("/reports/dashboards");
  return result;
}

type PersonalWidgetInput = { kind: string; title?: string; filters?: ReportFilters; interval?: string };

function personalWidgetFields(input: Partial<PersonalWidgetInput>) {
  const fields: { kind?: string; title?: string; filters?: Json; series_interval?: string } = {};
  if (input.kind !== undefined) {
    if (!isPersonalWidgetKind(input.kind)) throw new InputError("Unknown widget type");
    fields.kind = input.kind;
  }
  if (input.title !== undefined) fields.title = text(input.title, "Widget title", { max: 100 });
  if (input.filters !== undefined) fields.filters = reportFiltersJson(input.filters);
  if (input.interval !== undefined) {
    if (!isSeriesInterval(input.interval)) throw new InputError("Choose days or weeks");
    fields.series_interval = input.interval;
  }
  return fields;
}

export async function createPersonalWidget(dashboardId: string, input: PersonalWidgetInput): Promise<ActionResult> {
  return run(async () => {
    if (!isPersonalWidgetKind(input.kind)) throw new InputError("Unknown widget type");
    const fields = personalWidgetFields({ title: DEFAULT_WIDGET_TITLES[input.kind], ...input });
    const supabase = await createClient();
    const { data: last } = await supabase
      .from("personal_dashboard_widgets")
      .select("sort_order")
      .eq("dashboard_id", id(dashboardId))
      .is("deleted_at", null)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    check(
      await supabase.from("personal_dashboard_widgets").insert({
        dashboard_id: dashboardId,
        kind: input.kind,
        title: fields.title!,
        filters: fields.filters ?? {},
        series_interval: fields.series_interval ?? "week",
        sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
      }),
      "This dashboard no longer exists",
    );
  });
}

export async function updatePersonalWidget(widgetId: string, patch: Partial<PersonalWidgetInput>): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase
        .from("personal_dashboard_widgets")
        .update(personalWidgetFields(patch))
        .eq("id", id(widgetId))
        .select("id"),
      "This widget no longer exists",
    );
  });
}

export async function deletePersonalWidget(widgetId: string): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    checkUpdated(
      await supabase.from("personal_dashboard_widgets").update({ deleted_at: now() }).eq("id", id(widgetId)).select("id"),
      "This widget no longer exists",
    );
  });
}

export async function movePersonalWidget(widgetId: string, direction: -1 | 1): Promise<ActionResult> {
  return run(async () => {
    const supabase = await createClient();
    const { data: row } = await supabase
      .from("personal_dashboard_widgets")
      .select("dashboard_id")
      .eq("id", id(widgetId))
      .is("deleted_at", null)
      .maybeSingle();
    if (!row) throw new InputError("This widget no longer exists");
    const { data: siblings } = await supabase
      .from("personal_dashboard_widgets")
      .select("id, sort_order")
      .eq("dashboard_id", row.dashboard_id)
      .is("deleted_at", null)
      .order("sort_order")
      .order("created_at");
    const list = siblings ?? [];
    const index = list.findIndex((w) => w.id === widgetId);
    const target = index + (direction < 0 ? -1 : 1);
    if (index === -1 || target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    for (const [i, item] of list.entries()) {
      const order = (i + 1) * ORDER_STEP;
      if (item.sort_order !== order) {
        check(await supabase.from("personal_dashboard_widgets").update({ sort_order: order }).eq("id", item.id));
      }
    }
  });
}
