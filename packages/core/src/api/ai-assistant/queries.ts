// AI builder round 3 (experimental, feat/ai-builder-p3): the global assistant's reads. Every one runs as
// the signed-in person (their own client: RLS decides what they see), and only inside the Testing data
// pilot workspace the database says they administer. The page's context is loaded here from ids alone —
// names, sections, fields, people, tasks, and automations never come from the browser.
import {
  ASSISTANT_LIMITS,
  ASSISTANT_PAGE_LABELS,
  withRefs,
  type AssistantContext,
  type AssistantField,
  type AssistantPage,
  type AssistantPerson,
  type AssistantProject,
  type AssistantRule,
  type AssistantSection,
  type AssistantTask,
} from "../../ai-assistant";
import { aiPeople } from "../../ai-builder";
import { parseBlockerCounts } from "../../blocked-completion";
import type { FieldDef } from "../../fields";
import { isProjectRole, type ProjectRole } from "../../roles";
import { toFieldDef } from "../../row-mappers";
import { toRuleDef } from "../../rules";
import type { Json } from "../../supabase/database.types";
import { read, type ApiContext } from "../core/context";
import { maybe, rows } from "../core/db";
import { ApiError } from "../core/errors";
import { id } from "../core/validate";
import { listPilotMembers } from "../ai-builder/queries";
import type { AssistantRunSummary } from "./model";

export const NOT_PILOT_PAGE = "The AI assistant only works on projects of the Testing data workspace";

const chunk = <T,>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

type Loaded = {
  context: AssistantContext;
  fieldDefs: FieldDef[];
  label: string;
};

// The page's context for the model and the resolver. Throws forbidden when the page isn't in the pilot.
export async function loadAssistantContext(ctx: ApiContext, workspaceId: string, page: AssistantPage, today: string): Promise<Loaded> {
  const members = await listPilotMembers(ctx, workspaceId);
  const me = members.find((m) => m.me)?.id ?? null;
  if (!me) throw new ApiError("forbidden", NOT_PILOT_PAGE);
  const pilotIds = new Set(members.map((m) => m.id.toLowerCase()));

  // Every pilot project the person is a member of (RLS shows only those), with their own role.
  const projectRows = rows(
    await ctx.db
      .from("projects")
      .select("id, name, workspace_id, archived_at, sections_locked")
      .eq("workspace_id", id(workspaceId, "workspace"))
      .is("deleted_at", null)
      .order("name")
      .limit(200),
    "projects",
  );
  const projectIds = projectRows.map((p) => p.id);
  const memberRows = projectIds.length
    ? rows(
        await ctx.db.from("project_members").select("project_id, profile_id, role").in("project_id", projectIds).is("deleted_at", null),
        "project members",
      )
    : [];
  const roleOf = (projectId: string, archived: boolean): ProjectRole | null => {
    const role = memberRows.find((m) => m.project_id === projectId && m.profile_id === me)?.role;
    if (!isProjectRole(role)) return null;
    return archived ? "viewer" : role;
  };

  // Which project the page is about: the page's own, or the open task's (its top-level task's project in
  // the pilot), or the automation's.
  let focusId: string | null = page.projectId;
  let openTask: { id: string; parentId: string | null; rootId: string | null } | null = null;
  if (page.taskId) {
    const t = maybe(
      await ctx.db.from("tasks").select("id, parent_task_id, root_task_id, deleted_at").eq("id", id(page.taskId, "task")).maybeSingle(),
      "task",
    );
    if (!t || t.deleted_at) throw new ApiError("not_found", "That task isn’t available");
    openTask = { id: t.id, parentId: t.parent_task_id, rootId: t.root_task_id };
    const memberships = rows(
      await ctx.db.from("task_projects").select("project_id").eq("task_id", t.root_task_id ?? t.id).is("deleted_at", null),
      "task projects",
    ).map((m) => m.project_id);
    const inPilot = memberships.filter((p) => projectIds.includes(p));
    if (inPilot.length === 0) throw new ApiError("forbidden", NOT_PILOT_PAGE);
    if (!focusId || !inPilot.includes(focusId)) focusId = inPilot[0];
  }
  if (focusId && !projectIds.includes(focusId)) throw new ApiError("forbidden", NOT_PILOT_PAGE);
  if (page.ruleId) {
    const r = maybe(await ctx.db.from("rules").select("id, project_id, deleted_at").eq("id", id(page.ruleId, "rule")).maybeSingle(), "automation");
    if (!r || r.deleted_at || r.project_id !== focusId) throw new ApiError("not_found", "That automation isn’t available");
  }

  // Projects in a fixed order: the focus project first, then the rest by name (bounded).
  const ordered = [...projectRows].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0)).slice(0, ASSISTANT_LIMITS.contextProjectsMax);
  const includedIds = ordered.map((p) => p.id);
  const sectionRows = includedIds.length
    ? rows(
        await ctx.db.from("sections").select("id, name, project_id, sort_order").in("project_id", includedIds).is("deleted_at", null).order("sort_order"),
        "sections",
      )
    : [];
  const sections: Omit<AssistantSection, "ref">[] = sectionRows.map((s) => ({ id: s.id, projectId: s.project_id, name: s.name }));
  const projects: Omit<AssistantProject, "ref" | "sections">[] = ordered.map((p) => ({
    id: p.id,
    name: p.name,
    role: roleOf(p.id, Boolean(p.archived_at)),
    archived: Boolean(p.archived_at),
    sectionsLocked: Boolean(p.sections_locked),
    memberIds: memberRows.filter((m) => m.project_id === p.id && pilotIds.has(m.profile_id.toLowerCase())).map((m) => m.profile_id.toLowerCase()),
  }));

  // Tasks: the focus project's top-level tasks (open ones first, in section order), the open task with
  // its parent and subtasks; on My tasks, the person's own open tasks in pilot projects.
  const sectionOrder = new Map(sectionRows.map((s, i) => [s.id, i]));
  const taskColumns = "id, title, notes, assignee_id, due_on, start_on, completed_at, kind, recurrence, parent_task_id, root_task_id, deleted_at";
  type TaskRow = {
    id: string;
    title: string;
    notes: string | null;
    assignee_id: string | null;
    due_on: string | null;
    start_on: string | null;
    completed_at: string | null;
    kind: string;
    recurrence: Json | null;
    parent_task_id: string | null;
    root_task_id: string | null;
    deleted_at: string | null;
  };
  const picked: { row: TaskRow; projectId: string; sectionId: string | null; sortOrder: number | null }[] = [];
  const add = (row: TaskRow, projectId: string, sectionId: string | null, sortOrder: number | null) => {
    if (row.deleted_at || picked.some((p) => p.row.id === row.id)) return;
    picked.push({ row, projectId, sectionId, sortOrder });
  };

  if (page.kind === "my_tasks") {
    const mine = rows(
      await ctx.db.from("tasks").select(taskColumns).eq("assignee_id", me).is("completed_at", null).is("deleted_at", null).order("due_on", { ascending: true, nullsFirst: false }).limit(200),
      "my tasks",
    ) as TaskRow[];
    const roots = [...new Set(mine.map((t) => t.root_task_id ?? t.id))];
    const memberships: { task_id: string; project_id: string; section_id: string | null; sort_order: number }[] = [];
    for (const part of chunk(roots, 200)) {
      memberships.push(
        ...rows(await ctx.db.from("task_projects").select("task_id, project_id, section_id, sort_order").in("task_id", part).in("project_id", includedIds).is("deleted_at", null), "task projects"),
      );
    }
    for (const t of mine) {
      const m = memberships.find((x) => x.task_id === (t.root_task_id ?? t.id));
      if (!m) continue;
      add(t, m.project_id, t.root_task_id ? null : m.section_id, t.root_task_id ? null : m.sort_order);
      if (picked.length >= ASSISTANT_LIMITS.contextTasksMax) break;
    }
  } else if (focusId) {
    const list = rows(
      await ctx.db
        .from("task_projects")
        .select(`task_id, section_id, sort_order, tasks!inner(${taskColumns})`)
        .eq("project_id", focusId)
        .is("deleted_at", null)
        .is("tasks.deleted_at", null)
        .is("tasks.parent_task_id", null)
        .limit(500),
      "tasks",
    ) as unknown as { task_id: string; section_id: string | null; sort_order: number; tasks: TaskRow }[];
    list.sort(
      (a, b) =>
        Number(Boolean(a.tasks.completed_at)) - Number(Boolean(b.tasks.completed_at)) ||
        (sectionOrder.get(a.section_id ?? "") ?? -1) - (sectionOrder.get(b.section_id ?? "") ?? -1) ||
        a.sort_order - b.sort_order,
    );
    const firstTasks = list.slice(0, ASSISTANT_LIMITS.contextTasksMax);
    if (openTask) {
      const rootId = openTask.rootId ?? openTask.id;
      const root = list.find((x) => x.task_id === rootId);
      if (root) add(root.tasks, focusId, root.section_id, root.sort_order);
      const extra = rows(
        await ctx.db
          .from("tasks")
          .select(taskColumns)
          .or(`id.eq.${openTask.id},parent_task_id.eq.${openTask.id}${openTask.parentId ? `,id.eq.${openTask.parentId}` : ""}`)
          .is("deleted_at", null)
          .limit(ASSISTANT_LIMITS.contextSubtasksMax + 2),
        "subtasks",
      ) as TaskRow[];
      extra.sort((a, b) => Number(a.id !== openTask!.id) - Number(b.id !== openTask!.id));
      for (const t of extra) {
        const top = !t.parent_task_id ? list.find((x) => x.task_id === t.id) : undefined;
        add(t, focusId, top?.section_id ?? null, top?.sort_order ?? null);
      }
    }
    for (const x of firstTasks) add(x.tasks, focusId, x.section_id, x.sort_order);
  }

  const taskIds = picked.map((p) => p.row.id);
  // Fields of the focus project (and, on My tasks, of the tasks' projects).
  const fieldProjectIds = [...new Set([focusId, ...picked.map((p) => p.projectId)].filter((x): x is string => Boolean(x)))].slice(0, 10);
  const fieldRows = fieldProjectIds.length
    ? rows(await ctx.db.from("custom_fields").select("*").in("project_id", fieldProjectIds).is("deleted_at", null).order("sort_order"), "fields")
    : [];
  const fieldDefs = fieldRows.map(toFieldDef);
  const fields: Omit<AssistantField, "ref">[] = fieldRows.map((f) => ({
    id: f.id,
    projectId: f.project_id,
    name: f.name,
    fieldType: f.field_type,
    options: (Array.isArray(f.options) ? f.options : []).flatMap((o) =>
      o && typeof o === "object" && !Array.isArray(o) && typeof o.id === "string" && typeof o.name === "string" ? [{ id: o.id, name: o.name }] : [],
    ),
    boundToSections: Boolean(f.bound_to_sections),
    locked: Boolean((f as { locked?: boolean }).locked),
  }));
  const valueRows: { task_id: string; field_id: string; value: Json }[] = [];
  for (const part of chunk(taskIds, 200)) {
    if (!part.length || !fields.length) break;
    valueRows.push(...rows(await ctx.db.from("task_field_values").select("task_id, field_id, value").in("task_id", part).in("field_id", fields.map((f) => f.id)), "field values"));
  }
  const blockers = taskIds.length ? parseBlockerCounts((await ctx.db.rpc("open_blocker_counts", { task_ids: taskIds })).data ?? null) : new Map<string, number>();

  const tasks: Omit<AssistantTask, "ref">[] = picked.map(({ row, projectId, sectionId, sortOrder }) => ({
    id: row.id,
    title: row.title,
    notes: row.notes,
    projectId,
    sectionId,
    sortOrder,
    parentId: row.parent_task_id,
    assigneeId: row.assignee_id ? row.assignee_id.toLowerCase() : null,
    dueOn: row.due_on,
    startOn: row.start_on,
    completed: Boolean(row.completed_at),
    kind: row.kind,
    recurring: row.recurrence != null,
    openBlockers: blockers.get(row.id) ?? 0,
    values: Object.fromEntries(valueRows.filter((v) => v.task_id === row.id).map((v) => [v.field_id, v.value])),
  }));

  // Automations of the focus project (for rule pages and any page of a project).
  const ruleRows = focusId
    ? rows(
        await ctx.db
          .from("rules")
          .select("id, project_id, name, enabled, trigger_type, trigger_config, conditions, actions, preset_key")
          .eq("project_id", focusId)
          .is("deleted_at", null)
          .order("sort_order")
          .limit(ASSISTANT_LIMITS.contextRulesMax),
        "automations",
      )
    : [];
  const rules: Omit<AssistantRule, "ref">[] = ruleRows.map((r) => {
    const def = toRuleDef(r);
    // The stored trigger type as is (an unknown one makes the automation not editable).
    return { id: def.id, projectId: def.projectId, name: def.name, enabled: def.enabled, triggerType: r.trigger_type, triggerConfig: def.triggerConfig, conditions: def.conditions, actions: def.actions };
  });

  const people: AssistantPerson[] = aiPeople(members.map((m) => m.id), me).map((p) => ({ ...p, name: members.find((m) => m.id.toLowerCase() === p.id)?.name ?? "someone" }));

  const context = withRefs({
    page: page.kind,
    today,
    currentProjectId: focusId,
    openTaskId: openTask?.id ?? null,
    openRuleId: page.ruleId,
    projects,
    sections,
    fields,
    tasks,
    rules,
    people,
  });
  const focusName = ordered.find((p) => p.id === focusId)?.name;
  const openTitle = openTask ? tasks.find((t) => t.id === openTask!.id)?.title : null;
  const label =
    page.kind === "task" && openTitle
      ? `Task “${openTitle}”${focusName ? ` in ${focusName}` : ""}`
      : page.kind === "rule"
        ? `Automation “${rules.find((r) => r.id === page.ruleId)?.name ?? ""}” in ${focusName ?? "this project"}`
        : page.kind === "rules"
          ? `Automations of ${focusName ?? "this project"}`
          : focusName
            ? `Project ${focusName}`
            : ASSISTANT_PAGE_LABELS[page.kind].replace(/^./, (c) => c.toUpperCase());
  return { context, fieldDefs, label };
}

export async function getAssistantRunRow(ctx: ApiContext, runId: string) {
  return maybe(
    await ctx.db
      .from("ai_assistant_runs")
      .select("id, workspace_id, actor_id, status, proposal, apply_key, applied, page_kind")
      .eq("id", id(runId, "run"))
      .maybeSingle(),
    "AI assistant run",
  );
}

// The pilot's assistant runs, newest first (every pilot admin reads them; only the actor applies or undoes).
export const listAssistantRuns = read(async (ctx: ApiContext, workspaceId: string, viewerId: string | null): Promise<AssistantRunSummary[]> =>
  rows(
    await ctx.db
      .from("ai_assistant_runs")
      .select("id, actor_id, status, page_kind, model, effort, route_reason, escalated, op_count, ops_summary, input_tokens, output_tokens, error_code, error_detail, created_at, applied_at, undone_at")
      .eq("workspace_id", id(workspaceId, "workspace"))
      .order("created_at", { ascending: false })
      .limit(50),
    "AI assistant history",
  ).map((r) => ({
    id: r.id,
    mine: r.actor_id === viewerId,
    status: r.status,
    pageKind: r.page_kind,
    model: r.model,
    effort: r.effort,
    routeReason: r.route_reason,
    escalated: r.escalated,
    opCount: r.op_count,
    opsSummary: r.ops_summary && typeof r.ops_summary === "object" && !Array.isArray(r.ops_summary) ? (r.ops_summary as Record<string, number>) : {},
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
    createdAt: r.created_at,
    appliedAt: r.applied_at,
    undoneAt: r.undone_at,
  })),
);
