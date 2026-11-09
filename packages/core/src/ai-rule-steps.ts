// AI builder round 5 (experimental, branch feat/ai-builder-p5, notes 177 / 178): the AI's automations in the
// FULL vocabulary of the rules engines — project automations (rules.ts), My Tasks automations
// (my-task-rules.ts), and portfolio automations (portfolio-rules.ts) — through the one description of every
// step's settings the rule builders already use (rule-params.ts). Pure: no network, no database.
//
// The model writes a step as { type, <setting key>: <value>, … } with the engine's own setting keys, and
// names instead of ids: a section, field, option, tag, form, template, or project by its name (or its ref,
// S3 / F2 / P1), people by alias ("member:1"), by name, or "me" / "assignee" / "creator". stepFromModel()
// turns the names into ids through a resolver the caller supplies (the server, from what the person can
// read), and ruleFromSteps() checks the whole automation with ruleProblems() — the same check the rule
// canvas runs before Save; the database's validate_rule / validate_portfolio_rule / guard_my_task_rule
// check it again on the write. stepToModel() is the way back (an existing automation shown to the model in
// full, so it can be edited). Settings without an editor (a date offset's unit, a schedule's hour, an
// Else-if branch number, …) pass through as plain values.
//
// Left out for the AI (they need secrets, destinations, or reach outside the pilot): Slack, webhooks, and
// Convert to a project. Steps that message people when the automation RUNS (email, Inbox notices,
// comments, approval requests, status reminders) may be drafted, but the automation is always created off
// and turning it on asks for a separate confirmation that names who gets messaged (outwardRecipients).
import { autoRuleName } from "./rule-autoname";
import { ruleProblems, stepParams, STEP_TYPES, type RuleParam, type RuleStep, type RuleSystem, type StepKind } from "./rule-params";
import type { Json } from "./supabase/database.types";

export const AI_EXCLUDED_STEPS: Record<RuleSystem, ReadonlySet<string>> = {
  project: new Set(["send_slack", "call_webhook", "convert_to_project"]),
  my_tasks: new Set(),
  portfolio: new Set(),
};

// Steps that message people when the automation runs (who: outwardRecipients).
export const OUTWARD_STEPS: Record<RuleSystem, ReadonlySet<string>> = {
  project: new Set(["send_email", "notify", "add_comment", "request_approval", "send_slack", "call_webhook"]),
  my_tasks: new Set(["add_comment"]),
  portfolio: new Set(["notify", "status_reminder", "set_status"]),
};

export const AI_RULE_LIMITS = { conditions: 20, actions: 10, branches: 5, keysPerStep: 20, textMax: 5000 } as const;

export function aiStepTypes(system: RuleSystem, kind: StepKind): string[] {
  return STEP_TYPES[system][kind].map((s) => s.value).filter((v) => kind !== "action" || !AI_EXCLUDED_STEPS[system].has(v));
}

// One line per step type: its settings, which kind of value each takes, and the choices of a choice
// setting. Generated from rule-params.ts, so the model's vocabulary is the builder's.
export function rulesVocabularyText(system: RuleSystem): string {
  const lines: string[] = [];
  for (const kind of ["trigger", "condition", "action"] as const) {
    const parts = aiStepTypes(system, kind).map((type) => {
      const params = stepParams(type, { system, kind }) ?? [];
      const settings = params.map((p) => `${p.key}${isReq(p) ? "*" : ""}=${editorHint(p)}`);
      return settings.length ? `${type}(${settings.join(", ")})` : type;
    });
    lines.push(`${kind}s: ${parts.join("; ")}`);
  }
  return lines.join("\n");
}

const isReq = (p: RuleParam) => p.required === true;
function editorHint(p: RuleParam): string {
  switch (p.editor) {
    case "choice":
      return (p.options ?? []).map((o) => o.value).join("|") || "text";
    case "choices":
      return `[${(p.options ?? []).map((o) => o.value).join("|")}]`;
    case "sections":
      return "[section names]";
    case "people":
      return "[people]";
    case "titles":
      return "[texts]";
    case "field_value":
      return "value";
    case "number":
      return p.range ? `number ${p.range[0]}-${p.range[1]}` : "number";
    case "date":
      return "YYYY-MM-DD";
    default:
      return p.editor;
  }
}

// ---- Names ↔ ids -----------------------------------------------------------------------------------

type Named = { id: string; name: string; ref?: string };
export type RuleNameField = Named & { fieldType: string; boundToSections?: boolean; options: { id: string; name: string }[] };
export type RulePerson = { id: string; alias: string; name: string };

// What a rule's names may refer to (all read with the person's own access). Sections are per project
// (`sections` = the rule's own project's; `sectionsOf` = another project's, for "Add to project"); My Tasks
// automations' "move to my section" names one of `mySections`.
export type RuleNames = {
  sections: Named[];
  sectionsOf?: (projectId: string) => Named[];
  mySections?: Named[];
  fields: RuleNameField[];
  people: RulePerson[];
  tags?: Named[];
  projects?: Named[];
  forms?: Named[];
  taskTemplates?: Named[];
  projectTemplates?: Named[];
  portfolios?: Named[];
  endpoints?: Named[];
  roles?: Named[];
};

export class RuleStepRefusal extends Error {}
const refuse = (message: string): never => {
  throw new RuleStepRefusal(message);
};
const lower = (v: string) => v.toLowerCase();
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

function byName(list: readonly Named[] | undefined, value: unknown, what: string): string {
  const t = lower(clean(value));
  if (!t) return refuse(`${what}: say which one`);
  const hit = (list ?? []).filter((x) => lower(x.name) === t || (x.ref && lower(x.ref) === t) || x.id === t);
  if (hit.length === 1) return hit[0].id;
  if (hit.length > 1) return refuse(`${what}: more than one is called “${clean(value)}”`);
  return refuse(`${what}: there’s no “${clean(value)}” here`);
}

// A person setting: an alias, "me", a name (unique), "assignee" / "creator", "role:<project role>", or
// "field:<People field>". Throws a plain refusal (the assistant asks when a name matches several people).
export function personFromModel(value: unknown, names: RuleNames, what: string, me: string | null): string {
  const t = clean(value);
  const l = lower(t);
  if (!t) return refuse(`${what}: say who`);
  if (l === "assignee" || l === "creator") return l;
  if (l === "me" || l === "myself" || l === "i") return me ?? refuse(`${what}: “me” isn’t known here`);
  if (l.startsWith("role:")) return `project_role:${byName(names.roles, t.slice(5), what)}`;
  if (l.startsWith("field:")) return `field:${byName(names.fields.filter((f) => f.fieldType === "people"), t.slice(6), what)}`;
  const alias = names.people.find((p) => p.alias === l || p.id === l);
  if (alias) return alias.id;
  const matches = matchPeople(t, names.people);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) return refuse(`${what}: “${t}” could be ${matches.map((p) => p.name).join(" or ")}`);
  return refuse(`${what}: nobody called “${t}” can be picked here`);
}

// Case-insensitive: the whole name, the first or last name, or a unique start of the name.
export function matchPeople<P extends { name: string }>(query: string, people: readonly P[]): P[] {
  const q = lower(clean(query)).replace(/^@/, "");
  if (!q) return [];
  const exact = people.filter((p) => lower(p.name) === q);
  if (exact.length) return exact;
  const word = people.filter((p) => lower(p.name).split(/\s+/).includes(q));
  if (word.length) return word;
  return people.filter((p) => lower(p.name).startsWith(q));
}

function personToModel(id: Json | undefined, names: RuleNames): string | null {
  if (typeof id !== "string") return null;
  if (id === "assignee" || id === "creator") return id;
  if (id.startsWith("project_role:")) {
    const r = names.roles?.find((x) => x.id === id.slice(13));
    return r ? `role:${r.name}` : null;
  }
  if (id.startsWith("field:")) {
    const f = names.fields.find((x) => x.id === id.slice(6));
    return f ? `field:${f.name}` : null;
  }
  return names.people.find((p) => p.id === id.toLowerCase())?.alias ?? null;
}

function fieldValueFromModel(field: RuleNameField, value: unknown, what: string, names: RuleNames, me: string | null): Json {
  if (value === null || value === "") return null;
  switch (field.fieldType) {
    case "single_select":
      return field.options.find((o) => lower(o.name) === lower(clean(value)) || o.id === value)?.id ?? refuse(`${what}: “${clean(value)}” isn’t an option of “${field.name}”`);
    case "multi_select": {
      const list = Array.isArray(value) ? value : String(value).split(/\s*,\s*/);
      return list.map((v) => field.options.find((o) => lower(o.name) === lower(clean(v)) || o.id === v)?.id ?? refuse(`${what}: “${clean(v)}” isn’t an option of “${field.name}”`));
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
      return Number.isFinite(n) ? n : refuse(`${what}: “${field.name}” needs a number`);
    }
    case "boolean":
      return value === true || lower(clean(value)) === "true" || lower(clean(value)) === "yes";
    case "people": {
      const list = Array.isArray(value) ? value : [value];
      return list.map((v) => personFromModel(v, names, what, me));
    }
    default: {
      const t = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
      return t.length <= 1000 ? t : refuse(`${what}: the text is too long`);
    }
  }
}

function fieldValueToModel(field: RuleNameField | undefined, value: Json | undefined, names: RuleNames): Json | undefined {
  if (!field || value === undefined || value === null) return value;
  if (field.fieldType === "single_select") return field.options.find((o) => o.id === value)?.name ?? undefined;
  if (field.fieldType === "multi_select") return Array.isArray(value) ? value.map((v) => field.options.find((o) => o.id === v)?.name ?? null) : undefined;
  if (field.fieldType === "people") return Array.isArray(value) ? value.map((v) => personToModel(v, names)) : undefined;
  return value;
}

const SECRET_KEY = /(_ref|_hint|secret|signing|url|token|password)$/i;
const isPlain = (v: unknown): v is Json =>
  v === null || ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.length <= 50 && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x)));

export type StepContext = { system: RuleSystem; kind: StepKind; names: RuleNames; me: string | null; projectId: string | null };

// The model's step → the engine's step (ids), or a plain refusal.
export function stepFromModel(raw: unknown, sc: StepContext, what: string): RuleStep {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse(`${what}: not a step`);
  const step = raw as Record<string, unknown>;
  const type = clean(step.type);
  const allowed = aiStepTypes(sc.system, sc.kind);
  if (!allowed.includes(type)) {
    if (sc.kind === "action" && AI_EXCLUDED_STEPS[sc.system].has(type)) return refuse(`${what}: the assistant can’t set up ${type.replace(/_/g, " ")} (it needs a secret or a destination); add it in the automation builder`);
    return refuse(`${what}: “${type || "?"}” isn’t a ${sc.kind} here`);
  }
  const params = stepParams(type, sc) ?? [];
  const keys = Object.keys(step).filter((k) => k !== "type");
  if (keys.length > AI_RULE_LIMITS.keysPerStep) refuse(`${what}: too many settings`);
  const out: RuleStep = { type };
  const field = (value: unknown) => {
    const id = byName(sc.names.fields, value, what);
    return sc.names.fields.find((f) => f.id === id)!;
  };
  // Fields first: an option / value setting reads the step's field.
  const first = (k: string) => (k === "project_id" || /field_id$/.test(k) ? 0 : 1);
  const order = [...keys].sort((a, b) => first(a) - first(b));
  for (const key of order) {
    const value = step[key];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0 && key !== "titles")) continue;
    if (SECRET_KEY.test(key)) refuse(`${what}: the assistant doesn’t set ${key.replace(/_/g, " ")}`);
    const param = params.find((p) => p.key === key);
    if (!param) {
      // A setting without an editor (a unit, an hour, a branch number): plain values only, never an id key.
      if (/_ids?$/.test(key) && sc.kind !== "trigger") refuse(`${what}: “${key}” isn’t a setting of ${type}`);
      if (!isPlain(value)) refuse(`${what}: “${key}” needs a plain value`);
      out[key] = value as Json;
      continue;
    }
    switch (param.editor) {
      case "section": {
        const projectId = typeof out.project_id === "string" ? out.project_id : null;
        const list = sc.system === "my_tasks" && type === "move_to_section" ? sc.names.mySections : projectId && projectId !== sc.projectId ? sc.names.sectionsOf?.(projectId) : sc.names.sections;
        out[key] = byName(list, value, what);
        break;
      }
      case "sections":
        out[key] = (Array.isArray(value) ? value : [value]).map((v) => byName(sc.names.sections, v, what));
        break;
      case "field":
        out[key] = field(value).id;
        break;
      case "option":
      case "field_value": {
        const fid = typeof out.field_id === "string" ? out.field_id : null;
        const f = fid ? sc.names.fields.find((x) => x.id === fid) : undefined;
        if (!f) refuse(`${what}: say which field first`);
        out[key] = fieldValueFromModel(f!, value, what, sc.names, sc.me);
        break;
      }
      case "person":
        out[key] = value === null || lower(clean(value)) === "none" || lower(clean(value)) === "nobody" ? null : personFromModel(value, sc.names, what, sc.me);
        break;
      case "people": {
        const list = Array.isArray(value) ? value : [value];
        if (list.length > 20) refuse(`${what}: at most 20 people`);
        out[key] = [...new Set(list.map((v) => personFromModel(v, sc.names, what, sc.me)))];
        break;
      }
      case "tag":
        out[key] = byName(sc.names.tags, value, what);
        break;
      case "project":
        out[key] = key.endsWith("_ids") || Array.isArray(value) ? (Array.isArray(value) ? value : [value]).map((v) => byName(sc.names.projects, v, what)) : byName(sc.names.projects, value, what);
        break;
      case "form":
        out[key] = byName(sc.names.forms, value, what);
        break;
      case "endpoint":
        out[key] = byName(sc.names.endpoints, value, what);
        break;
      case "task_template":
        out[key] = byName(sc.names.taskTemplates, value, what);
        break;
      case "project_template":
        out[key] = byName(sc.names.projectTemplates, value, what);
        break;
      case "portfolio":
        out[key] = byName(sc.names.portfolios, value, what);
        break;
      case "question":
        refuse(`${what}: pick the form question in the automation builder`);
        break;
      case "choice": {
        const v = clean(value);
        if (param.options && !param.options.some((o) => o.value === v)) refuse(`${what}: ${key} is one of ${param.options.map((o) => o.value).join(", ")}`);
        out[key] = v;
        break;
      }
      case "choices": {
        const list = (Array.isArray(value) ? value : [value]).map(clean);
        if (param.options && list.some((v) => !param.options!.some((o) => o.value === v))) refuse(`${what}: ${key} takes ${param.options.map((o) => o.value).join(", ")}`);
        out[key] = [...new Set(list)];
        break;
      }
      case "number": {
        const n = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(n)) refuse(`${what}: ${key} needs a number`);
        out[key] = n;
        break;
      }
      case "titles": {
        const list = (Array.isArray(value) ? value : [value]).map(clean).filter(Boolean);
        if (list.some((t) => t.length > 200)) refuse(`${what}: a name is at most 200 characters`);
        out[key] = list;
        break;
      }
      case "date": {
        const t = clean(value);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) refuse(`${what}: ${key} is a date (YYYY-MM-DD)`);
        out[key] = t;
        break;
      }
      default: {
        const t = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
        if (t.length > AI_RULE_LIMITS.textMax) refuse(`${what}: the text is too long`);
        out[key] = t;
      }
    }
  }
  return out;
}

// The engine's step → the model's (names). Null when something in it can't be named (the automation then
// can't be rewritten by the AI, only turned on / off or removed).
export function stepToModel(step: RuleStep, sc: Omit<StepContext, "me">): Record<string, Json> | null {
  const params = stepParams(step.type, sc) ?? [];
  const out: Record<string, Json> = { type: step.type };
  const name = (list: readonly Named[] | undefined, id: Json | undefined) => (typeof id === "string" ? (list ?? []).find((x) => x.id === id)?.name ?? null : null);
  for (const [key, value] of Object.entries(step)) {
    if (key === "type" || value === undefined) continue;
    if (SECRET_KEY.test(key)) continue;
    const param = params.find((p) => p.key === key);
    if (!param) {
      if (/_ids?$/.test(key)) return null;
      out[key] = value;
      continue;
    }
    const field = typeof step.field_id === "string" ? sc.names.fields.find((f) => f.id === step.field_id) : undefined;
    let shown: Json | null | undefined;
    switch (param.editor) {
      case "section": {
        const projectId = typeof step.project_id === "string" ? step.project_id : null;
        const list = sc.system === "my_tasks" && step.type === "move_to_section" ? sc.names.mySections : projectId && projectId !== sc.projectId ? sc.names.sectionsOf?.(projectId) : sc.names.sections;
        shown = name(list, value);
        break;
      }
      case "sections":
        shown = Array.isArray(value) ? value.map((v) => name(sc.names.sections, v)) : null;
        if (Array.isArray(shown) && shown.some((x) => x === null)) shown = null;
        break;
      case "field":
        shown = field?.name ?? null;
        break;
      case "option":
      case "field_value":
        shown = fieldValueToModel(field, value, sc.names);
        if (shown === undefined) shown = null;
        else if (shown === null && value !== null) shown = null;
        else if (Array.isArray(shown) && shown.some((x) => x === null)) shown = null;
        else if (shown === null) {
          out[key] = null;
          continue;
        }
        break;
      case "person":
        if (value === null) {
          out[key] = null;
          continue;
        }
        shown = personToModel(value, sc.names);
        break;
      case "people":
        shown = Array.isArray(value) ? value.map((v) => personToModel(v, sc.names)) : null;
        if (Array.isArray(shown) && shown.some((x) => x === null)) shown = null;
        break;
      case "tag":
        shown = name(sc.names.tags, value);
        break;
      case "project":
        shown = Array.isArray(value) ? value.map((v) => name(sc.names.projects, v)) : name(sc.names.projects, value);
        if (Array.isArray(shown) && shown.some((x) => x === null)) shown = null;
        break;
      case "form":
        shown = name(sc.names.forms, value);
        break;
      case "endpoint":
        shown = name(sc.names.endpoints, value);
        break;
      case "task_template":
        shown = name(sc.names.taskTemplates, value);
        break;
      case "project_template":
        shown = name(sc.names.projectTemplates, value);
        break;
      case "portfolio":
        shown = name(sc.names.portfolios, value);
        break;
      case "question":
        return null;
      default:
        shown = value;
    }
    if (shown === null || shown === undefined) return null;
    out[key] = shown;
  }
  return out;
}

// ---- Whole automations -----------------------------------------------------------------------------

export type AiRuleBody = {
  name: string;
  triggerType: string;
  triggerConfig: Record<string, Json>;
  conditions: RuleStep[];
  actions: RuleStep[];
};

export type AiRuleResult = { ok: true; rule: AiRuleBody } | { ok: false; error: string };

// The model's whole automation ({ name, trigger, conditions, actions }) → the engine's, checked.
export function ruleFromSteps(raw: unknown, system: RuleSystem, names: RuleNames, me: string | null, projectId: string | null): AiRuleResult {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("The automation is missing");
    const draft = raw as Record<string, unknown>;
    const conditionsRaw = Array.isArray(draft.conditions) ? draft.conditions : [];
    const actionsRaw = Array.isArray(draft.actions) ? draft.actions : [];
    if (actionsRaw.length === 0) refuse("An automation needs at least one action");
    if (actionsRaw.length > AI_RULE_LIMITS.actions * AI_RULE_LIMITS.branches) refuse("Too many actions");
    if (conditionsRaw.length > AI_RULE_LIMITS.conditions) refuse("Too many conditions");
    const base = { system, names, me, projectId };
    const trigger = stepFromModel(draft.trigger, { ...base, kind: "trigger" }, "When");
    const conditions = conditionsRaw.map((c, i) => stepFromModel(c, { ...base, kind: "condition" }, `Condition ${i + 1}`));
    const actions = actionsRaw.map((a, i) => stepFromModel(a, { ...base, kind: "action" }, `Action ${i + 1}`));
    const { type: triggerType, ...triggerConfig } = trigger;
    const problems = ruleProblems({ triggerType, triggerConfig, conditions, actions }, system, { v3: true });
    if (problems.length) refuse(`The automation is missing something: ${problems[0]}`);
    const label = (kind: StepKind, v: string) => STEP_TYPES[system][kind].find((x) => x.value === v)?.label ?? v;
    const name = clean(draft.name).slice(0, 100) || autoRuleName(label("trigger", triggerType), actions.map((a) => label("action", a.type)));
    return { ok: true, rule: { name, triggerType, triggerConfig, conditions, actions } };
  } catch (error) {
    if (error instanceof RuleStepRefusal) return { ok: false, error: error.message };
    throw error;
  }
}

// The engine's automation → the model's, or null when part of it can't be named.
export function ruleToSteps(rule: AiRuleBody, system: RuleSystem, names: RuleNames, projectId: string | null): Record<string, Json> | null {
  const sc = { system, names, projectId };
  const trigger = stepToModel({ type: rule.triggerType, ...rule.triggerConfig }, { ...sc, kind: "trigger" });
  const conditions = rule.conditions.map((c) => stepToModel(c, { ...sc, kind: "condition" }));
  const actions = rule.actions.map((a) => stepToModel(a, { ...sc, kind: "action" }));
  if (!trigger || conditions.some((c) => !c) || actions.some((a) => !a)) return null;
  return { name: rule.name, trigger, conditions: conditions as Json[], actions: actions as Json[] };
}

// Who an automation's steps would message when it runs (for the separate confirmation before it's turned
// on), or [] when it messages nobody. `nameOf` names a person id.
export function outwardRecipients(rule: Pick<AiRuleBody, "actions">, system: RuleSystem, nameOf: (id: string) => string): string[] {
  const out: string[] = [];
  const who = (v: Json | undefined) => (typeof v === "string" ? (v === "assignee" ? "the task’s assignee" : v === "creator" ? "the task’s creator" : v.startsWith("project_role:") ? "a project role’s person" : v.startsWith("field:") ? "people in a People field" : nameOf(v)) : null);
  for (const a of rule.actions) {
    if (!OUTWARD_STEPS[system].has(a.type)) continue;
    switch (a.type) {
      case "send_email":
        out.push(a.to === "address" ? "an email address" : a.to === "submitter" ? "the form’s submitter (email)" : a.to === "assignee" ? "the assignee (email)" : "people (email)");
        break;
      case "notify":
        for (const p of Array.isArray(a.people) ? a.people : []) out.push(`${who(p) ?? "someone"} (Inbox)`);
        if (Array.isArray(a.roles)) out.push("project people (Inbox)");
        break;
      case "add_comment":
        out.push("the task’s followers (a comment)");
        break;
      case "request_approval":
        out.push(`${who(a.approver) ?? "an approver"} (approval request)`);
        break;
      case "status_reminder":
        out.push("each project’s owner (status reminder)");
        break;
      case "set_status":
        out.push("each project’s members (status update)");
        break;
      default:
        out.push(a.type.replace(/_/g, " "));
    }
  }
  return [...new Set(out)];
}
