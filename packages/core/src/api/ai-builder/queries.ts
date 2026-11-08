// AI builder phase 1 (experimental pilot): reads. Every one runs as the caller (RLS: the registry and the
// runs are readable only by workspace admins of a live pilot workspace).
import { AI_RUN_KINDS, AI_RUN_STATUSES, templateOutline, type AiRunKind, type AiRunStatus, type TemplateOutline } from "../../ai-builder";
import { parseStoredRuleDraft } from "../../ai-automation";
import type { BuiltRule } from "../../rule-templates";
import type { Json } from "../../supabase/database.types";
import { read, type ApiContext } from "../core/context";
import { maybe, rows } from "../core/db";
import { schemaMissing } from "../core/errors";
import { id } from "../core/validate";
import type { AiBuilderAccess, AiPilotMember, AiPilotTemplate, AiRunSummary } from "./model";

export const PILOT_WORKSPACE_NAME = "Testing data";

// The one pilot workspace the caller administers, or why there's none. Any error, an ambiguous answer, or
// a workspace that doesn't look exactly like the pilot is a refusal.
export const getAiBuilderAccess = read(async (ctx: ApiContext): Promise<AiBuilderAccess> => {
  const reg = await ctx.db.from("ai_pilot_workspaces").select("workspace_id").is("cleaned_at", null).limit(2);
  if (reg.error) return { status: schemaMissing(reg.error.code) ? "not_deployed" : "error" };
  const list = reg.data ?? [];
  if (list.length === 0) return { status: "no_pilot" };
  if (list.length > 1) return { status: "error" };
  const workspaceId = list[0].workspace_id;
  const [admin, ws] = await Promise.all([
    ctx.db.rpc("ai_pilot_admin", { target_workspace: workspaceId }),
    ctx.db.from("workspaces").select("name").eq("id", workspaceId).is("deleted_at", null).maybeSingle(),
  ]);
  if (admin.error || ws.error) return { status: schemaMissing(admin.error?.code) ? "not_deployed" : "error" };
  if (admin.data !== true) return { status: "not_admin" };
  if (ws.data?.name !== PILOT_WORKSPACE_NAME) return { status: "error" };
  return { status: "ready", workspaceId, workspaceName: ws.data.name };
});

// Templates the brief may adapt: only the pilot workspace's own.
export const listPilotTemplates = read(async (ctx: ApiContext, workspaceId: string): Promise<AiPilotTemplate[]> =>
  rows(
    await ctx.db
      .from("project_templates")
      .select("id, name")
      .eq("workspace_id", id(workspaceId, "workspace"))
      .is("deleted_at", null)
      .order("name")
      .limit(100),
    "templates",
  ).map((t) => ({ id: t.id, name: t.name })),
);

// One template's outline, only when it belongs to the pilot workspace (null otherwise).
export async function getPilotTemplateOutline(ctx: ApiContext, workspaceId: string, templateId: string): Promise<TemplateOutline | null> {
  const row = maybe(
    await ctx.db
      .from("project_templates")
      .select("name, content, workspace_id")
      .eq("id", id(templateId, "template"))
      .eq("workspace_id", id(workspaceId, "workspace"))
      .is("deleted_at", null)
      .maybeSingle(),
    "template",
  );
  if (!row || row.workspace_id !== workspaceId) return null;
  return templateOutline(row.name, row.content);
}

const RUN_COLUMNS =
  "id, actor_id, kind, parent_run_id, effort, target_project_id, rule_id, status, proposal, proposal_version, model, input_tokens, output_tokens, error_code, project_id, created_ids, undo_conflicts, created_at, applied_at, undone_at";

type RunRow = {
  id: string;
  actor_id: string;
  kind: string | null;
  parent_run_id: string | null;
  effort: string | null;
  target_project_id: string | null;
  rule_id: string | null;
  status: string;
  proposal: Json | null;
  proposal_version: number;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error_code: string | null;
  project_id: string | null;
  created_ids: Json | null;
  undo_conflicts: Json | null;
  created_at: string;
  applied_at: string | null;
  undone_at: string | null;
};

const length = (v: unknown) => (Array.isArray(v) ? v.length : 0);

export function toRunSummary(row: RunRow, viewerId: string | null): AiRunSummary {
  const proposal = row.proposal && typeof row.proposal === "object" && !Array.isArray(row.proposal) ? row.proposal : null;
  const created = row.created_ids && typeof row.created_ids === "object" && !Array.isArray(row.created_ids) ? row.created_ids : null;
  const conflicts = row.undo_conflicts && typeof row.undo_conflicts === "object" && !Array.isArray(row.undo_conflicts) ? row.undo_conflicts.changed : null;
  return {
    id: row.id,
    actorId: row.actor_id,
    mine: viewerId === row.actor_id,
    kind: ((AI_RUN_KINDS as readonly string[]).includes(row.kind ?? "") ? row.kind : "build") as AiRunKind,
    parentRunId: row.parent_run_id ?? null,
    effort: row.effort ?? null,
    targetProjectId: row.target_project_id ?? null,
    ruleId: row.rule_id ?? null,
    status: ((AI_RUN_STATUSES as readonly string[]).includes(row.status) ? row.status : "failed") as AiRunStatus,
    projectName: proposal && typeof proposal.name === "string" ? proposal.name : null,
    proposalVersion: row.proposal_version,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    errorCode: row.error_code,
    projectId: row.project_id,
    created: created
      ? { sections: length(created.sections), fields: length(created.fields), tasks: length(created.tasks), subtasks: length(created.subtasks) }
      : null,
    undoConflicts: Array.isArray(conflicts) ? conflicts.filter((c): c is string => typeof c === "string") : null,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    undoneAt: row.undone_at,
  };
}

// The pilot workspace's runs, newest first (every pilot admin reads them; only the actor applies or undoes).
export const listAiRuns = read(async (ctx: ApiContext, workspaceId: string, viewerId: string | null): Promise<AiRunSummary[]> =>
  rows(
    await ctx.db
      .from("ai_builder_runs")
      .select(RUN_COLUMNS)
      .eq("workspace_id", id(workspaceId, "workspace"))
      .order("created_at", { ascending: false })
      .limit(50),
    "AI builder history",
  ).map((r) => toRunSummary(r as RunRow, viewerId)),
);

export async function getAiRunRow(ctx: ApiContext, runId: string) {
  return maybe(
    await ctx.db
      .from("ai_builder_runs")
      .select("id, workspace_id, actor_id, kind, status, proposal, proposal_version, target_project_id")
      .eq("id", id(runId, "run"))
      .maybeSingle(),
    "AI builder run",
  );
}

// Round 2: the people of the pilot workspace (its workspace admins and active team members), for the
// draft's assignee picker and the model's aliases. Only a pilot admin gets rows (ai_pilot_members checks).
export const listPilotMembers = read(async (ctx: ApiContext, workspaceId: string): Promise<AiPilotMember[]> => {
  const res = await ctx.db.rpc("ai_pilot_members", { target_workspace: id(workspaceId, "workspace") });
  return rows(res, "Testing data members").map((m) => ({ id: m.profile_id, name: m.name ?? m.email ?? "", email: m.email ?? "", me: Boolean(m.is_me) }));
});

// Round 2: a project of the pilot workspace and the caller's role in it (null when it isn't one).
export async function getPilotProject(ctx: ApiContext, workspaceId: string, projectId: string) {
  const row = maybe(
    await ctx.db.from("projects").select("id, name, workspace_id, archived_at").eq("id", id(projectId, "project")).is("deleted_at", null).maybeSingle(),
    "project",
  );
  if (!row || row.workspace_id !== workspaceId) return null;
  const role = await ctx.db.rpc("project_role", { target_project: projectId });
  return { id: row.id, name: row.name, archived: Boolean(row.archived_at), role: typeof role.data === "string" ? role.data : null };
}

// Round 2: the AI automation draft the rule canvas opens: the caller's own, still a draft, for this project.
export async function getAiAutomationDraft(ctx: ApiContext, runId: string, projectId: string, viewerId: string | null): Promise<BuiltRule | null> {
  const run = await getAiRunRow(ctx, runId);
  if (!run || !viewerId || run.actor_id !== viewerId) return null;
  if (run.kind !== "automation" || run.status !== "proposed" || run.target_project_id !== projectId) return null;
  return parseStoredRuleDraft(run.proposal);
}
