// AI builder round 5 (note 178): what every tool handler shares — names → ids (refs the model was shown, or
// ids over MCP), people ("me", aliases, names; an ambiguous name becomes a question for the person, never
// a guess), loading more of the workspace into the context when a lookup or an MCP call names it, and the
// role check (the registry's capabilityRefusal) at stage time and again just before every write.
//
// Everything is read with the person's own context (RLS decides what exists for them) and only inside the
// Testing data pilot workspace.
import { ASSISTANT_LIMITS, type AssistantField, type AssistantProject, type AssistantRule, type AssistantSection, type AssistantTask } from "../../ai-assistant";
import { matchPeople, type RuleNames } from "../../ai-rule-steps";
import { capabilityRefusal, REF_PREFIX, toolMeta, type CapabilityFacts, type RefKind, type ToolName } from "../../ai-tools";
import { parseBlockerCounts } from "../../blocked-completion";
import { isProjectRole, type ProjectRole } from "../../roles";
import { toRuleDef } from "../../rules";
import type { Json } from "../../supabase/database.types";
import type { ApiContext } from "../core/context";
import { maybe, rows } from "../core/db";
import { ApiError } from "../core/errors";
import { listProjectFieldSharing } from "../fields/queries";
import { refuse, ToolQuestion, ToolRefusal, type OpState, type Provisional, type StagedOp, type ToolEnv } from "./types";

export const NOT_PILOT = "The AI only works on things of the Testing data workspace";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const lower = (v: string) => v.toLowerCase();
export const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
export const quote = (v: string | null | undefined) => (v ? `“${v}”` : "—");

// ---- Refs ---------------------------------------------------------------------------------------------

function nextRef(env: ToolEnv, kind: RefKind): string {
  const prefix = REF_PREFIX[kind];
  const taken = new Set<string>([
    ...env.context.projects.map((p) => p.ref),
    ...env.context.projects.flatMap((p) => p.sections.map((s) => s.ref)),
    ...env.context.fields.map((f) => f.ref),
    ...env.context.tasks.map((t) => t.ref),
    ...env.context.rules.map((r) => r.ref),
    ...env.refs.keys(),
  ]);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

// A generic ref for something the model is shown (a comment, a tag, a view, …). Same id → same ref.
export function refFor(env: ToolEnv, kind: RefKind, id: string, label: string): string {
  if (env.audience === "mcp") return id;
  for (const [ref, v] of env.refs) if (v.kind === kind && v.id === id) return ref;
  const ref = nextRef(env, kind);
  env.refs.set(ref, { kind, id, label });
  return ref;
}

// A provisional ref for what change `index` will make ("T+2"), usable by later changes of the same set.
export function provisionalRef(env: ToolEnv, kind: RefKind, index: number, label: string): string {
  const ref = `${REF_PREFIX[kind]}+${index + 1}`;
  env.provisional.set(lower(ref), { kind, index, label });
  return ref;
}
export const placeholder = (index: number) => `$op:${index}`;
export function provisional(env: ToolEnv, kind: RefKind, value: unknown): Provisional | null {
  const p = env.provisional.get(lower(clean(value)));
  return p && p.kind === kind ? p : null;
}

// A generic ref (or, over MCP, an id) → its id. `load` reads the label (and checks it exists) for an id.
export async function refArg(
  env: ToolEnv,
  kind: RefKind,
  value: unknown,
  what: string,
  load?: (id: string) => Promise<string | null>,
): Promise<{ id: string; label: string }> {
  const v = clean(value);
  if (!v) refuse(`${what}: say which ${kind.replace(/_/g, " ")}`);
  const hit = env.refs.get(v.toUpperCase()) ?? env.refs.get(v);
  if (hit && hit.kind === kind) return { id: hit.id, label: hit.label };
  if (env.audience === "mcp" && isUuid(v)) {
    const label = load ? await load(v.toLowerCase()) : v;
    if (label === null) refuse(`${what}: no such ${kind.replace(/_/g, " ")} (or you can’t open it)`);
    return { id: v.toLowerCase(), label: label ?? v };
  }
  return refuse(`${what}: that ${kind.replace(/_/g, " ")} isn’t known here — look it up first`);
}

// ---- Core entities (projects, sections, fields, tasks, automations) ----------------------------------

export async function projectArg(env: ToolEnv, value: unknown, what: string): Promise<AssistantProject> {
  const v = clean(value);
  const byRef = env.context.projects.find((p) => lower(p.ref) === lower(v) || p.id === lower(v));
  if (byRef) return byRef;
  if (v && env.audience === "mcp" && isUuid(v)) {
    await loadProjects(env, [v.toLowerCase()]);
    const p = env.context.projects.find((x) => x.id === v.toLowerCase());
    if (p) return p;
  }
  if (v && env.audience === "assistant") {
    const named = env.context.projects.filter((p) => lower(p.name) === lower(v));
    if (named.length === 1) return named[0];
  }
  return refuse(`${what}: that project isn’t one you can change here`);
}

export function currentProject(env: ToolEnv): AssistantProject | null {
  return env.context.projects.find((p) => p.id === env.context.currentProjectId) ?? null;
}

// A section of `projectId`: a ref, its name, or (`allowNew`) one a change of this set makes.
export function sectionArg(env: ToolEnv, value: unknown, projectId: string | null, what: string, allowNew = false): AssistantSection | Provisional {
  const v = clean(value);
  if (allowNew) {
    const p = provisional(env, "section", v);
    if (p) return p;
    // A section made earlier in this set, by its name.
    for (const [ref, pv] of env.provisional) if (pv.kind === "section" && lower(pv.label) === lower(v) && env.staged[pv.index]?.projectId === projectId) return env.provisional.get(ref)!;
  }
  const all = env.context.projects.flatMap((p) => p.sections);
  const byRef = all.find((s) => lower(s.ref) === lower(v) || s.id === lower(v));
  if (byRef) {
    if (projectId && byRef.projectId !== projectId) refuse(`${what}: that section is in another project`);
    return byRef;
  }
  const named = all.filter((s) => lower(s.name) === lower(v) && (!projectId || s.projectId === projectId));
  if (named.length === 1) return named[0];
  return refuse(`${what}: ${projectId ? "that project has" : "there’s"} no section “${v}”`);
}
export const isProvisional = (x: unknown): x is Provisional => Boolean(x) && typeof x === "object" && "index" in (x as object) && "kind" in (x as object);

export async function taskArg(env: ToolEnv, value: unknown, what: string, opts: { allowNew?: boolean; deleted?: boolean } = {}): Promise<AssistantTask | Provisional> {
  const v = clean(value);
  if (opts.allowNew) {
    const p = provisional(env, "task", v);
    if (p) return p;
  }
  const hit = env.context.tasks.find((t) => lower(t.ref) === lower(v) || t.id === lower(v));
  if (hit) return hit;
  if (v && env.audience === "mcp" && isUuid(v)) {
    await loadTasks(env, [v.toLowerCase()], { deleted: opts.deleted });
    const t = env.context.tasks.find((x) => x.id === v.toLowerCase());
    if (t) return t;
  }
  return refuse(`${what}: that task isn’t on this page — look it up first (search_tasks)`);
}
export async function existingTask(env: ToolEnv, value: unknown, what: string, opts: { deleted?: boolean } = {}): Promise<AssistantTask> {
  const t = await taskArg(env, value, what, opts);
  if (isProvisional(t)) return refuse(`${what}: that task is made by this change set; change it after`);
  return t;
}

export async function fieldArg(env: ToolEnv, value: unknown, projectId: string | null, what: string): Promise<AssistantField> {
  const v = clean(value);
  if (env.audience === "mcp" && isUuid(v) && !env.context.fields.some((f) => f.id === lower(v))) {
    const f = maybe(await env.ctx.db.from("custom_fields").select("project_id").eq("id", lower(v)).maybeSingle(), "field");
    if (f?.project_id) await loadProjects(env, [f.project_id]);
  }
  const list = env.context.fields.filter((f) => !projectId || f.projectId === projectId);
  const hit = list.find((f) => lower(f.ref) === lower(v) || f.id === lower(v)) ?? (list.filter((f) => lower(f.name) === lower(v)).length === 1 ? list.find((f) => lower(f.name) === lower(v)) : undefined);
  return hit ?? refuse(`${what}: ${projectId ? "that project has" : "there’s"} no field “${v}”`);
}

export async function ruleArg(env: ToolEnv, value: unknown, what: string): Promise<AssistantRule> {
  const v = clean(value);
  let hit = env.context.rules.find((r) => lower(r.ref) === lower(v) || r.id === lower(v));
  if (!hit && env.audience === "mcp" && isUuid(v)) {
    const r = maybe(await env.ctx.db.from("rules").select("project_id").eq("id", lower(v)).is("deleted_at", null).maybeSingle(), "automation");
    if (r?.project_id) {
      await loadProjects(env, [r.project_id]);
      await loadRules(env, r.project_id);
      hit = env.context.rules.find((x) => x.id === lower(v));
    }
  }
  return hit ?? refuse(`${what}: that automation isn’t on this page`);
}

// ---- People -----------------------------------------------------------------------------------------

// "me", an alias, an id (MCP), or a name (unique among the pilot's people; several → a question for the
// person, with the candidates shown only in the panel). `among` limits who may be picked (a project's
// members); "none" → null when `allowNone`.
export function personArg(env: ToolEnv, value: unknown, what: string, opts: { among?: readonly string[]; allowNone?: boolean; amongLabel?: string } = {}): string | null {
  const v = clean(value);
  const l = lower(v);
  if (!v) return refuse(`${what}: say who`);
  if (["none", "nobody", "no one", "unassigned"].includes(l)) return opts.allowNone ? null : refuse(`${what}: say who`);
  let id: string | null = null;
  if (["me", "myself", "i", "you"].includes(l)) id = env.me;
  else if (env.people.some((p) => p.alias === l)) id = env.people.find((p) => p.alias === l)!.id;
  else if (isUuid(v) && env.people.some((p) => p.id === l)) id = l;
  else {
    const pool = opts.among ? env.people.filter((p) => opts.among!.includes(p.id)) : env.people;
    const hits = matchPeople(v, pool);
    if (hits.length === 1) id = hits[0].id;
    else if (hits.length > 1) {
      throw new ToolQuestion(
        { text: `Which ${v} did you mean?`, options: hits.slice(0, 8).map((p) => p.name) },
        `${what}: “${v}” matches more than one person; the user will be asked which one (don't guess).`,
      );
    } else if (matchPeople(v, env.people).length && opts.among) {
      return refuse(`${what}: “${v}” isn’t ${opts.amongLabel ?? "someone who can be picked here"}`);
    } else return refuse(`${what}: nobody called “${v}” is in the Testing data workspace`);
  }
  if (opts.among && !opts.among.includes(id!)) return refuse(`${what}: ${personName(env, id)} isn’t ${opts.amongLabel ?? "someone who can be picked here"}`);
  return id;
}

export const personName = (env: ToolEnv, id: string | null) => (id ? (id === env.me ? `${env.people.find((p) => p.id === id)?.name ?? "you"} (you)` : (env.people.find((p) => p.id === id)?.name ?? "someone")) : "nobody");

// Names for automation steps in a project (sections, fields, people, tags, other projects, forms, …).
export async function ruleNamesFor(env: ToolEnv, projectId: string | null, system: "project" | "my_tasks" | "portfolio", portfolioId?: string | null): Promise<RuleNames> {
  const project = projectId ? env.context.projects.find((p) => p.id === projectId) : null;
  const pilotIds = new Set(env.people.map((p) => p.id));
  const memberIds = project ? project.memberIds : [...pilotIds];
  const people = env.people.filter((p) => memberIds.includes(p.id) || system !== "project").map((p) => ({ id: p.id, alias: p.alias, name: p.name }));
  const fields = system === "portfolio" && portfolioId
    ? rows(await env.ctx.db.from("portfolio_fields").select("id, name, field_type, options").eq("portfolio_id", portfolioId).is("deleted_at", null), "portfolio fields").map((f) => ({
        id: f.id,
        name: f.name,
        fieldType: f.field_type,
        options: optionList(f.options),
      }))
    : env.context.fields.filter((f) => f.projectId === projectId).map((f) => ({ id: f.id, name: f.name, fieldType: f.fieldType, boundToSections: f.boundToSections, options: f.options }));
  const tags = rows(await env.ctx.db.from("tags").select("id, name").eq("workspace_id", env.workspaceId).is("deleted_at", null).is("archived_at", null).limit(500), "tags");
  const forms = projectId ? rows(await env.ctx.db.from("forms").select("id, title").eq("project_id", projectId).is("deleted_at", null), "forms").map((f) => ({ id: f.id, name: f.title })) : [];
  const roles = projectId ? rows(await env.ctx.db.from("project_roles").select("id, name").eq("project_id", projectId).is("deleted_at", null), "project roles") : [];
  const taskTemplates = projectId ? rows(await env.ctx.db.from("task_templates").select("id, name").eq("project_id", projectId).is("deleted_at", null), "task templates") : [];
  const mySections = system === "my_tasks" ? rows(await env.ctx.db.from("my_task_sections").select("id, name").eq("profile_id", env.me).is("deleted_at", null), "my sections") : [];
  const portfolios = rows(await env.ctx.db.from("portfolios").select("id, name").eq("workspace_id", env.workspaceId).is("deleted_at", null).limit(200), "portfolios");
  return {
    sections: project?.sections.map((s) => ({ id: s.id, name: s.name, ref: s.ref })) ?? [],
    sectionsOf: (pid) => env.context.projects.find((p) => p.id === pid)?.sections.map((s) => ({ id: s.id, name: s.name, ref: s.ref })) ?? [],
    mySections,
    fields,
    people,
    tags,
    projects: env.context.projects.map((p) => ({ id: p.id, name: p.name, ref: p.ref })),
    forms,
    taskTemplates,
    portfolios,
    roles,
  };
}

export const optionList = (raw: Json | null | undefined) =>
  (Array.isArray(raw) ? raw : []).flatMap((o) =>
    o && typeof o === "object" && !Array.isArray(o) && typeof o.id === "string" && typeof o.name === "string"
      ? [{ id: o.id, name: o.name, ...(typeof o.color === "string" ? { color: o.color } : {}) }]
      : [],
  );

// ---- Loading more into the context -----------------------------------------------------------------

export async function loadProjects(env: ToolEnv, ids: string[]): Promise<void> {
  const want = ids.map(lower).filter((id) => !env.context.projects.some((p) => p.id === id));
  if (!want.length) return;
  const projectRows = rows(
    await env.ctx.db.from("projects").select("id, name, workspace_id, archived_at, sections_locked").in("id", want).eq("workspace_id", env.workspaceId).is("deleted_at", null),
    "projects",
  );
  if (!projectRows.length) return;
  const pids = projectRows.map((p) => p.id);
  const members = rows(await env.ctx.db.from("project_members").select("project_id, profile_id, role").in("project_id", pids).is("deleted_at", null), "members");
  const pilot = new Set(env.people.map((p) => p.id));
  const sections = rows(await env.ctx.db.from("sections").select("id, name, project_id, sort_order").in("project_id", pids).is("deleted_at", null).order("sort_order"), "sections");
  const fieldRows = rows(await env.ctx.db.from("custom_fields").select("*").in("project_id", pids).is("deleted_at", null).order("sort_order"), "fields");
  for (const p of projectRows) {
    const role = members.find((m) => m.project_id === p.id && lower(m.profile_id) === env.me)?.role;
    if (!isProjectRole(role)) continue;
    const project: AssistantProject = {
      ref: env.audience === "mcp" ? p.id : nextRef(env, "project"),
      id: p.id,
      name: p.name,
      role: (p.archived_at ? "viewer" : role) as ProjectRole,
      archived: Boolean(p.archived_at),
      sectionsLocked: Boolean(p.sections_locked),
      sections: [],
      memberIds: members.filter((m) => m.project_id === p.id && pilot.has(lower(m.profile_id))).map((m) => lower(m.profile_id)),
    };
    env.context.projects.push(project);
    for (const s of sections.filter((x) => x.project_id === p.id).slice(0, ASSISTANT_LIMITS.contextSectionsPerProject * 2)) {
      project.sections.push({ ref: env.audience === "mcp" ? s.id : nextRef(env, "section"), id: s.id, projectId: p.id, name: s.name });
    }
    const sharing = await listProjectFieldSharing(env.ctx, p.id).catch(() => null);
    for (const f of fieldRows.filter((x) => x.project_id === p.id)) {
      const share = sharing?.[f.id] ?? null;
      const libraryFieldId = (f as { library_field_id?: string | null }).library_field_id ?? null;
      env.context.fields.push({
        ref: env.audience === "mcp" ? f.id : nextRef(env, "field"),
        id: f.id,
        projectId: f.project_id,
        name: f.name,
        fieldType: f.field_type,
        options: optionList(f.options),
        boundToSections: Boolean(f.bound_to_sections),
        locked: Boolean((f as { locked?: boolean }).locked),
        shared: Boolean(libraryFieldId || share?.isShared || share?.libraryFieldId),
        definitionEditable: share ? share.definitionEditable : null,
        definitionManageable: share ? share.definitionManageable : null,
      });
    }
  }
}

const TASK_COLUMNS = "id, title, notes, assignee_id, due_on, start_on, completed_at, kind, recurrence, parent_task_id, root_task_id, deleted_at";
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

// Tasks (by id) into the context, each with its pilot project (the page's own first), section, values,
// and open blockers. A task outside the pilot (or one the person can't read) isn't added.
export async function loadTasks(env: ToolEnv, ids: string[], opts: { deleted?: boolean } = {}): Promise<AssistantTask[]> {
  const want = [...new Set(ids.map(lower))].filter((id) => !env.context.tasks.some((t) => t.id === id)).slice(0, 100);
  if (want.length) {
    let q = env.ctx.db.from("tasks").select(TASK_COLUMNS).in("id", want);
    if (!opts.deleted) q = q.is("deleted_at", null);
    const list = rows(await q, "tasks") as TaskRow[];
    const roots = [...new Set(list.map((t) => t.root_task_id ?? t.id))];
    const memberships = roots.length
      ? rows(await env.ctx.db.from("task_projects").select("task_id, project_id, section_id, sort_order").in("task_id", roots).is("deleted_at", null), "task projects")
      : [];
    await loadProjects(env, [...new Set(memberships.map((m) => m.project_id))]);
    const known = new Set(env.context.projects.map((p) => p.id));
    const blockers = parseBlockerCounts((await env.ctx.db.rpc("open_blocker_counts", { task_ids: list.map((t) => t.id) })).data ?? null);
    const fields = env.context.fields;
    const values = list.length && fields.length
      ? rows(await env.ctx.db.from("task_field_values").select("task_id, field_id, value").in("task_id", list.map((t) => t.id)).in("field_id", fields.map((f) => f.id)), "field values")
      : [];
    for (const t of list) {
      const root = t.root_task_id ?? t.id;
      const mine = memberships.filter((m) => m.task_id === root && known.has(m.project_id));
      const m = mine.find((x) => x.project_id === env.context.currentProjectId) ?? mine[0];
      if (!m) continue;
      env.context.tasks.push({
        ref: env.audience === "mcp" ? t.id : nextRef(env, "task"),
        id: t.id,
        title: t.title,
        notes: t.notes,
        projectId: m.project_id,
        sectionId: t.root_task_id ? null : m.section_id,
        sortOrder: t.root_task_id ? null : m.sort_order,
        parentId: t.parent_task_id,
        assigneeId: t.assignee_id ? lower(t.assignee_id) : null,
        dueOn: t.due_on,
        startOn: t.start_on,
        completed: Boolean(t.completed_at),
        kind: t.kind,
        recurring: t.recurrence != null,
        openBlockers: blockers.get(t.id) ?? 0,
        values: Object.fromEntries(values.filter((v) => v.task_id === t.id).map((v) => [v.field_id, v.value as Json])),
      });
    }
  }
  return ids.map((id) => env.context.tasks.find((t) => t.id === lower(id))).filter((t): t is AssistantTask => Boolean(t));
}

export async function loadRules(env: ToolEnv, projectId: string): Promise<void> {
  const ruleRows = rows(
    await env.ctx.db.from("rules").select("id, project_id, name, enabled, trigger_type, trigger_config, conditions, actions, preset_key").eq("project_id", projectId).is("deleted_at", null).order("sort_order").limit(100),
    "automations",
  );
  for (const r of ruleRows) {
    if (env.context.rules.some((x) => x.id === r.id)) continue;
    const def = toRuleDef(r);
    env.context.rules.push({ ref: env.audience === "mcp" ? r.id : nextRef(env, "rule"), id: def.id, projectId: def.projectId, name: def.name, enabled: def.enabled, triggerType: r.trigger_type, triggerConfig: def.triggerConfig, conditions: def.conditions, actions: def.actions });
  }
}

// ---- Permission ---------------------------------------------------------------------------------------

// The role check at stage time, from the context (the same rule as by hand).
export function allowedIn(env: ToolEnv, tool: ToolName, projectId: string, what: string, field?: AssistantField | null): AssistantProject {
  const p = env.context.projects.find((x) => x.id === projectId) ?? refuse(`${what}: that project isn’t one you can change here`);
  const why = capabilityRefusal(tool, facts(p, field));
  if (why) refuse(`${what}: ${why}`);
  return p;
}

export function facts(p: Pick<AssistantProject, "name" | "role" | "archived" | "sectionsLocked">, field?: AssistantField | null): CapabilityFacts {
  return {
    projectName: p.name,
    role: p.role,
    archived: p.archived,
    sectionsLocked: p.sectionsLocked,
    ...(field
      ? { field: { name: field.name, locked: field.locked, boundToSections: field.boundToSections, shared: Boolean(field.shared), definitionEditable: field.definitionEditable ?? null, definitionManageable: field.definitionManageable ?? null } }
      : {}),
  };
}

// A pilot project as the role table reads it now (archived = Viewer), or a refusal when it isn't one.
export async function projectFactsNow(ctx: ApiContext, workspaceId: string, projectId: string): Promise<CapabilityFacts> {
  const p = maybe(await ctx.db.from("projects").select("id, name, workspace_id, archived_at, sections_locked, deleted_at").eq("id", projectId).maybeSingle(), "project");
  if (!p || p.deleted_at || p.workspace_id !== workspaceId) throw new ApiError("forbidden", NOT_PILOT);
  const role = (await ctx.db.rpc("project_role", { target_project: projectId })).data;
  if (!isProjectRole(role)) throw new ApiError("forbidden", "You’re not a member of that project any more");
  return { projectName: p.name as string, role: (p.archived_at ? "viewer" : role) as ProjectRole, archived: Boolean(p.archived_at), sectionsLocked: Boolean(p.sections_locked) };
}

export async function fieldFactsNow(ctx: ApiContext, fieldId: string, projectId: string, allowRemoved: boolean): Promise<NonNullable<CapabilityFacts["field"]>> {
  const f = maybe(await ctx.db.from("custom_fields").select("project_id, name, locked, bound_to_sections, library_field_id, deleted_at").eq("id", fieldId).maybeSingle(), "field");
  if (!f || f.project_id !== projectId || (f.deleted_at && !allowRemoved)) throw new ApiError("forbidden", "That field isn’t in this project any more");
  const sharing = (await listProjectFieldSharing(ctx, projectId).catch(() => null))?.[fieldId] ?? null;
  return {
    name: f.name,
    locked: Boolean(f.locked),
    boundToSections: Boolean(f.bound_to_sections),
    shared: Boolean(f.library_field_id || sharing?.isShared || sharing?.libraryFieldId),
    definitionEditable: sharing ? sharing.definitionEditable : null,
    definitionManageable: sharing ? sharing.definitionManageable : null,
  };
}

// The role check again against the database just before a write (and before Undo): every project the
// change touches is a live pilot project where the registry's rule allows it.
export async function checkScopeNow(ctx: ApiContext, workspaceId: string, op: StagedOp, opts: { undoing: boolean }): Promise<void> {
  const meta = toolMeta(op.op);
  if (meta.scope !== "project") return;
  for (const projectId of op.projects) {
    const f = await projectFactsNow(ctx, workspaceId, projectId);
    const fieldId = typeof op.args.field_id === "string" && !op.args.field_id.startsWith("$op:") ? op.args.field_id : null;
    if (fieldId && projectId === op.projectId) f.field = await fieldFactsNow(ctx, fieldId, projectId, opts.undoing);
    const why = capabilityRefusal(op.op, f);
    if (why) throw new ApiError("forbidden", why.charAt(0).toUpperCase() + why.slice(1));
  }
}

// A task's project membership now (the task — a subtask's top-level task — still in that project).
export async function taskInProjectNow(ctx: ApiContext, taskId: string, projectId: string, opts: { deleted?: boolean } = {}) {
  const t = maybe(await ctx.db.from("tasks").select("id, root_task_id, kind, deleted_at").eq("id", taskId).maybeSingle(), "task");
  if (!t || (t.deleted_at && !opts.deleted)) throw new ApiError("not_found", "That task isn’t available any more");
  const m = maybe(await ctx.db.from("task_projects").select("task_id").eq("task_id", t.root_task_id ?? t.id).eq("project_id", projectId).is("deleted_at", null).maybeSingle(), "task project");
  if (!m) throw new ApiError("forbidden", "That task isn’t in this project any more");
  return t;
}

// ---- Building a staged change ------------------------------------------------------------------------

export function staged(
  tool: ToolName,
  projectId: string | null,
  label: string,
  before: string,
  after: string,
  args: Record<string, Json>,
  extra: Partial<Pick<StagedOp, "projects" | "dependsOn" | "count" | "notifies" | "destructive" | "noUndo" | "system" | "rule" | "previous" | "expect">> = {},
): StagedOp {
  const meta = toolMeta(tool);
  return {
    op: tool,
    group: meta.group,
    projectId,
    projects: extra.projects ?? (projectId ? [projectId] : []),
    label,
    before,
    after,
    expect: extra.expect ?? null,
    args,
    dependsOn: extra.dependsOn ?? [],
    destructive: extra.destructive ?? Boolean(meta.destructive),
    notifies: extra.notifies ?? null,
    noUndo: extra.noUndo ?? meta.undo === "no",
    ...(extra.count !== undefined ? { count: extra.count } : {}),
    ...(extra.system ? { system: extra.system } : {}),
    ...(extra.rule ? { rule: extra.rule } : {}),
    ...(extra.previous ? { previous: extra.previous } : {}),
  };
}

// "$op:N" placeholders → the ids earlier changes made.
export function resolveArgs(args: Record<string, Json>, createdBy: Map<number, string>): Record<string, Json> {
  const swap = (v: Json): Json => {
    if (typeof v === "string" && v.startsWith("$op:")) {
      const id = createdBy.get(Number(v.slice(4)));
      if (!id) throw new ApiError("invalid", "Something an earlier change makes wasn’t made, so this change can’t follow");
      return id;
    }
    return Array.isArray(v) ? v.map(swap) : v;
  };
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, swap(v)]));
}

export const str = (args: Record<string, Json>, key: string) => (typeof args[key] === "string" ? (args[key] as string) : null);
export const strs = (args: Record<string, Json>, key: string) => (Array.isArray(args[key]) ? (args[key] as Json[]).filter((x): x is string => typeof x === "string") : []);
export const isRefusal = (e: unknown) => e instanceof ToolRefusal;
export type { OpState };
