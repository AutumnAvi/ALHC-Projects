import type { Json } from "@/lib/supabase/database.types";
import {
  ACTIONS,
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  ASSIGN_MODES,
  CONDITIONS,
  CREATE_LINKS,
  DATE_CHANGES,
  DATE_OPS,
  DATE_SUBJECTS,
  DESCRIPTION_MODES,
  DUE_FROM,
  EMAIL_RECIPIENTS,
  EMAIL_TEMPLATES,
  RANGE_OPS,
  SCHEDULE_FREQUENCIES,
  TASK_KIND_OPTIONS,
  TASK_SOURCES,
  TRIGGERS,
  UNBLOCK_KINDS,
  type ActionType,
  type ConditionType,
  type TriggerType,
} from "@/lib/rules";
import {
  MEMBER_ROLES,
  PORTFOLIO_ACTIONS,
  PORTFOLIO_CONDITIONS,
  PORTFOLIO_TRIGGERS,
  PROJECT_STATUSES,
  type PortfolioActionType,
  type PortfolioConditionType,
  type PortfolioTriggerType,
} from "@/lib/portfolio-rules";
import {
  MY_TASK_ACTIONS,
  MY_TASK_CONDITIONS,
  MY_TASK_TRIGGERS,
  type MyTaskAction,
  type MyTaskCondition,
  type MyTaskTrigger,
} from "@/lib/my-task-rules";

// Every rule step's settings, in one place (the project, portfolio, and My Tasks rule builders).
// Each trigger, condition, and action declares the keys it stores, which of them must be chosen
// before the rule can be saved, and which kind of editor sets them. The builders use it to point at
// a setting that's still missing ("Choose a task type") and to hold Save; the Server Actions run the
// same check before writing (the database's validate_rule / validate_portfolio_rule /
// guard_my_task_rule stay the trust boundary). tests/unit/rule-params.test.tsx walks every step and
// fails when a required setting has no editor on screen or doesn't show up in the rule's summary.

// The editor that sets a key. "choice" / "choices" are a SmartPicker over `options`.
export type ParamEditor =
  | "section"
  | "sections"
  | "field"
  | "field_value"
  | "option"
  | "person"
  | "people"
  | "tag"
  | "form"
  | "question"
  | "endpoint"
  | "project"
  | "task_template"
  | "project_template"
  | "portfolio"
  | "choice"
  | "choices"
  | "number"
  | "text"
  | "titles"
  | "date";

export type RuleStep = { type: string } & Record<string, Json>;

export type RuleParam = {
  key: string;
  editor: ParamEditor;
  // What to ask for while it's missing ("Choose a task type"); also the summary's "choose …".
  ask: string;
  // Must be set before saving (a function when it depends on the step's other settings).
  required?: boolean | ((step: RuleStep, scope: StepScope) => boolean);
  // Only used (and shown) when this holds, e.g. `address` when an email goes to a fixed address.
  when?: (step: RuleStep) => boolean;
  // The picker's choices ("choice" / "choices").
  options?: readonly { value: string; label: string }[];
  // null is a real choice here (Set assignee → nobody, Set field → empty).
  nullable?: boolean;
  // Left out of the summary (secrets, formatting).
  summary?: false;
  // A number's allowed range (inclusive), with what to say outside it.
  range?: readonly [number, number];
  // A set value's shape problem ("Enter a valid email address"), or null.
  check?: (value: Json) => string | null;
};

export type RuleSystem = "project" | "portfolio" | "my_tasks";
export type StepKind = "trigger" | "condition" | "action";

export type StepScope = {
  system: RuleSystem;
  kind: StepKind;
  // Automations V3's database update is applied (unknown = yes). Before it, "any section" isn't a
  // choice for "Task moves into a section".
  v3?: boolean;
};

const str = (key: string) => (step: RuleStep) => typeof step[key] === "string" ? (step[key] as string) : "";
const is = (key: string, ...values: string[]) => (step: RuleStep) => values.includes(str(key)(step));
const rangeOp = (step: RuleStep) => RANGE_OPS.has(str("op")(step));

// Shared shapes.
const SECTION: RuleParam = { key: "section_id", editor: "section", ask: "Choose a section", required: true };
const FIELD: RuleParam = { key: "field_id", editor: "field", ask: "Choose a field", required: true };
const TAG: RuleParam = { key: "tag_id", editor: "tag", ask: "Choose a tag", required: true };
const PEOPLE: RuleParam = { key: "people", editor: "people", ask: "Choose people", required: true };
const DAYS: RuleParam = { key: "days", editor: "number", ask: "Enter a number of days", required: true, range: [0, 365] };
const KIND: RuleParam = { key: "kind", editor: "choice", ask: "Choose a task type", required: true, options: TASK_KIND_OPTIONS };
// Date triggers' "how long before / after" ({ days } or { amount, unit }; a default when missing).
// (the older { days } shape the builder writes for days counts 0–30; hours and weeks are { amount, unit }).
const OFFSET: RuleParam = { key: "days", editor: "number", ask: "Enter how long", range: [0, 30] };
// Portfolio and My Tasks date triggers: days before / after (0–60; overdue 1–60).
const DAYS_BEFORE: RuleParam = { key: "days", editor: "number", ask: "Enter how many days before", range: [0, 60] };
const DAYS_AFTER: RuleParam = { key: "days", editor: "number", ask: "Enter how many days after", range: [1, 60] };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_ACTION_MODES = [
  { value: "relative", label: "to some days from a date" },
  { value: "date", label: "on a date" },
  { value: "clear", label: "clear it" },
] as const;
const relative = (step: RuleStep) => str("mode")(step) !== "clear" && str("mode")(step) !== "date";

// ---------------------------------------------------------------------------------------------
// Project rules (src/lib/rules.ts; validate_rule)
// ---------------------------------------------------------------------------------------------

export const PROJECT_TRIGGER_PARAMS: Record<TriggerType, RuleParam[]> = {
  task_created: [],
  // "any section" arrives with Automations V3's database update; before it a section must be picked.
  section_changed: [{ ...SECTION, required: (_step, scope) => scope.v3 === false }],
  field_changed: [
    { ...FIELD, ask: "Choose the field that changes" },
    { key: "option_id", editor: "option", ask: "Choose a value" },
  ],
  assignee_changed: [],
  due_approaching: [OFFSET],
  approval_decided: [{ key: "statuses", editor: "choices", ask: "Choose decisions", options: APPROVAL_DECISIONS }],
  form_submitted: [{ key: "form_id", editor: "form", ask: "Choose a form" }],
  inbound_received: [{ key: "endpoint_id", editor: "endpoint", ask: "Choose an inbound webhook" }],
  task_completed: [],
  task_reopened: [],
  subtasks_completed: [],
  task_added_from_project: [],
  comment_added: [],
  attachment_added: [],
  tag_added: [{ ...TAG, required: false }],
  due_date_changed: [{ key: "change", editor: "choice", ask: "Choose which changes", options: DATE_CHANGES }],
  task_overdue: [OFFSET],
  scheduled: [{ key: "frequency", editor: "choice", ask: "Choose how often", required: true, options: SCHEDULE_FREQUENCIES }],
  manual: [],
  follower_added: [{ ...PEOPLE, required: false, ask: "Choose who starts following" }],
  start_date_changed: [{ key: "change", editor: "choice", ask: "Choose which changes", options: DATE_CHANGES }],
  start_approaching: [OFFSET],
  start_reached: [OFFSET],
  task_unblocked: [{ key: "kinds", editor: "choices", ask: "Choose which dependencies", options: UNBLOCK_KINDS }],
  task_type_changed: [{ ...KIND, required: false }],
  section_left: [{ ...SECTION, ask: "Choose the section it leaves" }],
};

const FIELD_VALUE: RuleParam = { key: "value", editor: "field_value", ask: "Choose a value", required: true, when: (s) => Boolean(s.field_id) };

export const PROJECT_CONDITION_PARAMS: Record<ConditionType, RuleParam[]> = {
  section_is: [SECTION],
  section_is_not: [SECTION],
  is_incomplete: [],
  is_complete: [],
  source_is: [
    { key: "source", editor: "choice", ask: "Choose where the task came from", required: true, options: TASK_SOURCES },
    { key: "form_id", editor: "form", ask: "Choose a form", when: is("source", "form") },
  ],
  field_equals: [FIELD, FIELD_VALUE],
  field_is_set: [FIELD],
  field_is_empty: [FIELD],
  assignee_is_set: [],
  assignee_is_empty: [],
  field_compare: [
    FIELD,
    { key: "op", editor: "choice", ask: "Choose a comparison", required: true, when: (s) => Boolean(s.field_id) },
    { ...FIELD_VALUE, ask: "Choose a value to compare with", when: (s) => Boolean(s.field_id && s.op) },
    { key: "to", editor: "field_value", ask: "Choose the second value", required: true, when: (s) => Boolean(s.field_id) && rangeOp(s) },
  ],
  has_tag: [TAG],
  lacks_tag: [TAG],
  assignee_is: [PEOPLE],
  assignee_is_not: [PEOPLE],
  creator_is: [PEOPLE],
  is_overdue: [],
  due_within: [DAYS],
  has_due_date: [],
  no_due_date: [],
  task_type_is: [KIND],
  has_open_subtasks: [],
  all_subtasks_done: [],
  title_contains: [{ key: "text", editor: "text", ask: "Enter the text to look for", required: true }],
  form_answer_contains: [
    { key: "text", editor: "text", ask: "Enter the text to look for", required: true },
    { key: "question_id", editor: "question", ask: "Choose a question" },
  ],
  person_compare: [
    { key: "left", editor: "choice", ask: "Choose who to compare", required: true },
    { key: "op", editor: "choice", ask: "Choose is or isn’t", required: true, options: [{ value: "is", label: "is" }, { value: "is_not", label: "isn’t" }] },
    { ...PEOPLE, ask: "Choose who to compare with" },
  ],
  date_compare: [
    { key: "date", editor: "choice", ask: "Choose which date", required: true, options: DATE_SUBJECTS },
    { key: "op", editor: "choice", ask: "Choose a comparison", required: true, options: DATE_OPS },
    { key: "value", editor: "date", ask: "Choose a date", required: true },
    { key: "to", editor: "date", ask: "Choose the end date", required: true, when: rangeOp },
  ],
  has_start_date: [],
  no_start_date: [],
  has_started: [],
  start_within: [DAYS],
  section_is_one_of: [{ key: "section_ids", editor: "sections", ask: "Choose sections", required: true }],
  section_is_none_of: [{ key: "section_ids", editor: "sections", ask: "Choose sections", required: true }],
  task_type_is_not: [KIND],
  is_blocked: [],
  is_not_blocked: [],
  approval_status_is: [{ key: "statuses", editor: "choices", ask: "Choose approval statuses", required: true, options: APPROVAL_STATUSES }],
  has_attachment: [],
  no_attachment: [],
  has_comment: [],
  no_comment: [],
};

const assignMode = (step: RuleStep) => (step.mode === "round_robin" || step.mode === "balanced" ? step.mode : "person");

export const PROJECT_ACTION_PARAMS: Record<ActionType, RuleParam[]> = {
  move_section: [{ ...SECTION, ask: "Choose a section to move to" }],
  set_field: [FIELD, { ...FIELD_VALUE, required: false, nullable: true }],
  set_assignee: [
    { key: "mode", editor: "choice", ask: "Choose how to assign", options: ASSIGN_MODES },
    // null = unassign; "" = a slot still to fill (a template's).
    { key: "assignee", editor: "person", ask: "Choose who to assign", required: true, nullable: true, when: (s) => assignMode(s) === "person" },
    { ...PEOPLE, ask: "Choose who takes turns", when: (s) => assignMode(s) !== "person" },
  ],
  add_followers: [{ ...PEOPLE, ask: "Choose followers" }],
  add_comment: [{ key: "body", editor: "text", ask: "Write the comment", required: true }],
  notify: [
    { ...PEOPLE, ask: "Choose who to notify" },
    { key: "message", editor: "text", ask: "Write the message", required: true },
  ],
  send_email: [
    { key: "to", editor: "choice", ask: "Choose a recipient", required: true, options: EMAIL_RECIPIENTS },
    { key: "field_id", editor: "field", ask: "Choose the field with the address", required: true, when: is("to", "field") },
    {
      key: "address",
      editor: "text",
      ask: "Enter an email address",
      required: true,
      when: is("to", "address"),
      check: (v) => (typeof v === "string" && EMAIL.test(v.trim()) ? null : "Enter a valid email address"),
    },
    { key: "template", editor: "choice", ask: "Choose a template", options: EMAIL_TEMPLATES },
    { key: "subject", editor: "text", ask: "Write a subject" },
    { key: "message", editor: "text", ask: "Write the message", required: (s) => str("template")(s) === "custom" },
    { key: "include_field_id", editor: "field", ask: "Choose a field to include" },
  ],
  request_approval: [
    { key: "approver", editor: "person", ask: "Choose an approver", required: true },
    { key: "title", editor: "text", ask: "Name the approval subtask", summary: false },
    { key: "note", editor: "text", ask: "Write a note", summary: false },
  ],
  send_slack: [
    { key: "message", editor: "text", ask: "Write the Slack message", required: true },
    { key: "format", editor: "choice", ask: "Choose a message style", options: [{ value: "text", label: "Plain text" }, { value: "blocks", label: "Block Kit" }] },
  ],
  // The URL may be the project's default (Settings → Integrations); secrets never show.
  call_webhook: [],
  delay: [{ key: "hours", editor: "number", ask: "Enter how many hours to wait", required: true, range: [0.1, 720] }],
  complete_task: [],
  reopen_task: [],
  set_title: [{ key: "title", editor: "text", ask: "Write the new name", required: true }],
  create_subtasks: [
    { key: "titles", editor: "titles", ask: "Name at least one subtask", required: true, check: (v) => (Array.isArray(v) && v.length > 20 ? "Up to 20 subtasks" : null) },
    { key: "assignee", editor: "person", ask: "Choose who to assign them to" },
  ],
  apply_task_template: [{ key: "template_id", editor: "task_template", ask: "Choose a task template", required: true }],
  add_to_project: [
    { key: "project_id", editor: "project", ask: "Choose a project", required: true },
    { key: "section_id", editor: "section", ask: "Choose a section", when: (s) => Boolean(s.project_id) },
  ],
  set_due_date: [
    { key: "mode", editor: "choice", ask: "Choose set or clear", options: DATE_ACTION_MODES },
    { key: "days", editor: "number", ask: "Enter a number of days", required: true, when: relative },
    { key: "from", editor: "choice", ask: "Choose what to count from", options: DUE_FROM, when: (s) => relative(s) && s.unit !== "hours" },
    { key: "date", editor: "date", ask: "Choose a date", required: true, when: is("mode", "date") },
  ],
  add_tag: [TAG],
  remove_tag: [TAG],
  remove_followers: [{ ...PEOPLE, ask: "Choose who stops following" }],
  set_start_date: [
    { key: "mode", editor: "choice", ask: "Choose set or clear", options: DATE_ACTION_MODES },
    { key: "days", editor: "number", ask: "Enter a number of days", required: true, when: relative },
    { key: "from", editor: "choice", ask: "Choose what to count from", options: DUE_FROM, when: (s) => relative(s) && s.unit !== "hours" },
    { key: "date", editor: "date", ask: "Choose a date", required: true, when: is("mode", "date") },
  ],
  create_task: [
    { key: "kind", editor: "choice", ask: "Choose what to create", options: TASK_KIND_OPTIONS },
    { key: "title", editor: "text", ask: "Name the new task", required: true },
    { key: "project_id", editor: "project", ask: "Choose a project" },
    { key: "section_id", editor: "section", ask: "Choose a section" },
    { key: "assignee", editor: "person", ask: "Choose an assignee" },
    { key: "due_days", editor: "number", ask: "Enter a number of days", range: [0, 365] },
    { key: "link", editor: "choice", ask: "Choose how it’s linked", options: CREATE_LINKS },
  ],
  move_to_project: [
    { key: "project_id", editor: "project", ask: "Choose a project", required: true },
    { key: "section_id", editor: "section", ask: "Choose a section", when: (s) => Boolean(s.project_id) },
  ],
  remove_from_project: [],
  set_task_type: [KIND],
  set_description: [
    { key: "mode", editor: "choice", ask: "Choose replace or add", options: DESCRIPTION_MODES },
    // Replacing with nothing clears the description; adding needs some text.
    { key: "text", editor: "text", ask: "Write the text to add", required: (s) => is("mode", "append", "prepend")(s) },
  ],
  convert_to_project: [
    { key: "template_id", editor: "project_template", ask: "Choose a template" },
    { key: "portfolio_id", editor: "portfolio", ask: "Choose a portfolio" },
    { key: "name", editor: "text", ask: "Name the project" },
    { key: "members", editor: "choice", ask: "Choose who joins", options: [{ value: "none", label: "invite nobody else" }, { value: "task_people", label: "invite the task’s people" }] },
  ],
};

// ---------------------------------------------------------------------------------------------
// Portfolio rules (src/lib/portfolio-rules.ts; validate_portfolio_rule)
// ---------------------------------------------------------------------------------------------

const STATUSES: RuleParam = { key: "statuses", editor: "choices", ask: "Choose statuses", required: true, options: PROJECT_STATUSES };
const PORTFOLIO_FIELD_VALUE: RuleParam = { key: "value", editor: "field_value", ask: "Choose a value", required: true, when: (s) => Boolean(s.field_id) };

export const PORTFOLIO_TRIGGER_PARAMS: Record<PortfolioTriggerType, RuleParam[]> = {
  item_added: [],
  item_removed: [],
  status_changed: [{ ...STATUSES, required: false }],
  owner_changed: [],
  field_changed: [
    { ...FIELD, ask: "Choose the field that changes" },
    { key: "option_id", editor: "option", ask: "Choose a value" },
  ],
  due_date_changed: [],
  due_approaching: [DAYS_BEFORE],
  item_overdue: [DAYS_AFTER],
  scheduled: [{ key: "frequency", editor: "choice", ask: "Choose how often", required: true, options: SCHEDULE_FREQUENCIES }],
  manual: [],
};

export const PORTFOLIO_CONDITION_PARAMS: Record<PortfolioConditionType, RuleParam[]> = {
  status_is: [STATUSES],
  status_is_not: [STATUSES],
  owner_is: [PEOPLE],
  owner_is_not: [PEOPLE],
  is_archived: [],
  is_not_archived: [],
  has_due_date: [],
  no_due_date: [],
  is_overdue: [],
  due_within: [DAYS],
  date_compare: [
    { key: "op", editor: "choice", ask: "Choose a comparison", required: true, options: DATE_OPS },
    { key: "value", editor: "date", ask: "Choose a date", required: true },
    { key: "to", editor: "date", ask: "Choose the end date", required: true, when: rangeOp },
  ],
  field_equals: [FIELD, PORTFOLIO_FIELD_VALUE],
  field_is_set: [FIELD],
  field_is_empty: [FIELD],
};

export const PORTFOLIO_ACTION_PARAMS: Record<PortfolioActionType, RuleParam[]> = {
  set_status: [
    { key: "status", editor: "choice", ask: "Choose a status", required: true, options: PROJECT_STATUSES },
    { key: "note", editor: "text", ask: "Write a note", summary: false },
  ],
  status_reminder: [{ key: "message", editor: "text", ask: "Write a message", summary: false }],
  notify: [
    { ...PEOPLE, ask: "Choose who to notify" },
    { key: "message", editor: "text", ask: "Write the message", required: true },
  ],
  set_owner: [{ key: "person", editor: "person", ask: "Choose the new owner", required: true }],
  set_due_date: [
    { key: "mode", editor: "choice", ask: "Choose set or clear", options: DATE_ACTION_MODES },
    { key: "days", editor: "number", ask: "Enter a number of days", required: true, when: relative },
    { key: "date", editor: "date", ask: "Choose a date", required: true, when: is("mode", "date") },
  ],
  // The engine keeps the first 100 characters of a project name.
  set_name: [{ key: "name", editor: "text", ask: "Write the new name", required: true, check: (v) => (typeof v === "string" && v.length > 100 ? "Project names are up to 100 characters" : null) }],
  set_field: [FIELD, { ...PORTFOLIO_FIELD_VALUE, required: false, nullable: true }],
  add_members: [
    { ...PEOPLE, ask: "Choose people to add" },
    { key: "role", editor: "choice", ask: "Choose a role", options: MEMBER_ROLES },
  ],
  remove_members: [{ ...PEOPLE, ask: "Choose people to remove" }],
  archive_project: [],
  remove_from_portfolio: [],
  add_to_portfolio: [{ key: "portfolio_id", editor: "portfolio", ask: "Choose a portfolio", required: true }],
};

// ---------------------------------------------------------------------------------------------
// My Tasks rules (src/lib/my-task-rules.ts; guard_my_task_rule)
// ---------------------------------------------------------------------------------------------

export const MY_TASK_TRIGGER_PARAMS: Record<MyTaskTrigger, RuleParam[]> = {
  assigned: [],
  due_approaching: [DAYS_BEFORE],
  task_overdue: [DAYS_AFTER],
};

export const MY_TASK_CONDITION_PARAMS: Record<MyTaskCondition, RuleParam[]> = {
  in_project: [{ key: "project_ids", editor: "project", ask: "Choose projects", required: true }],
  not_in_project: [{ key: "project_ids", editor: "project", ask: "Choose projects", required: true }],
  has_due_date: [],
  no_due_date: [],
  due_within: [DAYS],
  task_type_is: [KIND],
  is_private: [],
};

export const MY_TASK_ACTION_PARAMS: Record<MyTaskAction, RuleParam[]> = {
  move_to_section: [{ ...SECTION, ask: "Choose one of your sections" }],
  set_due_date: [DAYS],
  complete_task: [],
};

// ---------------------------------------------------------------------------------------------
// Lookup and checks
// ---------------------------------------------------------------------------------------------

const REGISTRY: Record<RuleSystem, Record<StepKind, Record<string, RuleParam[]>>> = {
  project: { trigger: PROJECT_TRIGGER_PARAMS, condition: PROJECT_CONDITION_PARAMS, action: PROJECT_ACTION_PARAMS },
  portfolio: { trigger: PORTFOLIO_TRIGGER_PARAMS, condition: PORTFOLIO_CONDITION_PARAMS, action: PORTFOLIO_ACTION_PARAMS },
  my_tasks: { trigger: MY_TASK_TRIGGER_PARAMS, condition: MY_TASK_CONDITION_PARAMS, action: MY_TASK_ACTION_PARAMS },
};

// Every step type of a system and kind (the vocabulary lists the pickers offer).
export const STEP_TYPES: Record<RuleSystem, Record<StepKind, readonly { value: string; label: string }[]>> = {
  project: { trigger: TRIGGERS, condition: CONDITIONS, action: ACTIONS },
  portfolio: { trigger: PORTFOLIO_TRIGGERS, condition: PORTFOLIO_CONDITIONS, action: PORTFOLIO_ACTIONS },
  my_tasks: { trigger: MY_TASK_TRIGGERS, condition: MY_TASK_CONDITIONS, action: MY_TASK_ACTIONS },
};

// The settings a step declares (null for a type the registry doesn't know).
export function stepParams(type: string, scope: Pick<StepScope, "system" | "kind">): RuleParam[] | null {
  return REGISTRY[scope.system][scope.kind][type] ?? null;
}

// The settings of a step that apply given its other settings (`when`).
export function activeParams(step: RuleStep, scope: StepScope): RuleParam[] {
  return (stepParams(step.type, scope) ?? []).filter((p) => !p.when || p.when(step));
}

export function isRequired(param: RuleParam, step: RuleStep, scope: StepScope) {
  return typeof param.required === "function" ? param.required(step, scope) : param.required === true;
}

// Is this value set? Empty text, an empty list, and a missing key aren't; null only where it's a
// choice of its own (nullable).
export function hasValue(value: Json | undefined, param: Pick<RuleParam, "nullable" | "editor">): boolean {
  if (value === undefined) return false;
  if (value === null) return param.nullable === true;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (param.editor === "titles") return value.some((t) => typeof t === "string" && t.trim() !== "");
    return value.length > 0;
  }
  return true;
}

// Settings of this step that are missing — required and unset, or optional but present and empty
// ("" for a section, [] for "which dependencies"), which the database refuses: an optional setting is
// either left out or set. Free text may be left empty.
export function missingParams(step: RuleStep, scope: StepScope): RuleParam[] {
  return activeParams(step, scope).filter((p) => {
    const value = step[p.key];
    if (isRequired(p, step, scope)) return !hasValue(value, p);
    return p.editor !== "text" && p.editor !== "titles" && value !== undefined && !hasValue(value, p);
  });
}

// A set value that doesn't fit (out of range, a bad address).
function shapeProblem(param: RuleParam, value: Json | undefined): string | null {
  if (value === undefined || value === null || !hasValue(value, param)) return null;
  if (param.range) {
    const [min, max] = param.range;
    if (typeof value !== "number" || value < min || value > max) return `${param.ask}: from ${min} to ${max}`;
  }
  return param.check ? param.check(value) : null;
}

// What this step still needs, in plain English ("Choose a task type"). Unknown types ask for a type.
export function stepProblems(step: RuleStep, scope: StepScope): string[] {
  if (!stepParams(step.type, scope)) {
    return [scope.kind === "trigger" ? "Choose a trigger" : scope.kind === "condition" ? "Choose a condition" : "Choose an action"];
  }
  const missing = missingParams(step, scope);
  const shapes = activeParams(step, scope).flatMap((p) => (missing.includes(p) ? [] : (shapeProblem(p, step[p.key]) ?? [])));
  return [...missing.map((p) => p.ask), ...shapes];
}

// The summary's words for a setting still to choose: "(choose a task type)".
export function chooseText(ask: string) {
  return `(${ask.charAt(0).toLowerCase()}${ask.slice(1)})`;
}

// The summary's words for a step's missing setting, by key ("(choose a task type)"), or `fallback`.
export function chooseFor(type: string, key: string, scope: Pick<StepScope, "system" | "kind">, fallback = "(choose one)") {
  const param = stepParams(type, scope)?.find((p) => p.key === key);
  return param ? chooseText(param.ask) : fallback;
}

export type RuleShape = {
  triggerType: string;
  triggerConfig: Record<string, Json>;
  conditions: readonly RuleStep[];
  actions: readonly RuleStep[];
};

function branchOf(item: RuleStep) {
  const b = item.branch;
  return typeof b === "number" && Number.isInteger(b) && b >= 0 ? b : 0;
}

// Every problem of a whole rule, each saying where it is: "When: Choose a section", "Condition 2:
// Choose a tag", "Otherwise, action 1: Choose a task type". Empty = ready to save.
export function ruleProblems(rule: RuleShape, system: RuleSystem, opts: { v3?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const message of stepProblems({ type: rule.triggerType, ...rule.triggerConfig }, { system, kind: "trigger", v3: opts.v3 })) {
    out.push(`When: ${message}`);
  }
  const branches = 1 + Math.max(0, ...rule.conditions.map(branchOf), ...rule.actions.map(branchOf));
  const where = (b: number, word: string, i: number) => {
    if (branches === 1) return `${word.charAt(0).toUpperCase()}${word.slice(1)} ${i}`;
    const hasConditions = rule.conditions.some((c) => branchOf(c) === b);
    const label = b === 0 ? "If" : b === branches - 1 && !hasConditions ? "Otherwise" : `Otherwise if ${b}`;
    return `${label}, ${word} ${i}`;
  };
  for (const [kind, items] of [
    ["condition", rule.conditions],
    ["action", rule.actions],
  ] as const) {
    const counters = new Map<number, number>();
    for (const item of items) {
      const b = branchOf(item);
      const i = (counters.get(b) ?? 0) + 1;
      counters.set(b, i);
      for (const message of stepProblems(item, { system, kind, v3: opts.v3 })) out.push(`${where(b, kind, i)}: ${message}`);
    }
  }
  return out;
}

// The first problem, phrased for a disabled Save button ("Choose a task type (action 2)").
export function saveBlockedReason(problems: readonly string[]): string | null {
  const first = problems[0];
  if (!first) return null;
  const at = first.indexOf(": ");
  const text = at < 0 ? first : `${first.slice(at + 2)} (${first.slice(0, at).toLowerCase()})`;
  return problems.length > 1 ? `${text} and ${problems.length - 1} more` : text;
}
