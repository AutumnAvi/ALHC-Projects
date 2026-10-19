import type { Json } from "@/lib/supabase/database.types";

// Vocabulary of the rules engine (see the workflows migration). The database validates every rule
// (`validate_rule`) and runs it; this module only describes rules for the builder UI.

// Each entry has a group, a one-line description, and search keywords for the rule builder's picker.
export const TRIGGERS = [
  { value: "task_created", label: "Task is added to this project", group: "Task", description: "Fires when a task is created in this project or a form or webhook adds one.", keywords: ["new", "created", "added"] },
  { value: "section_changed", label: "Task moves into a section", group: "Task", description: "Fires when a task enters a section you pick.", keywords: ["moved", "column", "status", "stage"] },
  { value: "field_changed", label: "A field changes", group: "Fields", description: "Fires when a custom field changes, or changes to a value you pick.", keywords: ["custom field", "priority", "value"] },
  { value: "assignee_changed", label: "Assignee changes", group: "People", description: "Fires when someone is assigned, reassigned, or unassigned.", keywords: ["assign", "owner", "person"] },
  { value: "due_approaching", label: "Due date is approaching", group: "Dates", description: "Fires once per open task a number of days before its due date.", keywords: ["deadline", "reminder", "soon"] },
  { value: "approval_decided", label: "An approval is decided", group: "Approvals and forms", description: "Fires when an approver approves, requests changes, or rejects.", keywords: ["approve", "review", "rejected", "changes requested"] },
  { value: "form_submitted", label: "A form is submitted", group: "Approvals and forms", description: "Fires when someone submits one of this project's forms.", keywords: ["intake", "request", "submission"] },
  { value: "inbound_received", label: "Created by inbound webhook", group: "Integrations", description: "Fires when a task comes in through one of this project's inbound webhooks.", keywords: ["api", "zapier", "make", "webhook"] },
] as const;

export type TriggerType = (typeof TRIGGERS)[number]["value"];

export const CONDITIONS = [
  { value: "section_is", label: "Section is", group: "Task", description: "The task is in a section you pick.", keywords: ["column", "stage"] },
  { value: "section_is_not", label: "Section is not", group: "Task", description: "The task is in any other section.", keywords: ["column", "stage", "not"] },
  { value: "is_incomplete", label: "Task is incomplete", group: "Task", description: "The task isn't marked complete.", keywords: ["open", "not done"] },
  { value: "is_complete", label: "Task is complete", group: "Task", description: "The task is marked complete.", keywords: ["done", "finished"] },
  { value: "source_is", label: "Task came from", group: "Task", description: "Created in the app, by a form, an import, or an inbound webhook.", keywords: ["source", "form", "import", "origin"] },
  { value: "field_equals", label: "Field equals", group: "Fields", description: "A custom field has the value you pick.", keywords: ["custom field", "value", "is"] },
  { value: "field_is_set", label: "Field is set", group: "Fields", description: "A custom field has any value.", keywords: ["custom field", "filled", "not empty"] },
  { value: "field_is_empty", label: "Field is empty", group: "Fields", description: "A custom field has no value.", keywords: ["custom field", "blank", "missing"] },
  { value: "assignee_is_set", label: "Has an assignee", group: "People", description: "Someone is assigned.", keywords: ["assign", "assigned"] },
  { value: "assignee_is_empty", label: "Has no assignee", group: "People", description: "Nobody is assigned yet.", keywords: ["assign", "unassigned"] },
] as const;

export type ConditionType = (typeof CONDITIONS)[number]["value"];

export const ACTIONS = [
  { value: "move_section", label: "Move to section", group: "Task", description: "Moves the task to a section of this project.", keywords: ["column", "stage", "status"] },
  { value: "set_field", label: "Set field", group: "Fields", description: "Writes a value into a custom field (Status moves the section).", keywords: ["custom field", "priority", "value"] },
  { value: "set_assignee", label: "Set assignee", group: "People", description: "Assigns a person, the creator, or nobody.", keywords: ["assign", "owner", "unassign", "remove assignee"] },
  { value: "add_followers", label: "Add followers", group: "People", description: "Adds collaborators who'll hear about updates.", keywords: ["collaborator", "follow", "watch"] },
  { value: "add_comment", label: "Add comment", group: "Communication", description: "Posts a comment on the task as this rule.", keywords: ["message", "note", "mention"] },
  { value: "notify", label: "Send inbox notification", group: "Communication", description: "Puts a message in people's Inbox.", keywords: ["alert", "inbox", "ping", "tell"] },
  { value: "send_email", label: "Send email", group: "Communication", description: "Emails the submitter, the assignee, an address in a field, or a fixed address.", keywords: ["mail", "requester", "submitter"] },
  { value: "request_approval", label: "Request approval (approval subtask)", group: "Approvals", description: "Asks someone to approve, with an approval subtask.", keywords: ["approve", "review", "sign off"] },
  { value: "send_slack", label: "Send Slack message", group: "Integrations", description: "Posts to a Slack channel through an incoming webhook.", keywords: ["chat", "channel"] },
  { value: "call_webhook", label: "Call webhook", group: "Integrations", description: "POSTs a JSON summary of the task to an https:// address.", keywords: ["api", "zapier", "make", "http"] },
  { value: "delay", label: "Wait, then continue", group: "Flow", description: "Pauses for some hours, then runs the remaining actions.", keywords: ["delay", "later", "pause", "hours"] },
] as const;

export type ActionType = (typeof ACTIONS)[number]["value"];

export const APPROVAL_DECISIONS = [
  { value: "approved", label: "Approved" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "rejected", label: "Rejected" },
] as const;

export const EMAIL_RECIPIENTS = [
  { value: "submitter", label: "Form submitter", description: "Whoever submitted the form that made this task." },
  { value: "assignee", label: "Assignee", description: "The task's assignee." },
  { value: "field", label: "Email in a field", description: "The address written in a text field." },
  { value: "address", label: "Fixed address", description: "Always the same address." },
] as const;

export const EMAIL_TEMPLATES = [
  { value: "requester_update", label: "Requester update", description: "“Your request moved to …” with the task, project, and section." },
  { value: "due_tomorrow", label: "Due tomorrow", description: "A reminder that the task is due tomorrow." },
  { value: "custom", label: "Plain message", description: "Just your subject and message." },
] as const;

// Where a task can come from (the "Task came from" condition; mirrors validate_rule).
export const TASK_SOURCES = [
  { value: "manual", label: "Created in the app", description: "Someone added it in a list, board, or My tasks." },
  { value: "form", label: "A form", description: "A form submission made it." },
  { value: "import", label: "An import", description: "The Asana importer brought it in." },
  { value: "inbound", label: "An inbound webhook", description: "Another tool sent it in." },
] as const;

// People slots accept a profile id or one of these roles.
export const PERSON_ROLES = [
  { value: "assignee", label: "Task assignee" },
  { value: "creator", label: "Task creator" },
] as const;

export const TEXT_TOKENS = "{assignee} {creator} {task} {section} {project} {req} {due} {approval_note}";

// Integration actions (see the integrations migration). Stored shapes, as the builder reads them:
//   send_slack   { message, format?: "text" | "blocks", use_project_webhook?, webhook_ref?, webhook_hint? }
//   call_webhook { use_project_webhook?, url_ref?, url_hint?, secret_ref?, secret_set?, secret_header?,
//                  signing_ref?, signing_set? }
// Slack messages also take {task_link}. A Call webhook action's own signing secret is generated by the
// Server Action (the builder sends generate_signing_secret: true; "" for signing_secret removes it).
// To set or replace a value the builder sends webhook_url / url / secret (plain text) instead of the
// ref; a database trigger stores it out of reach of clients and writes back a ref + redacted hint.
// Sending "" for url / secret clears it. Without use_project_webhook the action's own URL wins and
// the project default (Settings → Integrations) is the fallback.
export const INTEGRATION_KEYS = {
  send_slack: { plain: "webhook_url", ref: "webhook_ref", hint: "webhook_hint" },
  call_webhook: { plain: "url", ref: "url_ref", hint: "url_hint" },
} as const;

export type RuleCondition = { type: ConditionType } & Record<string, Json>;
export type RuleAction = { type: ActionType } & Record<string, Json>;

export type RuleDef = {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  triggerType: TriggerType;
  triggerConfig: Record<string, Json>;
  conditions: RuleCondition[];
  actions: RuleAction[];
  presetKey: string | null;
};

export type RuleRun = {
  id: string;
  ruleId: string;
  taskId: string | null;
  taskTitle: string | null;
  status: "succeeded" | "failed" | "skipped" | "scheduled";
  detail: Json;
  createdAt: string;
};

export type PresetInput = {
  key: string;
  label: string;
  kind: "section" | "field" | "person" | "text" | "number";
  default?: Json;
};

export type RulePreset = {
  key: string;
  name: string;
  description: string;
  inputs: PresetInput[];
  ruleCount: number;
};

export function isTriggerType(value: unknown): value is TriggerType {
  return TRIGGERS.some((t) => t.value === value);
}

export function labelOf<T extends readonly { value: string; label: string }[]>(list: T, value: unknown) {
  return list.find((item) => item.value === value)?.label ?? String(value);
}

function record(value: Json): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {};
}

function typedList<T extends { type: string }>(value: Json): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const r = record(item);
    return typeof r.type === "string" ? [r as T] : [];
  });
}

export function toRuleDef(row: {
  id: string;
  project_id: string;
  name: string;
  enabled: boolean;
  trigger_type: string;
  trigger_config: Json;
  conditions: Json;
  actions: Json;
  preset_key: string | null;
}): RuleDef {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    enabled: row.enabled,
    triggerType: isTriggerType(row.trigger_type) ? row.trigger_type : "task_created",
    triggerConfig: record(row.trigger_config),
    conditions: typedList<RuleCondition>(row.conditions),
    actions: typedList<RuleAction>(row.actions),
    presetKey: row.preset_key,
  };
}

export function parsePresetInputs(value: Json): PresetInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const r = record(item);
    if (typeof r.key !== "string" || typeof r.label !== "string" || typeof r.kind !== "string") return [];
    return [{ key: r.key, label: r.label, kind: r.kind as PresetInput["kind"], ...(r.default !== undefined ? { default: r.default } : {}) }];
  });
}

export function runReason(detail: Json): string | null {
  const d = record(detail);
  if (typeof d.reason === "string") {
    return (
      { loop: "loop prevented", depth_limit: "chain too deep", throttled: "throttled" }[d.reason] ?? d.reason
    );
  }
  if (typeof d.error === "string") return d.error;
  // Failed runs log { actions: { error } } (run_rule catches the error around all actions).
  const actions = record(d.actions ?? null);
  if (typeof actions.error === "string") return actions.error;
  return null;
}

export function triggerLabel(type: TriggerType): string {
  return labelOf(TRIGGERS, type);
}

// Rule branches (Asana parity, batch 4; mirrors rule_item_branch() / validate_rule_branches() in
// 20261011040000_asana_parity_4.sql): conditions and actions may carry "branch": 0–4 (missing = 0).
// Branch 0 is "Check if", the next ones "Else if"; the first branch whose conditions pass runs its
// actions, and a last branch without conditions is "Otherwise". A rule without branch keys is one
// branch, exactly as before.
export const MAX_RULE_BRANCHES = 5;
export const MAX_BRANCH_ACTIONS = 10;
export const MAX_BRANCH_CONDITIONS = 20;

export type RuleBranch = { conditions: RuleCondition[]; actions: RuleAction[] };

export function itemBranch(item: Record<string, Json>): number {
  const value = item.branch;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MAX_RULE_BRANCHES ? value : 0;
}

export function ruleBranchCount(rule: Pick<RuleDef, "conditions" | "actions">): number {
  return 1 + Math.max(0, ...rule.conditions.map(itemBranch), ...rule.actions.map(itemBranch));
}

function withoutBranch<T extends Record<string, Json>>(item: T): T {
  const copy = { ...item };
  delete copy.branch;
  return copy;
}

// The rule's branches in order, without their branch keys (for the builder).
export function splitBranches(rule: Pick<RuleDef, "conditions" | "actions">): RuleBranch[] {
  return Array.from({ length: ruleBranchCount(rule) }, (_, b) => ({
    conditions: rule.conditions.filter((c) => itemBranch(c) === b).map(withoutBranch),
    actions: rule.actions.filter((a) => itemBranch(a) === b).map(withoutBranch),
  }));
}

// Back to the stored lists. A single branch writes no branch keys (byte-for-byte the old shape).
export function joinBranches(branches: RuleBranch[]): Pick<RuleDef, "conditions" | "actions"> {
  if (branches.length <= 1) {
    return { conditions: branches[0]?.conditions ?? [], actions: branches[0]?.actions ?? [] };
  }
  return {
    conditions: branches.flatMap((b, i) => b.conditions.map((c) => (i === 0 ? withoutBranch(c) : { ...c, branch: i }))),
    actions: branches.flatMap((b, i) => b.actions.map((a) => (i === 0 ? withoutBranch(a) : { ...a, branch: i }))),
  };
}

// The same checks as validate_rule_branches(), for a clear message before saving.
export function branchProblem(branches: RuleBranch[]): string | null {
  if (branches.length > MAX_RULE_BRANCHES) return `A rule can have up to ${MAX_RULE_BRANCHES} branches`;
  for (const [i, b] of branches.entries()) {
    const name = i === 0 ? "Check if" : i === branches.length - 1 && b.conditions.length === 0 ? "Otherwise" : `Else if ${i}`;
    if (b.actions.length === 0) return `${name}: add at least one action`;
    if (b.actions.length > MAX_BRANCH_ACTIONS) return `${name}: up to ${MAX_BRANCH_ACTIONS} actions`;
    if (b.conditions.length > MAX_BRANCH_CONDITIONS) return `${name}: up to ${MAX_BRANCH_CONDITIONS} conditions`;
    if (branches.length > 1 && b.conditions.length === 0 && i < branches.length - 1) {
      return `${name}: add a condition (only the last branch, Otherwise, can run without one)`;
    }
  }
  return null;
}
