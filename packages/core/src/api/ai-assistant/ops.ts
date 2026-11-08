// AI builder round 3 (experimental, feat/ai-builder-p3): what each assistant operation reads, writes, and
// undoes. Every write is an existing typed-API mutation run with the signed-in person's own context, so
// RLS, the guards, validate_rule, and the dependency (blocked-completion) guard decide exactly as when the
// person does it by hand. Nothing here uses the service role or sends anything.
import { RULE_OPS, ruleState, taskState, type AssistantOp, type OpState } from "../../ai-assistant";
import { hasRole, isProjectRole, type ProjectRole } from "../../roles";
import { isTriggerType, type RuleAction, type RuleCondition } from "../../rules";
import { parseBlockerCounts, blockedCompletionReason } from "../../blocked-completion";
import type { Json } from "../../supabase/database.types";
import type { ApiContext } from "../core/context";
import { maybe, rows } from "../core/db";
import { ApiError, invalid } from "../core/errors";
import { createRule, deleteRule, restoreRule, setRuleEnabled, updateRule } from "../automations/mutations";
import { setFieldValue } from "../fields/mutations";
import { createSection, deleteSection, renameSection } from "../projects/mutations";
import { addTaskToProject, moveTask, placeSection, removeTaskFromProject, setTaskCompleted, updateTask } from "../tasks/mutations";
import { NOT_PILOT_PAGE } from "./queries";

const noSigningSecrets = () => {
  throw invalid("The AI assistant doesn’t make webhook signing secrets");
};

export const isRuleOp = (op: AssistantOp) => RULE_OPS.has(op.op);
const taskIdOf = (op: AssistantOp): string | null => ("taskId" in op ? op.taskId : null);

// The person's role in a project of the pilot (archived = Viewer), or a refusal when it isn't one.
async function pilotRole(ctx: ApiContext, workspaceId: string, projectId: string): Promise<ProjectRole> {
  const p = maybe(
    await ctx.db.from("projects").select("id, workspace_id, archived_at, deleted_at").eq("id", projectId).maybeSingle(),
    "project",
  );
  if (!p || p.deleted_at || p.workspace_id !== workspaceId) throw new ApiError("forbidden", NOT_PILOT_PAGE);
  const role = (await ctx.db.rpc("project_role", { target_project: projectId })).data;
  if (!isProjectRole(role)) throw new ApiError("forbidden", "You’re not a member of that project any more");
  return p.archived_at ? "viewer" : role;
}

// Checks again, against the database now, that the person may make this change: every project it touches
// is a live project of the pilot where their own role allows it (Editor+, Admin+ for automations), and
// its target really belongs to the operation's project. Throws a plain refusal otherwise.
// `undoing`: the check before Undo (a task moved to another project is found there now).
export async function checkOpAccess(ctx: ApiContext, workspaceId: string, op: AssistantOp, opts: { completing?: boolean; undoing?: boolean } = {}) {
  const need: ProjectRole = isRuleOp(op) ? "admin" : "editor";
  const projects = [op.projectId, ...(op.op === "move_task" && op.toProjectId !== op.projectId ? [op.toProjectId] : [])];
  for (const projectId of projects) {
    if (!hasRole(await pilotRole(ctx, workspaceId, projectId), need)) {
      throw new ApiError("forbidden", need === "admin" ? "Only the project’s Owners and Admins change its automations" : "Your role in this project doesn’t allow that");
    }
  }
  if ("ruleId" in op) {
    const r = maybe(await ctx.db.from("rules").select("project_id").eq("id", op.ruleId).maybeSingle(), "automation");
    if (!r || r.project_id !== op.projectId) throw new ApiError("forbidden", "That automation isn’t in this project");
  }
  if ("sectionId" in op && op.sectionId && op.op !== "move_task") {
    const s = maybe(await ctx.db.from("sections").select("project_id").eq("id", op.sectionId).maybeSingle(), "section");
    if (!s || s.project_id !== op.projectId) throw new ApiError("forbidden", "That section isn’t in this project");
  }
  if (op.op === "move_task" && op.sectionId) {
    const s = maybe(await ctx.db.from("sections").select("project_id").eq("id", op.sectionId).maybeSingle(), "section");
    if (!s || s.project_id !== op.toProjectId) throw new ApiError("forbidden", "That section isn’t in that project");
  }
  if (op.op === "set_field") {
    const f = maybe(await ctx.db.from("custom_fields").select("project_id").eq("id", op.fieldId).maybeSingle(), "field");
    if (!f || f.project_id !== op.projectId) throw new ApiError("forbidden", "That field isn’t in this project");
  }
  const taskId = taskIdOf(op);
  if (taskId) {
    const t = maybe(await ctx.db.from("tasks").select("id, root_task_id, kind").eq("id", taskId).maybeSingle(), "task");
    if (!t) throw new ApiError("not_found", "That task isn’t available any more");
    const where = opts.undoing && op.op === "move_task" ? op.toProjectId : op.projectId;
    const member = maybe(
      await ctx.db.from("task_projects").select("task_id").eq("task_id", t.root_task_id ?? t.id).eq("project_id", where).is("deleted_at", null).maybeSingle(),
      "task project",
    );
    if (!member) throw new ApiError("forbidden", "That task isn’t in this project any more");
    // Never complete a blocked task (notes 155 / 163): the same count the automations' check uses. The
    // database's dependency guard refuses the write again for a person.
    if (opts.completing ?? op.op === "complete_task") {
      if (t.kind === "approval") throw new ApiError("invalid", "Only its approvers complete an approval task");
      const counts = parseBlockerCounts((await ctx.db.rpc("open_blocker_counts", { task_ids: [taskId] })).data ?? null);
      const n = counts.get(taskId) ?? 0;
      if (n > 0) throw new ApiError("invalid", `Not completed: ${blockedCompletionReason(n).replace("this automation", "this change")}`);
    }
  }
}

async function membership(ctx: ApiContext, taskId: string, projectId: string) {
  return maybe(
    await ctx.db.from("task_projects").select("section_id, sort_order").eq("task_id", taskId).eq("project_id", projectId).is("deleted_at", null).maybeSingle(),
    "task project",
  );
}

async function sectionOrder(ctx: ApiContext, projectId: string): Promise<string[]> {
  return rows(await ctx.db.from("sections").select("id").eq("project_id", projectId).is("deleted_at", null).order("sort_order"), "sections").map((s) => s.id);
}

// The state an operation compares, read now. `created` = what the operation made (a section, a rule).
export async function readOpState(ctx: ApiContext, op: AssistantOp, created: string | null): Promise<OpState> {
  switch (op.op) {
    case "rename_task":
    case "set_description":
    case "assign_task":
    case "set_dates":
    case "complete_task":
    case "reopen_task": {
      const t = maybe(
        await ctx.db.from("tasks").select("title, notes, assignee_id, due_on, start_on, completed_at, deleted_at").eq("id", op.taskId).maybeSingle(),
        "task",
      );
      if (!t || t.deleted_at) return { missing: true };
      return taskState(op.op, { ...t, assignee_id: t.assignee_id ? t.assignee_id.toLowerCase() : null, completed: Boolean(t.completed_at) });
    }
    case "set_field": {
      const v = maybe(await ctx.db.from("task_field_values").select("value").eq("task_id", op.taskId).eq("field_id", op.fieldId).maybeSingle(), "field value");
      return { value: (v?.value ?? null) as Json };
    }
    case "move_task": {
      const from = await membership(ctx, op.taskId, op.projectId);
      const state: OpState = { section_id: from?.section_id ?? null, sort_order: from?.sort_order ?? null, member: Boolean(from) };
      if (op.toProjectId !== op.projectId) {
        const to = await membership(ctx, op.taskId, op.toProjectId);
        state.to_member = Boolean(to);
        state.to_section_id = to?.section_id ?? null;
      }
      return state;
    }
    case "create_section": {
      if (!created) return {};
      const s = maybe(await ctx.db.from("sections").select("name, deleted_at").eq("id", created).maybeSingle(), "section");
      const { count } = await ctx.db
        .from("task_projects")
        .select("task_id, task:tasks!inner(deleted_at)", { count: "exact", head: true })
        .eq("section_id", created)
        .is("deleted_at", null)
        .is("task.deleted_at", null);
      return { name: s?.name ?? null, deleted: !s || Boolean(s.deleted_at), tasks: count ?? 0 };
    }
    case "rename_section": {
      const s = maybe(await ctx.db.from("sections").select("name, deleted_at").eq("id", op.sectionId).maybeSingle(), "section");
      return s && !s.deleted_at ? { name: s.name } : { missing: true };
    }
    case "move_section":
      return { order: await sectionOrder(ctx, op.projectId) };
    case "create_rule":
    case "update_rule":
    case "enable_rule":
    case "disable_rule":
    case "remove_rule": {
      const ruleId = op.op === "create_rule" ? created : op.ruleId;
      if (!ruleId) return {};
      const r = maybe(
        await ctx.db.from("rules").select("name, enabled, trigger_type, trigger_config, conditions, actions, deleted_at").eq("id", ruleId).maybeSingle(),
        "automation",
      );
      if (!r) return { missing: true };
      return ruleState({ ...r, deleted: Boolean(r.deleted_at) });
    }
  }
}

const ruleInput = (state: OpState) => {
  if (!isTriggerType(state.trigger_type)) throw invalid("That automation can’t be restored");
  return {
    name: String(state.name ?? ""),
    triggerType: state.trigger_type,
    triggerConfig: (state.trigger_config ?? {}) as Record<string, Json>,
    conditions: (Array.isArray(state.conditions) ? state.conditions : []) as unknown as RuleCondition[],
    actions: (Array.isArray(state.actions) ? state.actions : []) as unknown as RuleAction[],
  };
};

// Makes the change. Answers the id of anything it made. `createdBy` = ids made by earlier operations of
// the same change set (a move into a section created first).
export async function writeOp(ctx: ApiContext, op: AssistantOp, createdBy: Map<number, string>, timeZone: string | undefined): Promise<string | null> {
  switch (op.op) {
    case "create_rule": {
      const res = await createRule(ctx, op.projectId, { ...op.rule, enabled: false, ...(timeZone ? { timeZone } : {}) }, noSigningSecrets);
      if (!res.ruleId) throw new ApiError("failed", "The automation wasn’t created");
      return res.ruleId;
    }
    case "update_rule":
      await updateRule(ctx, op.ruleId, { ...op.rule, ...(timeZone ? { timeZone } : {}) }, noSigningSecrets);
      return null;
    case "enable_rule":
    case "disable_rule":
      await setRuleEnabled(ctx, op.ruleId, op.op === "enable_rule");
      return null;
    case "remove_rule":
      await deleteRule(ctx, op.ruleId);
      return null;
    case "create_section": {
      const res = await createSection(ctx, op.projectId, op.name, op.beforeSectionId);
      if (!res.sectionId) throw new ApiError("failed", "The section wasn’t created");
      return res.sectionId;
    }
    case "rename_section":
      await renameSection(ctx, op.sectionId, op.name);
      return null;
    case "move_section":
      await placeSection(ctx, op.sectionId, op.beforeSectionId);
      return null;
    case "rename_task":
      await updateTask(ctx, op.taskId, { title: op.title });
      return null;
    case "set_description":
      await updateTask(ctx, op.taskId, { notes: op.notes });
      return null;
    case "assign_task":
      await updateTask(ctx, op.taskId, { assigneeId: op.assigneeId });
      return null;
    case "set_dates":
      await updateTask(ctx, op.taskId, { dueOn: op.dueOn, startOn: op.startOn });
      return null;
    case "complete_task":
    case "reopen_task":
      await setTaskCompleted(ctx, op.taskId, op.op === "complete_task");
      return null;
    case "set_field":
      await setFieldValue(ctx, op.taskId, op.fieldId, op.value);
      return null;
    case "move_task": {
      const sectionId = op.newSection !== null ? (createdBy.get(op.newSection) ?? null) : op.sectionId;
      if (op.newSection !== null && !sectionId) throw invalid("The new section wasn’t made, so the task can’t move into it");
      if (op.toProjectId === op.projectId) {
        await moveTask(ctx, op.taskId, op.projectId, sectionId);
      } else {
        await addTaskToProject(ctx, op.taskId, op.toProjectId);
        if (sectionId) await moveTask(ctx, op.taskId, op.toProjectId, sectionId);
        await removeTaskFromProject(ctx, op.taskId, op.projectId);
      }
      return null;
    }
  }
}

// Puts things back as `before` had them (Undo, or rolling back a change set that failed part way).
export async function undoOp(ctx: ApiContext, op: AssistantOp, before: OpState, created: string | null): Promise<void> {
  switch (op.op) {
    case "create_rule":
      if (created) await deleteRule(ctx, created);
      return;
    case "update_rule":
      await updateRule(ctx, op.ruleId, ruleInput(before), noSigningSecrets);
      return;
    case "enable_rule":
    case "disable_rule":
      await setRuleEnabled(ctx, op.ruleId, Boolean(before.enabled));
      return;
    case "remove_rule":
      await restoreRule(ctx, op.ruleId, Boolean(before.enabled));
      return;
    case "create_section":
      if (created) await deleteSection(ctx, created);
      return;
    case "rename_section":
      await renameSection(ctx, op.sectionId, String(before.name ?? ""));
      return;
    case "move_section": {
      const order = Array.isArray(before.order) ? (before.order as string[]) : [];
      const at = order.indexOf(op.sectionId);
      await placeSection(ctx, op.sectionId, at >= 0 ? (order[at + 1] ?? null) : null);
      return;
    }
    case "rename_task":
      await updateTask(ctx, op.taskId, { title: String(before.title ?? "") });
      return;
    case "set_description":
      await updateTask(ctx, op.taskId, { notes: (before.notes as string | null) ?? null });
      return;
    case "assign_task":
      await updateTask(ctx, op.taskId, { assigneeId: (before.assignee_id as string | null) ?? null });
      return;
    case "set_dates":
      await updateTask(ctx, op.taskId, { dueOn: (before.due_on as string | null) ?? null, startOn: (before.start_on as string | null) ?? null });
      return;
    case "complete_task":
    case "reopen_task":
      await setTaskCompleted(ctx, op.taskId, Boolean(before.completed));
      return;
    case "set_field":
      await setFieldValue(ctx, op.taskId, op.fieldId, (before.value ?? null) as Json);
      return;
    case "move_task": {
      const section = (before.section_id as string | null) ?? null;
      const order = typeof before.sort_order === "number" ? before.sort_order : undefined;
      if (op.toProjectId === op.projectId) {
        await moveTask(ctx, op.taskId, op.projectId, section, order);
      } else {
        await addTaskToProject(ctx, op.taskId, op.projectId);
        await moveTask(ctx, op.taskId, op.projectId, section, order);
        await removeTaskFromProject(ctx, op.taskId, op.toProjectId);
      }
      return;
    }
  }
}
