import type { Json } from "@/lib/supabase/database.types";
import { dayLabel } from "@/lib/date-input";
import { formatNumberValue, numberPrefixOf } from "@/lib/fields";

// Portfolio rules (Automations V3, batch D; mirrors validate_portfolio_rule() and the engine in
// 20261021010000_automations_v3_a.sql). A portfolio rule acts on the projects directly in the portfolio,
// with its owner's own access. Each entry has a group, a description, and search keywords for the
// builder's picker (like src/lib/rules.ts).

export const PORTFOLIO_TRIGGERS = [
  { value: "item_added", label: "A project is added", group: "Portfolio", description: "Fires when a project is added to this portfolio.", keywords: ["work", "new", "item"] },
  { value: "item_removed", label: "A project is removed", group: "Portfolio", description: "Fires when a project is taken out of this portfolio.", keywords: ["work", "item", "removed"] },
  { value: "status_changed", label: "Status changes", group: "Project", description: "Fires when a project's status changes (to any status, or ones you pick).", keywords: ["on track", "at risk", "off track", "on hold", "complete"] },
  { value: "owner_changed", label: "Owner changes", group: "Project", description: "Fires when a project gets a new owner.", keywords: ["owner", "transfer", "person"] },
  { value: "field_changed", label: "A field changes", group: "Project", description: "Fires when one of this portfolio's fields changes on a project.", keywords: ["custom field", "value"] },
  { value: "due_date_changed", label: "Due date changes", group: "Dates", description: "Fires when a project's due date is set, moved, or cleared.", keywords: ["deadline", "reschedule"] },
  { value: "due_approaching", label: "Due date is approaching", group: "Dates", description: "Fires once per project some days before its due date.", keywords: ["deadline", "soon", "reminder"] },
  { value: "item_overdue", label: "Project is overdue", group: "Dates", description: "Fires once per project (not complete) some days after its due date.", keywords: ["late", "past due", "missed"] },
  { value: "scheduled", label: "On a schedule", group: "Flow", description: "Runs every day, workday, week, or month for each project that matches.", keywords: ["daily", "weekly", "every", "time"] },
  { value: "manual", label: "Run manually", group: "Flow", description: "Runs when someone picks a project on the Rules tab.", keywords: ["button", "by hand", "on demand"] },
] as const;
export type PortfolioTriggerType = (typeof PORTFOLIO_TRIGGERS)[number]["value"];

export const PORTFOLIO_CONDITIONS = [
  { value: "status_is", label: "Status is", group: "Project", description: "The project's status is one you pick.", keywords: ["on track", "at risk"] },
  { value: "status_is_not", label: "Status is not", group: "Project", description: "The project's status is none of the ones you pick.", keywords: ["not", "except"] },
  { value: "owner_is", label: "Owner is", group: "Project", description: "One of the people you pick owns the project.", keywords: ["person", "owner"] },
  { value: "owner_is_not", label: "Owner is not", group: "Project", description: "None of the people you pick owns it.", keywords: ["person", "not"] },
  { value: "is_archived", label: "Is archived", group: "Project", description: "The project is archived.", keywords: ["archive", "read-only"] },
  { value: "is_not_archived", label: "Isn’t archived", group: "Project", description: "The project is active.", keywords: ["active"] },
  { value: "has_due_date", label: "Has a due date", group: "Dates", description: "The project has a due date.", keywords: ["deadline"] },
  { value: "no_due_date", label: "Has no due date", group: "Dates", description: "No due date yet.", keywords: ["deadline", "missing"] },
  { value: "is_overdue", label: "Is overdue", group: "Dates", description: "Due before today and not complete.", keywords: ["late", "past due"] },
  { value: "due_within", label: "Due within", group: "Dates", description: "Due today or in the next few days.", keywords: ["soon", "upcoming"] },
  { value: "date_compare", label: "Due date is", group: "Dates", description: "Before, after, on, or between dates you pick.", keywords: ["before", "after", "between", "range"] },
  { value: "field_equals", label: "Field is", group: "Fields", description: "One of this portfolio's fields has the value you pick.", keywords: ["custom field", "value"] },
  { value: "field_is_set", label: "Field is set", group: "Fields", description: "A portfolio field has any value.", keywords: ["filled"] },
  { value: "field_is_empty", label: "Field is empty", group: "Fields", description: "A portfolio field has no value.", keywords: ["blank", "missing"] },
] as const;
export type PortfolioConditionType = (typeof PORTFOLIO_CONDITIONS)[number]["value"];

export const PORTFOLIO_ACTIONS = [
  { value: "set_status", label: "Set status", group: "Project", description: "Posts a status update on the project (with an optional note).", keywords: ["on track", "at risk", "complete", "update"] },
  { value: "status_reminder", label: "Send a status reminder", group: "Communication", description: "Asks the project's owner, in their Inbox, to post a status update.", keywords: ["nudge", "remind", "update"] },
  { value: "notify", label: "Send inbox notification", group: "Communication", description: "Puts a message about the project in people's Inbox.", keywords: ["alert", "tell", "ping"] },
  { value: "set_owner", label: "Change owner", group: "Project", description: "Makes someone the project's owner (the rule's owner must own it).", keywords: ["transfer", "person"] },
  { value: "set_due_date", label: "Set due date", group: "Dates", description: "Sets the project's due date on a day, some days from today, or clears it.", keywords: ["deadline", "clear"] },
  { value: "set_name", label: "Rename project", group: "Project", description: "Changes the project's name (placeholders work).", keywords: ["title", "name", "prefix"] },
  { value: "set_field", label: "Set field", group: "Fields", description: "Writes a value into one of this portfolio's fields.", keywords: ["custom field", "value"] },
  { value: "add_members", label: "Add members", group: "People", description: "Gives people access to the project with a role.", keywords: ["invite", "share", "access"] },
  { value: "remove_members", label: "Remove members", group: "People", description: "Takes people out of the project (owners stay).", keywords: ["access", "revoke"] },
  { value: "archive_project", label: "Archive project", group: "Project", description: "Makes the project read-only and moves it out of the way.", keywords: ["close", "done"] },
  { value: "remove_from_portfolio", label: "Remove from this portfolio", group: "Portfolio", description: "Takes the project out of this portfolio.", keywords: ["work", "remove"] },
  { value: "add_to_portfolio", label: "Add to another portfolio", group: "Portfolio", description: "Also lists the project in another portfolio you edit.", keywords: ["work", "copy", "move"] },
] as const;
export type PortfolioActionType = (typeof PORTFOLIO_ACTIONS)[number]["value"];

export const PROJECT_STATUSES = [
  { value: "on_track", label: "On track" },
  { value: "at_risk", label: "At risk" },
  { value: "off_track", label: "Off track" },
  { value: "on_hold", label: "On hold" },
  { value: "complete", label: "Complete" },
] as const;

export const MEMBER_ROLES = [
  { value: "admin", label: "Admin" },
  { value: "editor", label: "Editor" },
  { value: "commenter", label: "Commenter" },
  { value: "viewer", label: "Viewer" },
] as const;

// Notify: the project's owner(s), all its members, or people.
export const PROJECT_PEOPLE_ROLES = [
  { value: "owner", label: "Project owner" },
  { value: "members", label: "Everyone in the project" },
] as const;

export type PortfolioRuleItem = { type: string } & Record<string, Json>;

export type PortfolioRuleDef = {
  id: string;
  portfolioId: string;
  name: string;
  enabled: boolean;
  triggerType: PortfolioTriggerType;
  triggerConfig: Record<string, Json>;
  conditions: PortfolioRuleItem[];
  actions: PortfolioRuleItem[];
  ownerId: string | null;
  nextRunAt: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  lastEditedAt: string | null;
  // Batch E: paused by a person until this time.
  pausedUntil: string | null;
};

export type PortfolioRuleRun = {
  id: string;
  ruleId: string;
  projectId: string | null;
  projectName: string | null;
  status: "succeeded" | "failed" | "skipped";
  detail: Json;
  createdAt: string;
};

// What the builder knows about the portfolio.
export type PortfolioRuleContext = {
  portfolioName: string;
  // numberPrefix: a number field's symbol (item 49).
  fields: { id: string; name: string; fieldType: string; options: { id: string; name: string; color: string }[]; numberPrefix?: string | null }[];
  people: { id: string; name: string }[];
  members: { id: string; name: string }[];
  // Other portfolios the viewer edits (Add to another portfolio).
  otherPortfolios: { id: string; name: string }[];
  // The portfolio's projects the viewer can open (manual runs).
  projects: { id: string; name: string }[];
  workWeek?: number[];
};

function record(value: Json | undefined): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {};
}

function items(value: Json): PortfolioRuleItem[] {
  return Array.isArray(value)
    ? value.flatMap((x) => {
        const r = record(x);
        return typeof r.type === "string" ? [r as PortfolioRuleItem] : [];
      })
    : [];
}

export function isPortfolioTrigger(value: unknown): value is PortfolioTriggerType {
  return PORTFOLIO_TRIGGERS.some((t) => t.value === value);
}

export function toPortfolioRuleDef(row: {
  id: string;
  portfolio_id: string;
  name: string;
  enabled: boolean;
  trigger_type: string;
  trigger_config: Json;
  conditions: Json;
  actions: Json;
  owner_id: string | null;
  next_run_at: string | null;
  paused_at: string | null;
  pause_reason: string | null;
  last_edited_at: string | null;
  paused_until?: string | null;
}): PortfolioRuleDef {
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    name: row.name,
    enabled: row.enabled,
    triggerType: isPortfolioTrigger(row.trigger_type) ? row.trigger_type : "manual",
    triggerConfig: record(row.trigger_config),
    conditions: items(row.conditions),
    actions: items(row.actions),
    ownerId: row.owner_id,
    nextRunAt: row.next_run_at,
    pausedAt: row.paused_at,
    pauseReason: row.pause_reason,
    lastEditedAt: row.last_edited_at,
    pausedUntil: row.paused_until ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------

const label = (list: readonly { value: string; label: string }[], value: Json | undefined) =>
  list.find((x) => x.value === value)?.label ?? String(value ?? "…");

function joinWords(words: string[], word: "or" | "and") {
  if (words.length <= 2) return words.join(` ${word} `);
  return `${words.slice(0, -1).join(", ")}, ${word} ${words[words.length - 1]}`;
}

function strings(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function whole(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function day(value: Json | undefined) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? dayLabel(value, 0) : "…";
}

export function portfolioPersonName(ctx: PortfolioRuleContext, value: Json | undefined) {
  const role = PROJECT_PEOPLE_ROLES.find((r) => r.value === value);
  if (role) return role.value === "owner" ? "the project owner" : "everyone in the project";
  return ctx.people.find((p) => p.id === value)?.name ?? "someone removed";
}

function fieldOf(ctx: PortfolioRuleContext, id: Json | undefined) {
  return ctx.fields.find((f) => f.id === id);
}

export function portfolioFieldValueLabel(ctx: PortfolioRuleContext, fieldId: Json | undefined, value: Json | undefined) {
  const field = fieldOf(ctx, fieldId);
  if (value === null || value === undefined || value === "") return "empty";
  if (field?.fieldType === "single_select") return field.options.find((o) => o.id === value)?.name ?? "a removed option";
  if (field?.fieldType === "date") return day(value);
  if (field?.fieldType === "text") return `“${String(value)}”`;
  if (field?.fieldType === "number" && typeof value === "number") return formatNumberValue(value, numberPrefixOf(field));
  return String(value);
}

const statuses = (value: Json | undefined) => strings(value).map((s) => label(PROJECT_STATUSES, s).toLowerCase());

// Is a setting given (not missing, not empty)? A missing one reads "(choose …)" in the sentence.
function given(value: Json | undefined) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function quote(value: Json | undefined) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;
}

export function describePortfolioTrigger(rule: Pick<PortfolioRuleDef, "triggerType" | "triggerConfig">, ctx: PortfolioRuleContext) {
  const cfg = rule.triggerConfig;
  switch (rule.triggerType) {
    case "item_added":
      return "A project is added to this portfolio";
    case "item_removed":
      return "A project is removed from this portfolio";
    case "status_changed": {
      const s = statuses(cfg.statuses);
      return s.length ? `A project’s status changes to ${joinWords(s, "or")}` : "A project’s status changes to any status";
    }
    case "owner_changed":
      return "A project gets a new owner";
    case "field_changed": {
      const field = fieldOf(ctx, cfg.field_id);
      const base = `${field ? field.name : given(cfg.field_id) ? "A removed field" : "(choose the field that changes)"} changes`;
      return cfg.option_id ? `${base} to ${portfolioFieldValueLabel(ctx, cfg.field_id, cfg.option_id)}` : base;
    }
    case "due_date_changed":
      return "A project’s due date changes";
    case "due_approaching": {
      const n = whole(cfg.days) ?? 1;
      return n === 0 ? "A project is due today" : `A project is due in ${n} day${n === 1 ? "" : "s"}`;
    }
    case "item_overdue": {
      const n = Math.max(whole(cfg.days) ?? 1, 1);
      return n === 1 ? "A project becomes overdue" : `A project is ${n} days overdue`;
    }
    case "scheduled":
      return given(cfg.frequency) ? "On a schedule" : "On a schedule (choose how often)";
    case "manual":
      return "Someone runs it on a project";
    default:
      return label(PORTFOLIO_TRIGGERS, rule.triggerType);
  }
}

function fieldName(ctx: PortfolioRuleContext, id: Json | undefined) {
  return fieldOf(ctx, id)?.name ?? (given(id) ? "a removed field" : "(choose a field)");
}

export function describePortfolioCondition(c: PortfolioRuleItem, ctx: PortfolioRuleContext) {
  switch (c.type) {
    case "status_is":
    case "status_is_not": {
      const s = statuses(c.statuses);
      return `status ${c.type === "status_is" ? "is" : "isn’t"} ${s.length ? joinWords(s, "or") : "(choose statuses)"}`;
    }
    case "owner_is":
    case "owner_is_not": {
      const names = strings(c.people).map((p) => portfolioPersonName(ctx, p));
      return `owner ${c.type === "owner_is" ? "is" : "isn’t"} ${names.length ? joinWords(names, "or") : "(choose people)"}`;
    }
    case "due_within": {
      const n = whole(c.days);
      return n === null ? "is due within (enter a number of days)" : n === 0 ? "is due today" : `is due within ${n} day${n === 1 ? "" : "s"}`;
    }
    case "date_compare": {
      const op = String(c.op ?? "");
      const words: Record<string, string> = {
        before: "is before", after: "is after", on: "is on", on_or_before: "is on or before", on_or_after: "is on or after",
        between: "is between", not_between: "isn’t between",
      };
      const range = op === "between" || op === "not_between";
      const date = (v: Json | undefined, ask: string) => (given(v) ? day(v) : ask);
      return `the due date ${words[op] ?? "(choose a comparison)"} ${date(c.value, "(choose a date)")}${range ? ` and ${date(c.to, "(choose the end date)")}` : ""}`;
    }
    case "is_archived":
      return "it’s archived";
    case "is_not_archived":
      return "it isn’t archived";
    case "has_due_date":
      return "it has a due date";
    case "no_due_date":
      return "it has no due date";
    case "is_overdue":
      return "it’s overdue";
    case "field_equals":
      return `${fieldName(ctx, c.field_id)} is ${given(c.value) ? portfolioFieldValueLabel(ctx, c.field_id, c.value) : "(choose a value)"}`;
    case "field_is_set":
    case "field_is_empty":
      return `${fieldName(ctx, c.field_id)} is ${c.type === "field_is_set" ? "set" : "empty"}`;
    default:
      return label(PORTFOLIO_CONDITIONS, c.type).toLowerCase();
  }
}

export function describePortfolioAction(a: PortfolioRuleItem, ctx: PortfolioRuleContext) {
  switch (a.type) {
    case "set_status":
      return given(a.status) ? `set the status to ${label(PROJECT_STATUSES, a.status).toLowerCase()}` : "set the status to (choose a status)";
    case "status_reminder":
      return "remind the owner to post a status update";
    case "notify": {
      const names = strings(a.people).map((p) => portfolioPersonName(ctx, p));
      return `notify ${names.length ? joinWords(names, "and") : "(choose who to notify)"}: ${given(a.message) ? quote(a.message) : "(write the message)"}`;
    }
    case "set_owner":
      return `make ${given(a.person) ? portfolioPersonName(ctx, a.person) : "(choose the new owner)"} the owner`;
    case "set_due_date": {
      if (a.mode === "clear") return "clear the due date";
      if (a.mode === "date") return `set the due date to ${given(a.date) ? day(a.date) : "(choose a date)"}`;
      const n = whole(a.days);
      if (n === null) return "set the due date to (enter a number of days)";
      const unit = `${a.business_days === true ? "business " : ""}day${Math.abs(n) === 1 ? "" : "s"}`;
      return n === 0 ? "set the due date to today" : `set the due date to ${Math.abs(n)} ${unit} ${n < 0 ? "before" : "from"} today`;
    }
    case "set_name":
      return `rename to ${given(a.name) ? quote(a.name) : "(write the new name)"}`;
    case "set_field":
      return `set ${fieldName(ctx, a.field_id)} to ${portfolioFieldValueLabel(ctx, a.field_id, a.value)}`;
    case "add_members":
    case "remove_members": {
      const names = strings(a.people).map((p) => portfolioPersonName(ctx, p));
      const who = names.length ? joinWords(names, "and") : a.type === "add_members" ? "(choose people to add)" : "(choose people to remove)";
      return a.type === "add_members" ? `add ${who} as ${label(MEMBER_ROLES, a.role ?? "editor").toLowerCase()}` : `remove ${who}`;
    }
    case "archive_project":
      return "archive the project";
    case "remove_from_portfolio":
      return "remove it from this portfolio";
    case "add_to_portfolio":
      if (!given(a.portfolio_id)) return "add it to (choose a portfolio)";
      return `add it to “${ctx.otherPortfolios.find((p) => p.id === a.portfolio_id)?.name ?? "another portfolio"}”`;
    default:
      return label(PORTFOLIO_ACTIONS, a.type).toLowerCase();
  }
}

// "When a project's status changes to at risk, if the owner is Dana, remind the owner and add Sam as viewer."
export function portfolioRuleSentence(rule: Pick<PortfolioRuleDef, "triggerType" | "triggerConfig" | "conditions" | "actions">, ctx: PortfolioRuleContext, scheduleText?: string) {
  const trigger = rule.triggerType === "scheduled" && scheduleText ? scheduleText : describePortfolioTrigger(rule, ctx);
  const when = rule.triggerType === "scheduled" ? `${trigger}, for each project` : `When ${trigger.charAt(0).toLowerCase()}${trigger.slice(1)}`;
  const conditions = rule.conditions.map((c) => describePortfolioCondition(c, ctx)).join(" and ");
  const actions = rule.actions.map((a) => describePortfolioAction(a, ctx)).join(", then ") || "do nothing yet";
  return `${when}, ${conditions ? `if ${conditions}, ` : ""}${actions}.`;
}

// New items' defaults.
export function portfolioActionDefaults(type: PortfolioActionType): PortfolioRuleItem {
  switch (type) {
    case "set_status":
      return { type, status: "at_risk" };
    case "notify":
      return { type, people: ["owner"], message: "" };
    case "set_due_date":
      return { type, mode: "relative", days: 7, business_days: true };
    case "set_name":
      return { type, name: "{{project.name}}" };
    case "add_members":
      return { type, people: [], role: "editor" };
    case "remove_members":
      return { type, people: [] };
    default:
      return { type };
  }
}

export function portfolioConditionDefaults(type: PortfolioConditionType): PortfolioRuleItem {
  switch (type) {
    case "status_is":
    case "status_is_not":
      return { type, statuses: ["at_risk"] };
    case "due_within":
      return { type, days: 7 };
    case "date_compare":
      return { type, op: "before" };
    default:
      return { type };
  }
}

export const PORTFOLIO_TEXT_PLACEHOLDERS = [
  { key: "project.name", label: "Project name" },
  { key: "project.status", label: "Status" },
  { key: "project.due_date", label: "Due date" },
  { key: "project.owner", label: "Owner" },
  { key: "portfolio.name", label: "Portfolio name" },
] as const;
