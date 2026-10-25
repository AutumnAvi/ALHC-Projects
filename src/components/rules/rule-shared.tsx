"use client";

import { CalendarDays, Columns3, Contact, PenLine, User, UserMinus } from "lucide-react";
import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { useParamSlot } from "@/components/param-slot";
import { Popover } from "@/components/popover";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import { SingleDatePicker } from "@/components/task/date-picker";
import { dayLabel, formatTime } from "@/lib/date-input";
import { OPTION_SWATCH_CLASSES, type FieldDef, type OptionColor } from "@/lib/fields";
import type { ProjectIntegrations } from "@/lib/integrations-shared";
import {
  ACTIONS,
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  COMPARE_OPS,
  CREATE_LINKS,
  CONDITIONS,
  DATE_CHANGES,
  DATE_OPS,
  DUE_FROM,
  EMAIL_RECIPIENTS,
  EMAIL_TEMPLATES,
  LIST_OPS,
  OFFSET_UNITS,
  RANGE_OPS,
  PERSON_ROLES,
  PERSON_SIDES,
  TASK_KIND_OPTIONS,
  TRIGGERS,
  UNBLOCK_KINDS,
  V2_ACTIONS,
  V2_CONDITIONS,
  V2_TRIGGERS,
  V3_ACTIONS,
  V3_CONDITIONS,
  V3_TRIGGERS,
  fieldOfSlot,
  fieldSlot,
  labelOf,
  splitBranches,
  splitGroups,
  triggerOffset,
  type RuleAction,
  type RuleCondition,
  type RuleDef,
} from "@/lib/rules";
import type { Json } from "@/lib/supabase/database.types";
import { WEEKDAYS } from "@/lib/workdays";
import { chooseFor, hasValue } from "@/lib/rule-params";

export type RuleContext = {
  sections: { id: string; name: string }[];
  fields: FieldDef[];
  people: { id: string; name: string }[];
  forms: { id: string; title: string; questions?: { id: string; label: string }[] }[];
  // Redacted project defaults (Settings → Integrations); null when not loaded (below Admin).
  integrations: ProjectIntegrations | null;
  // Inbound webhooks of the project (Settings → Inbound); empty below Admin.
  inboundEndpoints: { id: string; name: string }[];
  // Automations V2 (optional so older callers keep compiling).
  projectName?: string;
  // The project's members (a rule's owner must be one).
  members?: { id: string; name: string }[];
  tags?: { id: string; name: string; color: string; archived: boolean }[];
  taskTemplates?: { id: string; name: string }[];
  // Other active projects where the viewer is an Editor+ (Add to another project).
  otherProjects?: { id: string; name: string; sections: { id: string; name: string }[] }[];
  // The workspace's workweek (business days), 0 = Sunday.
  workWeek?: number[];
  // Automations V2's database update is applied (else the new vocabulary is offered but disabled).
  v2?: boolean;
  // Automations V3's database update is applied (the same, for V3's vocabulary).
  v3?: boolean;
  // Batch E (Convert to a project): the workspace's project templates and portfolios the viewer edits.
  projectTemplates?: { id: string; name: string }[];
  portfolios?: { id: string; name: string }[];
};

export const NEEDS_UPDATE = "Needs this release’s database update";

// A picker option's "disabled" reason: vocabulary from a database update that isn't applied yet.
export function needsUpdate(ctx: RuleContext) {
  return (value: string) =>
    (ctx.v2 === false && (V2_TRIGGERS.has(value) || V2_CONDITIONS.has(value) || V2_ACTIONS.has(value))) ||
    (ctx.v3 === false && (V3_TRIGGERS.has(value) || V3_CONDITIONS.has(value) || V3_ACTIONS.has(value)))
      ? NEEDS_UPDATE
      : null;
}

export const inputClass = "control h-auto min-h-7 py-0.5";
// A text or number box whose setting is still missing (rule-params.ts): the amber of an empty picker.
export const MISSING_INPUT = "border-amber-300 bg-amber-50 ring-1 ring-amber-300";

const FIELD_TYPE_LABELS: Record<string, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Checkbox",
  single_select: "Single choice",
  multi_select: "Multiple choice",
  people: "People",
};
export const labelClass = "text-xs font-medium text-zinc-600";

// Fields a rule can write or compare. People fields are left to the task pane.
export function ruleFields(ctx: RuleContext) {
  return ctx.fields.filter((f) => f.fieldType !== "people");
}

function str(value: Json | undefined) {
  return typeof value === "string" ? value : "";
}

export function sectionName(ctx: RuleContext, id: Json | undefined) {
  return ctx.sections.find((s) => s.id === id)?.name ?? "a removed section";
}

// The summary's "(choose a task type)" for a project rule step's setting that's still missing.
const ask = {
  trigger: (type: string, key: string) => chooseFor(type, key, { system: "project", kind: "trigger" }),
  condition: (type: string, key: string) => chooseFor(type, key, { system: "project", kind: "condition" }),
  action: (type: string, key: string) => chooseFor(type, key, { system: "project", kind: "action" }),
};

// Set (not empty) for the summary: a missing value reads as "(choose …)".
function given(value: Json | undefined) {
  return hasValue(value, { editor: "text" });
}

// Rule text in a summary: quoted, cut at 40 characters.
export function quoteText(value: Json | undefined) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;
}

function fieldName(ctx: RuleContext, id: Json | undefined) {
  return ctx.fields.find((f) => f.id === id)?.name ?? "a removed field";
}

export function personName(ctx: RuleContext, value: Json | undefined) {
  const role = PERSON_ROLES.find((r) => r.value === value);
  if (role) return `the ${role.label.toLowerCase()}`;
  const field = fieldOfSlot(value);
  if (field !== null) return `the ${peopleFieldName(ctx, field)} field`;
  return ctx.people.find((p) => p.id === value)?.name ?? "someone removed";
}

// The project's People fields (person slots "field:<id>").
export function peopleFields(ctx: RuleContext) {
  return ctx.fields.filter((f) => f.fieldType === "people");
}

function peopleFieldName(ctx: RuleContext, fieldId: string) {
  const name = ctx.fields.find((f) => f.id === fieldId)?.name;
  return name ? `“${name}”` : "removed People";
}

export function fieldValueLabel(ctx: RuleContext, fieldId: Json | undefined, value: Json | undefined) {
  const field = ctx.fields.find((f) => f.id === fieldId);
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return "empty";
  if (!field) return String(value);
  if (field.boundToSections) return sectionName(ctx, value);
  if (field.fieldType === "single_select" || field.fieldType === "multi_select") {
    const ids = Array.isArray(value) ? value : [value];
    return ids.map((id) => field.options.find((o) => o.id === id)?.name ?? "?").join(", ");
  }
  if (field.fieldType === "boolean") return value === true ? "checked" : "unchecked";
  return String(value);
}

// Automations V2 names: tags, task templates, other projects, form questions.
export function tagName(ctx: RuleContext, id: Json | undefined) {
  return ctx.tags?.find((t) => t.id === id)?.name ?? "a removed tag";
}

export function templateName(ctx: RuleContext, id: Json | undefined) {
  return ctx.taskTemplates?.find((t) => t.id === id)?.name ?? "a removed template";
}

export function otherProjectOf(ctx: RuleContext, id: Json | undefined) {
  return ctx.otherProjects?.find((p) => p.id === id);
}

export function formQuestionLabel(ctx: RuleContext, id: Json | undefined) {
  for (const form of ctx.forms) {
    const question = form.questions?.find((q) => q.id === id);
    if (question) return question.label;
  }
  return "a removed question";
}

// "9:00 AM" for an hour from 0 to 23.
export function hourLabel(hour: number) {
  return formatTime(`${String(hour).padStart(2, "0")}:00`);
}

// "1st", "2nd", "3rd", "4th", "11th", "21st".
export function ordinal(n: number) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

function wholeNumber(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

// "Dana", "Dana or Sam", "Dana, Sam, or the task creator".
function joinWords(items: string[], word: "or" | "and") {
  if (items.length <= 2) return items.join(` ${word} `);
  return `${items.slice(0, -1).join(", ")}, ${word} ${items[items.length - 1]}`;
}

function peopleNames(ctx: RuleContext, value: Json | undefined) {
  return Array.isArray(value) ? value.map((p) => personName(ctx, p)) : [];
}

// "9:30 AM" for an hour and a minute.
export function timeLabel(hour: number, minute = 0) {
  return formatTime(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
}

// A weekly schedule's days (the older single `weekday`, else Sunday).
export function scheduleWeekdays(cfg: Record<string, Json>): number[] {
  if (Array.isArray(cfg.weekdays)) {
    const days = cfg.weekdays.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6);
    if (days.length) return [...new Set(days)].sort((a, b) => a - b);
  }
  return [wholeNumber(cfg.weekday) ?? 0];
}

// "Every week on Monday at 9:00 AM", "Every 2 weeks on Monday and Thursday at 8:30 AM", "Every 3 days at
// 9:00 AM" (mirrors rule_schedule_next_at: 9:00, Sunday, and the 1st by default).
export function scheduleLabel(cfg: Record<string, Json>) {
  const at = `at ${timeLabel(wholeNumber(cfg.hour) ?? 9, wholeNumber(cfg.minute) ?? 0)}`;
  const every = Math.max(wholeNumber(cfg.interval) ?? 1, 1);
  switch (cfg.frequency) {
    case "daily":
      return every > 1 ? `Every ${every} days ${at}` : `Every day ${at}`;
    case "workdays":
      return `Every workday ${at}`;
    case "weekly": {
      const days = joinWords(scheduleWeekdays(cfg).map((d) => WEEKDAYS[d]?.label ?? "Sunday"), "and");
      return `${every > 1 ? `Every ${every} weeks` : "Every week"} on ${days} ${at}`;
    }
    case "monthly":
      return `Every month on the ${ordinal(wholeNumber(cfg.month_day) ?? 1)} ${at}`;
    default:
      return "On a schedule";
  }
}

// A compared value: text in quotes, dates with their year (so the server and the browser agree).
function compareValueLabel(ctx: RuleContext, fieldId: Json | undefined, value: Json | undefined) {
  if (value === null || value === undefined || value === "") return "…";
  const field = ctx.fields.find((f) => f.id === fieldId);
  if (field && !field.boundToSections && field.fieldType === "text") return `“${String(value)}”`;
  if (field && !field.boundToSections && field.fieldType === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return dayLabel(value, 0);
  }
  return fieldValueLabel(ctx, fieldId, value);
}

// What a Set due date action counts from, in a sentence ("today", "the current due date").
function dueFromLabel(value: Json | undefined) {
  return DUE_FROM.find((d) => d.value === value)?.label ?? "today";
}

// "3 hours", "1 day", "2 weeks".
export function offsetLabel(amount: number, unit: string) {
  const u = OFFSET_UNITS.find((x) => x.value === unit) ?? OFFSET_UNITS[1];
  return `${amount} ${amount === 1 ? u.one : u.label}`;
}

// A YYYY-MM-DD day in a sentence, with its year (so the server and the browser agree).
function dayText(value: Json | undefined) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? dayLabel(value, 0) : "…";
}

// Set due date / Set start date in a sentence (mirrors rule_set_task_date).
export function describeDateAction(a: RuleAction) {
  const what = a.type === "set_start_date" ? "start date" : "due date";
  if (a.mode === "clear") return `clear the ${what}`;
  if (a.mode === "date") return `set the ${what} to ${given(a.date) ? dayText(a.date) : ask.action(a.type, "date")}`;
  const n = wholeNumber(a.days);
  if (n === null) return `set the ${what} to ${ask.action(a.type, "days")}`;
  const unit = a.unit === "weeks" || a.unit === "hours" ? a.unit : "days";
  if (unit === "hours") return `set the ${what} to ${offsetLabel(n, "hours")} from now`;
  const from = dueFromLabel(a.from);
  if (n === 0) return a.business_days === true && unit === "days" ? `set the ${what} to ${from} (or the next workday)` : `set the ${what} to ${from}`;
  const word = unit === "weeks" ? `week${Math.abs(n) === 1 ? "" : "s"}` : `${a.business_days === true ? "business " : ""}day${Math.abs(n) === 1 ? "" : "s"}`;
  return `set the ${what} to ${Math.abs(n)} ${word} ${n < 0 ? "before" : "from"} ${from}`;
}

// "a task", "a milestone", "an approval".
export function kindArticle(kind: Json | undefined) {
  return kind === "approval" ? "an approval" : kind === "milestone" ? "a milestone" : "a task";
}

// What Create a task's link means, as the picker words it.
export function createLinkLabel(value: Json | undefined) {
  return CREATE_LINKS.find((l) => l.value === value)?.label ?? CREATE_LINKS[0].label;
}

// "in any way", "to a new date", "and is cleared" (Due / Start date changes).
export function dateChangeLabel(value: Json | undefined) {
  return DATE_CHANGES.find((d) => d.value === value)?.label ?? DATE_CHANGES[0].label;
}

export function describeTrigger(rule: Pick<RuleDef, "triggerType" | "triggerConfig">, ctx: RuleContext) {
  const cfg = rule.triggerConfig;
  const t = rule.triggerType;
  switch (t) {
    case "section_changed":
      return cfg.section_id ? `A task moves into ${sectionName(ctx, cfg.section_id)}` : "A task moves to another section";
    case "section_left":
      return `A task moves out of ${given(cfg.section_id) ? sectionName(ctx, cfg.section_id) : ask.trigger(t, "section_id")}`;
    case "task_unblocked": {
      const kinds = Array.isArray(cfg.kinds) ? cfg.kinds.map((k) => labelOf(UNBLOCK_KINDS, k).toLowerCase()) : [];
      return kinds.length ? `A task is no longer blocked by a ${joinWords(kinds, "or")} dependency` : "A task is no longer blocked by any dependency";
    }
    case "task_type_changed":
      return cfg.kind ? `A task becomes ${kindArticle(cfg.kind)}` : "A task’s type changes to any type";
    case "field_changed": {
      const base = `${given(cfg.field_id) ? fieldName(ctx, cfg.field_id) : ask.trigger(t, "field_id")} changes`;
      return cfg.option_id ? `${base} to ${fieldValueLabel(ctx, cfg.field_id, cfg.option_id)}` : `${base} to any value`;
    }
    case "due_approaching":
    case "start_approaching": {
      const { amount, unit } = triggerOffset(cfg);
      const what = t === "due_approaching" ? "is due" : "starts";
      return amount === 0 && unit === "days" ? `A task ${what} today` : `A task ${what} in ${offsetLabel(amount, unit)}`;
    }
    case "start_reached": {
      const { amount, unit } = triggerOffset(cfg, 0);
      return amount === 0 ? "A task’s start date arrives" : `A task started ${offsetLabel(amount, unit)} ago`;
    }
    case "start_date_changed":
    case "due_date_changed": {
      const what = t === "due_date_changed" ? "A due date" : "A start date";
      return cfg.change === "set" ? `${what} is set or moved` : cfg.change === "cleared" ? `${what} is cleared` : `${what} changes`;
    }
    case "approval_decided": {
      const statuses = Array.isArray(cfg.statuses) ? cfg.statuses : [];
      return statuses.length
        ? `An approval is ${statuses.map((x) => labelOf(APPROVAL_DECISIONS, x).toLowerCase()).join(" or ")}`
        : "An approval gets any decision";
    }
    case "form_submitted":
      return cfg.form_id
        ? `“${ctx.forms.find((f) => f.id === cfg.form_id)?.title ?? "A removed form"}” is submitted`
        : "Any form is submitted";
    case "inbound_received":
      return cfg.endpoint_id
        ? `A task comes in through “${ctx.inboundEndpoints.find((e) => e.id === cfg.endpoint_id)?.name ?? "an inbound webhook"}”`
        : "A task comes in through any inbound webhook";
    case "task_completed":
      return "A task is completed";
    case "task_reopened":
      return "A task is reopened";
    case "subtasks_completed":
      return "All subtasks of a task are done";
    case "task_added_from_project":
      return "A task from another project is added here";
    case "comment_added":
      return "A comment is added";
    case "attachment_added":
      return "A file is attached";
    case "tag_added":
      return cfg.tag_id ? `Tag “${tagName(ctx, cfg.tag_id)}” is added` : "Any tag is added";
    case "task_overdue": {
      // How long overdue when the rule runs (1 day = the day after the due date; missing or 0 days count
      // as 1), as rule_date_tick reads it. Hours count from the due time (the end of the day without one).
      const { amount, unit } = triggerOffset(cfg);
      if (unit === "days" && amount <= 1) return "A task becomes overdue";
      return `A task is ${offsetLabel(unit === "days" ? Math.max(amount, 1) : amount, unit)} overdue`;
    }
    case "scheduled":
      return given(cfg.frequency) ? scheduleLabel(cfg) : `On a schedule ${ask.trigger(t, "frequency")}`;
    case "manual":
      return "Someone runs it from a task";
    case "follower_added": {
      const names = peopleNames(ctx, cfg.people);
      return names.length ? `${joinWords(names, "or")} starts following a task` : "A collaborator is added";
    }
    default:
      return labelOf(TRIGGERS, t);
  }
}

export function describeCondition(c: RuleCondition, ctx: RuleContext) {
  const t = c.type;
  const choose = (key: string) => ask.condition(t, key);
  const section = (key: string) => (given(c[key]) ? sectionName(ctx, c[key]) : choose(key));
  const field = () => (given(c.field_id) ? fieldName(ctx, c.field_id) : choose("field_id"));
  const people = () => {
    const names = peopleNames(ctx, c.people);
    return names.length ? joinWords(names, "or") : choose("people");
  };
  switch (t) {
    case "section_is":
    case "section_is_not":
      return `${labelOf(CONDITIONS, t).toLowerCase()} ${section("section_id")}`;
    case "field_equals":
      return `${field()} is ${given(c.value) ? fieldValueLabel(ctx, c.field_id, c.value) : choose("value")}`;
    case "field_is_set":
    case "field_is_empty":
      return `${field()} is ${t === "field_is_set" ? "set" : "empty"}`;
    case "source_is": {
      if (c.source === "form" && c.form_id) return `task came from “${ctx.forms.find((f) => f.id === c.form_id)?.title ?? "a removed form"}”`;
      const from =
        c.source === "form" ? "a form" : c.source === "inbound" ? "an inbound webhook" : c.source === "manual" ? "the app" : c.source === "import" ? "an import" : choose("source");
      return `task came from ${from}`;
    }
    case "person_compare": {
      const left = given(c.left) ? sideName(ctx, c.left) : choose("left");
      const verb = c.op === "is" || c.op === "is_not" ? personCompareVerb(c.left, c.op === "is_not") : choose("op");
      return `${left} ${verb} ${people()}`;
    }
    case "field_compare": {
      const op = COMPARE_OPS.find((o) => o.value === c.op);
      if (!op) return `${field()} ${choose("op")}`;
      const value = (key: string) => (given(c[key]) ? compareValueLabel(ctx, c.field_id, c[key]) : choose(key));
      if (LIST_OPS.has(op.value)) {
        const names = Array.isArray(c.value) ? c.value.map((v) => fieldValueLabel(ctx, c.field_id, v)) : [];
        return `${field()} ${op.label} ${names.length ? joinWords(names, "or") : choose("value")}`;
      }
      if (RANGE_OPS.has(op.value)) return `${field()} ${op.label} ${value("value")} and ${value("to")}`;
      return `${field()} ${op.label} ${value("value")}`;
    }
    case "has_tag":
      return `has tag ${given(c.tag_id) ? `“${tagName(ctx, c.tag_id)}”` : choose("tag_id")}`;
    case "lacks_tag":
      return `doesn’t have tag ${given(c.tag_id) ? `“${tagName(ctx, c.tag_id)}”` : choose("tag_id")}`;
    case "assignee_is":
      return `assignee is ${people()}`;
    case "creator_is":
      return `created by ${people()}`;
    case "assignee_is_not": {
      const names = peopleNames(ctx, c.people);
      if (names.length === 2) return `assignee is neither ${names[0]} nor ${names[1]}`;
      return names.length > 2 ? `assignee is none of ${joinWords(names, "and")}` : `assignee is not ${names[0] ?? choose("people")}`;
    }
    case "is_overdue":
      return "is overdue";
    case "due_within":
    case "start_within": {
      const days = wholeNumber(c.days);
      const verb = t === "due_within" ? "is due" : "starts";
      if (days === null) return `${verb} within ${choose("days")}`;
      return days === 0 ? `${verb} today` : `${verb} within ${days} day${days === 1 ? "" : "s"}`;
    }
    case "has_due_date":
      return "has a due date";
    case "no_due_date":
      return "has no due date";
    case "has_start_date":
      return "has a start date";
    case "no_start_date":
      return "has no start date";
    case "has_started":
      return "its start date has arrived";
    case "date_compare": {
      const subject = c.date === "start" ? "the start date" : c.date === "due" ? "the due date" : choose("date");
      const op = DATE_OPS.find((o) => o.value === c.op);
      if (!op) return `${subject} ${choose("op")}`;
      const day = (key: string) => (given(c[key]) ? dayText(c[key]) : choose(key));
      return RANGE_OPS.has(op.value) ? `${subject} ${op.label} ${day("value")} and ${day("to")}` : `${subject} ${op.label} ${day("value")}`;
    }
    case "task_type_is":
    case "task_type_is_not":
      return `task type ${t === "task_type_is" ? "is" : "isn’t"} ${c.kind ? labelOf(TASK_KIND_OPTIONS, c.kind) : choose("kind")}`;
    case "section_is_one_of":
    case "section_is_none_of": {
      const names = Array.isArray(c.section_ids) ? c.section_ids.map((id) => sectionName(ctx, id)) : [];
      if (!names.length) return `section is ${t === "section_is_one_of" ? "one" : "none"} of ${choose("section_ids")}`;
      return t === "section_is_one_of"
        ? `section is ${joinWords(names, "or")}`
        : names.length === 1
          ? `section isn’t ${names[0]}`
          : `section is none of ${joinWords(names, "and")}`;
    }
    case "is_blocked":
      return "is blocked";
    case "is_not_blocked":
      return "isn’t blocked";
    case "approval_status_is": {
      const names = Array.isArray(c.statuses) ? c.statuses.map((x) => labelOf(APPROVAL_STATUSES, x).toLowerCase()) : [];
      return `approval status is ${names.length ? joinWords(names, "or") : choose("statuses")}`;
    }
    case "has_attachment":
      return "has an attachment";
    case "no_attachment":
      return "has no attachment";
    case "has_comment":
      return "has a comment";
    case "no_comment":
      return "has no comment";
    case "has_open_subtasks":
      return "has open subtasks";
    case "all_subtasks_done":
      return "all subtasks are done";
    case "title_contains":
      return `name contains ${given(c.text) ? quoteText(c.text) : choose("text")}`;
    case "form_answer_contains": {
      const text = given(c.text) ? quoteText(c.text) : choose("text");
      return c.question_id ? `the answer to “${formQuestionLabel(ctx, c.question_id)}” contains ${text}` : `a form answer contains ${text}`;
    }
    default:
      return labelOf(CONDITIONS, t).toLowerCase();
  }
}

export function describeAction(a: RuleAction, ctx: RuleContext) {
  const t = a.type;
  const choose = (key: string) => ask.action(t, key);
  const people = (key = "people", word: "and" | "or" = "and") => {
    const names = peopleNames(ctx, a[key]);
    return names.length ? joinWords(names, word) : choose(key);
  };
  const quoted = (key: string) => (given(a[key]) ? quoteText(a[key]) : choose(key));
  const otherProject = () => {
    const project = otherProjectOf(ctx, a.project_id);
    if (!given(a.project_id)) return choose("project_id");
    const section = project?.sections.find((x) => x.id === a.section_id);
    return `${project ? `“${project.name}”` : "another project"}${section ? ` in “${section.name}”` : ""}`;
  };
  switch (t) {
    case "move_section":
      return `move to ${given(a.section_id) ? sectionName(ctx, a.section_id) : choose("section_id")}`;
    case "set_field":
      return given(a.field_id) ? `set ${fieldName(ctx, a.field_id)} to ${fieldValueLabel(ctx, a.field_id, a.value)}` : `set ${choose("field_id")}`;
    case "set_assignee": {
      if (a.mode === "round_robin" || a.mode === "balanced") {
        return a.mode === "round_robin" ? `assign round robin among ${people()}` : `assign whoever has the fewest open tasks of ${people()}`;
      }
      return a.assignee === null ? "unassign" : given(a.assignee) ? `assign ${personName(ctx, a.assignee)}` : `assign ${choose("assignee")}`;
    }
    case "remove_followers":
      return `remove follower${peopleNames(ctx, a.people).length === 1 ? "" : "s"} ${people()}`;
    case "add_comment":
      return `comment ${quoted("body")}`;
    case "add_followers":
      return `add follower${peopleNames(ctx, a.people).length === 1 ? "" : "s"} ${people()}`;
    case "notify":
      return `notify ${people()}: ${quoted("message")}`;
    case "request_approval":
      return `ask ${given(a.approver) ? personName(ctx, a.approver) : choose("approver")} to approve`;
    case "send_email": {
      const to =
        a.to === "address"
          ? given(a.address)
            ? str(a.address)
            : choose("address")
          : a.to === "field"
            ? `the address in ${given(a.field_id) ? fieldName(ctx, a.field_id) : choose("field_id")}`
            : given(a.to)
              ? labelOf(EMAIL_RECIPIENTS, a.to).toLowerCase()
              : choose("to");
      const template = given(a.template) ? ` (${labelOf(EMAIL_TEMPLATES, a.template).toLowerCase()})` : "";
      const subject = given(a.subject) ? ` ${quoteText(a.subject)}` : "";
      const message = a.template === "custom" && !given(a.message) ? ` ${choose("message")}` : given(a.message) ? `: ${quoteText(a.message)}` : "";
      const include = given(a.include_field_id) ? ` with ${fieldName(ctx, a.include_field_id)}` : "";
      return `email ${to}${template}${subject}${message}${include}`;
    }
    case "send_slack":
      return `post ${quoted("message")} to Slack${a.format === "blocks" ? " as a task card" : ""} (${a.use_project_webhook !== true && str(a.webhook_hint) ? str(a.webhook_hint) : "project webhook"})`;
    case "call_webhook":
      return `call webhook (${a.use_project_webhook !== true && str(a.url_hint) ? str(a.url_hint) : "project webhook"}${a.signing_set === true ? ", signed" : ""})`;
    case "delay":
      return typeof a.hours === "number" && Number.isFinite(a.hours) ? `wait ${a.hours} h` : `wait ${choose("hours")}`;
    case "complete_task":
      return "mark complete";
    case "reopen_task":
      return "mark incomplete";
    case "set_title":
      return `rename to ${quoted("title")}`;
    case "create_subtasks": {
      const titles = Array.isArray(a.titles) ? a.titles.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
      const what = titles.length === 0 ? `create subtasks ${choose("titles")}` : titles.length === 1 ? `create subtask ${quoteText(titles[0])}` : `create ${titles.length} subtasks`;
      return a.assignee ? `${what} assigned to ${personName(ctx, a.assignee)}` : what;
    }
    case "apply_task_template":
      return `apply template ${given(a.template_id) ? `“${templateName(ctx, a.template_id)}”` : choose("template_id")}`;
    case "add_to_project":
      return `add to ${otherProject()}`;
    case "move_to_project":
      return `move to ${otherProject()}`;
    case "set_due_date":
    case "set_start_date":
      return describeDateAction(a);
    case "create_task": {
      const kind = a.kind === "milestone" || a.kind === "approval" ? a.kind : "task";
      const project = a.project_id && a.project_id !== "" ? otherProjectOf(ctx, a.project_id) : null;
      const sections = project ? project.sections : a.project_id ? [] : ctx.sections;
      const section = sections.find((x) => x.id === a.section_id);
      const where = `${project ? ` in “${project.name}”` : a.project_id ? " in another project" : ""}${section ? ` › ${section.name}` : ""}`;
      const link = a.link === "blocked_by" ? " waiting on this one" : a.link === "blocking" ? " that this one waits on" : "";
      const due = typeof a.due_days === "number" ? `, due in ${a.due_days} ${a.business_days === true ? "business " : ""}day${a.due_days === 1 ? "" : "s"}` : "";
      return `create ${kindArticle(kind)} ${quoted("title")}${where}${a.assignee ? ` for ${personName(ctx, a.assignee)}` : ""}${due}${link}`;
    }
    case "remove_from_project":
      return "remove from this project";
    case "convert_to_project": {
      const template = ctx.projectTemplates?.find((x) => x.id === a.template_id);
      const portfolio = ctx.portfolios?.find((p) => p.id === a.portfolio_id);
      return `convert to a project${given(a.name) ? ` ${quoteText(a.name)}` : ""}${template ? ` from “${template.name}”` : a.template_id ? " from a template" : ""}${
        portfolio ? ` in “${portfolio.name}”` : a.portfolio_id ? " in a portfolio" : ""
      }${a.complete_task === true ? " and complete the task" : ""}${a.members === "task_people" ? " (inviting the task’s people)" : ""}`;
    }
    case "set_task_type":
      return `make it ${a.kind ? kindArticle(a.kind) : choose("kind")}`;
    case "set_description": {
      const text = given(a.text) ? quoteText(a.text) : null;
      if (a.mode === "append") return `add ${text ?? choose("text")} to the end of the description`;
      if (a.mode === "prepend") return `add ${text ?? choose("text")} to the start of the description`;
      return text ? `set the description to ${text}` : "clear the description";
    }
    case "add_tag":
      return `add tag ${given(a.tag_id) ? `“${tagName(ctx, a.tag_id)}”` : choose("tag_id")}`;
    case "remove_tag":
      return `remove tag ${given(a.tag_id) ? `“${tagName(ctx, a.tag_id)}”` : choose("tag_id")}`;
    default:
      return labelOf(ACTIONS, t).toLowerCase();
  }
}

// A branch's name on the canvas and in summaries: Check if, Else if, Otherwise.
export function branchLabel(index: number, count: number, hasConditions: boolean) {
  if (index === 0) return "Check if";
  if (index === count - 1 && !hasConditions) return "Otherwise";
  return "Else if";
}

// "If A and B, then x, then y" per branch (one line for a rule without branches).
export function describeBranches(rule: Pick<RuleDef, "conditions" | "actions">, ctx: RuleContext) {
  const branches = splitBranches(rule);
  return branches.map((branch, index) => {
    // OR groups read "(A and B) or C"; one group is just "A and B".
    const groups = splitGroups(branch.conditions).map((g) => g.map((c) => describeCondition(c, ctx)).join(" and "));
    const conditions = groups.length > 1 ? groups.map((g) => (g.includes(" and ") ? `(${g})` : g)).join(" or ") : (groups[0] ?? "");
    const actions = branch.actions.map((a) => describeAction(a, ctx)).join(", then ");
    const label = branches.length === 1 ? (conditions ? "If" : "") : branchLabel(index, branches.length, branch.conditions.length > 0);
    return { label, conditions, actions };
  });
}

// The whole rule as one sentence: "When a task moves into Review, if Priority is High, assign Dana and
// move to Video intake." Branches read "…; otherwise if …, …; otherwise, …".
export function ruleSentence(rule: Pick<RuleDef, "triggerType" | "triggerConfig" | "conditions" | "actions">, ctx: RuleContext) {
  const trigger = describeTrigger(rule, ctx);
  // A scheduled rule reads "Every workday at 9:00 AM, for each open task, …".
  const when =
    rule.triggerType === "scheduled" ? `${trigger}, for each open task` : `When ${trigger.charAt(0).toLowerCase()}${trigger.slice(1)}`;
  const parts = describeBranches(rule, ctx).map((b, i) => {
    const actions = b.actions || "do nothing yet";
    if (i === 0) return b.conditions ? `if ${b.conditions}, ${actions}` : actions;
    return b.conditions ? `otherwise if ${b.conditions}, ${actions}` : `otherwise, ${actions}`;
  });
  return `${when}, ${parts.join("; ")}.`;
}

type PickerLook = { variant?: "control" | "chip" | "ghost"; highlight?: boolean; placeholder?: string };

const SECTION_ICON = <Columns3 className="size-4" />;

export function sectionOptions(ctx: RuleContext): SmartOption[] {
  return ctx.sections.map((s) => ({ value: s.id, label: s.name, icon: SECTION_ICON }));
}

export function fieldOptions(fields: FieldDef[]): SmartOption[] {
  return fields.map((f) => ({
    value: f.id,
    label: f.boundToSections ? `${f.name} (Status)` : f.name,
    description: f.boundToSections ? "Follows the section" : FIELD_TYPE_LABELS[f.fieldType] ?? undefined,
    keywords: [f.fieldType.replace("_", " ")],
    icon: <PenLine className="size-4" />,
  }));
}

// Roles first (the task's assignee / creator), then the project's People fields (Automations V3), then
// everyone, with avatars. `many` = the slot takes everyone in a People field (followers, notify,
// conditions); else its first person.
export function personOptions(ctx: RuleContext, opts: { none?: string; many?: boolean } = {}): SmartOption[] {
  return [
    ...(opts.none ? [{ value: "", label: opts.none, group: "Roles", icon: <UserMinus className="size-4" /> }] : []),
    ...PERSON_ROLES.map((r) => ({
      value: r.value as string,
      label: r.label,
      group: "Roles",
      description: r.value === "assignee" ? "Whoever the task is assigned to when the rule runs" : "Whoever created the task",
      icon: <User className="size-4" />,
    })),
    ...peopleFields(ctx).map((f) => ({
      value: fieldSlot(f.id),
      label: `${f.name} (People field)`,
      group: "People fields",
      description: opts.many ? "Everyone in this field on the task" : "The first person in this field on the task",
      keywords: ["field", "role", "custom"],
      icon: <Contact className="size-4" />,
      ...(ctx.v3 === false ? { disabled: true, disabledReason: NEEDS_UPDATE } : {}),
    })),
    ...ctx.people.map((p) => ({ value: p.id, label: p.name, group: "People", icon: <Avatar name={p.name} profileId={p.id} /> })),
  ];
}

// "is" / "isn't" for one person, "includes" for a People field, "include" for the collaborators.
export function personCompareVerb(side: Json | undefined, negated: boolean) {
  if (side === "followers") return negated ? "don’t include" : "include";
  if (fieldOfSlot(side) !== null) return negated ? "doesn’t include" : "includes";
  return negated ? "isn’t" : "is";
}

// A "Compare people" side: the assignee, the creator, the collaborators, or a People field.
export function sideOptions(ctx: RuleContext): SmartOption[] {
  return [
    ...PERSON_SIDES.map((side) => ({ value: side.value as string, label: side.label, group: "On the task", icon: <User className="size-4" /> })),
    ...peopleFields(ctx).map((f) => ({ value: fieldSlot(f.id), label: f.name, group: "People fields", icon: <Contact className="size-4" /> })),
  ];
}

export function sideName(ctx: RuleContext, value: Json | undefined) {
  const side = PERSON_SIDES.find((s) => s.value === value);
  if (side) return `the ${side.label.toLowerCase()}`;
  const field = fieldOfSlot(value);
  return field !== null ? `the ${peopleFieldName(ctx, field)} field` : "…";
}

// The workspace's tags with their color dots. Archived ones are marked, or listed but disabled
// (`archived: "disabled"`, for Add tag: an archived tag can't be added to a task).
export function tagOptions(ctx: RuleContext, opts: { archived?: "marked" | "disabled" } = {}): SmartOption[] {
  return (ctx.tags ?? []).map((t) => ({
    value: t.id,
    label: t.archived ? `${t.name} (archived)` : t.name,
    keywords: ["tag"],
    icon: optionDot(t.color),
    ...(t.archived && opts.archived === "disabled" ? { disabled: true, disabledReason: "Archived tags can’t be added" } : {}),
  }));
}

// A picker's closed button for an optional slot: the chosen option, else `none` ("any tag", "no
// section"). The picker can't select an empty value, so "nothing chosen" reads as that choice.
export function valueOr(none: string) {
  return function OptionalValue(chosen: SmartOption[]): ReactNode {
    const option = chosen[0];
    if (!option) return <span>{none}</span>;
    return (
      <>
        {option.icon ? <span className="flex shrink-0 items-center">{option.icon}</span> : null}
        <span className="truncate">{option.label}</span>
      </>
    );
  };
}

export function SectionSelect({
  id,
  label,
  value,
  ctx,
  onChange,
  ...look
}: {
  id: string;
  label: string;
  value: Json | undefined;
  ctx: RuleContext;
  onChange: (value: string) => void;
} & PickerLook) {
  return (
    <SmartPicker
      id={id}
      label={label}
      value={str(value) || null}
      options={sectionOptions(ctx)}
      onChange={onChange}
      variant={look.variant ?? "chip"}
      highlight={look.highlight}
      placeholder={look.placeholder ?? "choose section"}
      emptyText={ctx.sections.length ? "No section matches" : "This project has no sections yet"}
    />
  );
}

export function FieldSelect({
  id,
  label,
  value,
  fields,
  onChange,
  ...look
}: {
  id: string;
  label: string;
  value: Json | undefined;
  fields: FieldDef[];
  onChange: (value: string) => void;
} & PickerLook) {
  return (
    <SmartPicker
      id={id}
      label={label}
      value={str(value) || null}
      options={fieldOptions(fields)}
      onChange={onChange}
      variant={look.variant ?? "chip"}
      highlight={look.highlight}
      placeholder={look.placeholder ?? "choose field"}
      emptyText={fields.length ? "No field matches" : "Add a field to this project first"}
    />
  );
}

export function PersonSelect({
  id,
  label,
  value,
  ctx,
  onChange,
  allowNone,
  ...look
}: {
  id: string;
  label: string;
  value: Json | undefined;
  ctx: RuleContext;
  onChange: (value: string) => void;
  allowNone?: string;
} & PickerLook) {
  // null = "nobody" (when allowed); "" = a slot still to fill (a template's), shown as the placeholder.
  const current = str(value);
  const options = personOptions(ctx, { none: allowNone });
  const removed = Boolean(current) && !options.some((o) => o.value === current);
  return (
    <SmartPicker
      id={id}
      label={label}
      value={current || (allowNone && value === null ? "" : null)}
      options={options}
      onChange={onChange}
      variant={look.variant ?? "chip"}
      highlight={look.highlight}
      placeholder={look.placeholder ?? "choose person"}
      // A saved person who's no longer listed isn't "nobody".
      renderValue={removed ? () => <span>someone removed</span> : undefined}
      searchable
    />
  );
}

export function PeoplePicker({
  idPrefix,
  label,
  value,
  ctx,
  onChange,
  ...look
}: {
  idPrefix: string;
  label: string;
  value: Json | undefined;
  ctx: RuleContext;
  onChange: (value: string[]) => void;
} & PickerLook) {
  const selected = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return (
    <SmartPicker
      multiple
      id={`${idPrefix}-picker`}
      label={label}
      value={selected}
      options={personOptions(ctx, { many: true })}
      onChange={onChange}
      variant={look.variant ?? "chip"}
      highlight={look.highlight}
      placeholder={look.placeholder ?? "choose people"}
      searchable
    />
  );
}

export function optionDot(color: string) {
  return <span className={`size-2.5 rounded-full ${OPTION_SWATCH_CLASSES[color as OptionColor] ?? "bg-zinc-300"}`} />;
}

// Value editor matching how task_field_values stores each field type (bound Status → section id).
export function FieldValueInput({
  id,
  field,
  value,
  ctx,
  onChange,
  highlight,
}: {
  id: string;
  field: FieldDef | undefined;
  value: Json | undefined;
  ctx: RuleContext;
  onChange: (value: Json) => void;
  highlight?: boolean;
}) {
  if (!field) return null;
  if (field.boundToSections) {
    return <SectionSelect id={id} label={`${field.name} value`} value={value} ctx={ctx} onChange={onChange} highlight={highlight} />;
  }
  switch (field.fieldType) {
    case "single_select":
      return (
        <SmartPicker
          id={id}
          label={`${field.name} value`}
          value={str(value) || null}
          options={[
            { value: "", label: "Empty", description: "Clear the value" },
            ...field.options.map((o) => ({ value: o.id, label: o.name, icon: optionDot(o.color) })),
          ]}
          onChange={(v) => onChange(v || null)}
          variant="chip"
          highlight={highlight}
          placeholder="choose option"
        />
      );
    case "multi_select": {
      const selected = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      return (
        <SmartPicker
          multiple
          id={id}
          label={`${field.name} value`}
          value={selected}
          options={field.options.map((o) => ({ value: o.id, label: o.name, icon: optionDot(o.color) }))}
          onChange={(v) => onChange(v)}
          variant="chip"
          highlight={highlight}
          placeholder="choose options"
        />
      );
    }
    case "boolean":
      return (
        <SmartPicker
          id={id}
          label={`${field.name} value`}
          value={value === true ? "true" : value === false ? "false" : null}
          options={[
            { value: "true", label: "Checked" },
            { value: "false", label: "Unchecked" },
          ]}
          onChange={(v) => onChange(v === "true")}
          variant="chip"
          highlight={highlight}
          placeholder="choose checked or unchecked"
        />
      );
    case "number":
      return (
        <SlotInput
          id={id}
          label={`${field.name} value`}
          type="number"
          value={typeof value === "number" ? String(value) : ""}
          onChange={(v) => onChange(v === "" || !Number.isFinite(Number(v)) ? null : Number(v))}
          className="w-28"
        />
      );
    case "date":
      return <RuleDateInput id={id} label={`${field.name} value`} value={value} onChange={onChange} highlight={highlight} />;
    default:
      return (
        <SlotInput id={id} label={`${field.name} value`} value={str(value)} onChange={(v) => onChange(v)} />
      );
  }
}

// A plain text or number box for a rule setting; inside a ParamSlot it's highlighted while empty.
export function SlotInput({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  maxLength = 1000,
  className = "",
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "email";
  placeholder?: string;
  maxLength?: number;
  className?: string;
}) {
  const slot = useParamSlot<string>(onChange);
  const missing = slot.missing && value.trim() === "";
  return (
    <input
      id={id}
      type={type}
      aria-label={label}
      aria-invalid={missing || undefined}
      placeholder={placeholder}
      value={value}
      maxLength={type === "number" ? undefined : maxLength}
      onChange={(e) => onChange(e.currentTarget.value)}
      className={`${inputClass} ${className} ${missing ? MISSING_INPUT : ""}`}
    />
  );
}

// A day for a rule (YYYY-MM-DD): a chip that opens the app's date picker (quick picks, a calendar, and a
// typed date) instead of the browser's own date popup.
export function RuleDateInput({
  id,
  label,
  value,
  onChange,
  placeholder = "choose date",
  highlight,
}: {
  id?: string;
  label: string;
  value: Json | undefined;
  onChange: (value: string | null) => void;
  placeholder?: string;
  highlight?: boolean;
}) {
  const day = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  // Inside a rule step's ParamSlot: highlighted while the date is still missing (rule-params.ts).
  const slot = useParamSlot<string | null>(onChange);
  const lit = highlight || slot.missing;
  return (
    <Popover
      label={`${label}: ${day ? dayLabel(day, 0) : "not chosen"}. Change`}
      buttonId={id}
      panelClassName="w-[19rem] p-0"
      buttonClassName={`inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left font-medium hover:bg-accent-50 aria-expanded:bg-accent-50 ${
        day ? "text-accent-700" : lit ? "bg-amber-50 text-amber-800 ring-1 ring-amber-300" : "text-zinc-500 underline decoration-dashed underline-offset-4"
      }`}
      button={
        <>
          <CalendarDays className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{day ? dayLabel(day, 0) : placeholder}</span>
        </>
      }
    >
      {(close) => (
        <SingleDatePicker
          label={label}
          value={day}
          onChange={(next) => {
            close();
            onChange(next);
          }}
        />
      )}
    </Popover>
  );
}
