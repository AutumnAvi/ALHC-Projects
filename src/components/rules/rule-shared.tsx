"use client";

import { Columns3, PenLine, User, UserMinus } from "lucide-react";
import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import { dayLabel, formatTime } from "@/lib/date-input";
import { OPTION_SWATCH_CLASSES, type FieldDef, type OptionColor } from "@/lib/fields";
import type { ProjectIntegrations } from "@/lib/integrations-shared";
import {
  ACTIONS,
  APPROVAL_DECISIONS,
  COMPARE_OPS,
  CONDITIONS,
  DUE_FROM,
  EMAIL_RECIPIENTS,
  PERSON_ROLES,
  TASK_KIND_OPTIONS,
  TRIGGERS,
  labelOf,
  splitBranches,
  splitGroups,
  type RuleAction,
  type RuleCondition,
  type RuleDef,
} from "@/lib/rules";
import type { Json } from "@/lib/supabase/database.types";
import { WEEKDAYS } from "@/lib/workdays";

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
  tags?: { id: string; name: string; color: string; archived: boolean }[];
  taskTemplates?: { id: string; name: string }[];
  // Other active projects where the viewer is an Editor+ (Add to another project).
  otherProjects?: { id: string; name: string; sections: { id: string; name: string }[] }[];
  // The workspace's workweek (business days), 0 = Sunday.
  workWeek?: number[];
  // Automations V2's database update is applied (else the new vocabulary is offered but disabled).
  v2?: boolean;
};

export const inputClass = "control h-auto min-h-7 py-0.5";

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

function fieldName(ctx: RuleContext, id: Json | undefined) {
  return ctx.fields.find((f) => f.id === id)?.name ?? "a removed field";
}

export function personName(ctx: RuleContext, value: Json | undefined) {
  const role = PERSON_ROLES.find((r) => r.value === value);
  if (role) return `the ${role.label.toLowerCase()}`;
  return ctx.people.find((p) => p.id === value)?.name ?? "someone removed";
}

export function fieldValueLabel(ctx: RuleContext, fieldId: Json | undefined, value: Json | undefined) {
  const field = ctx.fields.find((f) => f.id === fieldId);
  if (!field) return String(value ?? "");
  if (field.boundToSections) return sectionName(ctx, value);
  if (field.fieldType === "single_select" || field.fieldType === "multi_select") {
    const ids = Array.isArray(value) ? value : [value];
    return ids.map((id) => field.options.find((o) => o.id === id)?.name ?? "?").join(", ");
  }
  if (field.fieldType === "boolean") return value === true ? "checked" : "unchecked";
  if (value === null || value === undefined || value === "") return "empty";
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

// "Every week on Monday at 9:00 AM" (mirrors rule_schedule_next_at: hour 9, Sunday, and the 1st by default).
export function scheduleLabel(cfg: Record<string, Json>) {
  const at = `at ${hourLabel(wholeNumber(cfg.hour) ?? 9)}`;
  switch (cfg.frequency) {
    case "daily":
      return `Every day ${at}`;
    case "workdays":
      return `Every workday ${at}`;
    case "weekly":
      return `Every week on ${WEEKDAYS[wholeNumber(cfg.weekday) ?? 0]?.label ?? "Sunday"} ${at}`;
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

export function describeTrigger(rule: Pick<RuleDef, "triggerType" | "triggerConfig">, ctx: RuleContext) {
  const cfg = rule.triggerConfig;
  switch (rule.triggerType) {
    case "section_changed":
      return `Task moves into ${sectionName(ctx, cfg.section_id)}`;
    case "field_changed": {
      const base = `${fieldName(ctx, cfg.field_id)} changes`;
      return cfg.option_id ? `${base} to ${fieldValueLabel(ctx, cfg.field_id, cfg.option_id)}` : base;
    }
    case "due_approaching": {
      const days = typeof cfg.days === "number" ? cfg.days : 1;
      return days === 0 ? "Task is due today" : `Task is due in ${days} day${days === 1 ? "" : "s"}`;
    }
    case "approval_decided": {
      const statuses = Array.isArray(cfg.statuses) ? cfg.statuses : [];
      return statuses.length
        ? `An approval is ${statuses.map((s) => labelOf(APPROVAL_DECISIONS, s).toLowerCase()).join(" or ")}`
        : "An approval is decided";
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
      return cfg.tag_id ? `Tag “${tagName(ctx, cfg.tag_id)}” is added` : "A tag is added";
    case "due_date_changed":
      return "A due date changes";
    case "task_overdue": {
      // `days` = how many days overdue when the rule runs (1 = the day after the due date; missing or
      // 0 counts as 1), as workflow_tick reads it.
      const days = Math.max(wholeNumber(cfg.days) ?? 1, 1);
      return days === 1 ? "A task becomes overdue" : `A task is ${days} days overdue`;
    }
    case "scheduled":
      return scheduleLabel(cfg);
    case "manual":
      return "Someone runs it from a task";
    default:
      return labelOf(TRIGGERS, rule.triggerType);
  }
}

export function describeCondition(c: RuleCondition, ctx: RuleContext) {
  switch (c.type) {
    case "section_is":
    case "section_is_not":
      return `${labelOf(CONDITIONS, c.type).toLowerCase()} ${sectionName(ctx, c.section_id)}`;
    case "field_equals":
      return `${fieldName(ctx, c.field_id)} is ${fieldValueLabel(ctx, c.field_id, c.value)}`;
    case "field_is_set":
    case "field_is_empty":
      return `${fieldName(ctx, c.field_id)} is ${c.type === "field_is_set" ? "set" : "empty"}`;
    case "source_is":
      return `task came from ${
        c.source === "form" ? "a form" : c.source === "inbound" ? "an inbound webhook" : c.source === "manual" ? "the app" : str(c.source)
      }`;
    case "field_compare": {
      const op = COMPARE_OPS.find((o) => o.value === c.op);
      if (!op) return `${fieldName(ctx, c.field_id)} compares`;
      return `${fieldName(ctx, c.field_id)} ${op.label} ${compareValueLabel(ctx, c.field_id, c.value)}`;
    }
    case "has_tag":
      return `has tag “${tagName(ctx, c.tag_id)}”`;
    case "lacks_tag":
      return `doesn’t have tag “${tagName(ctx, c.tag_id)}”`;
    case "assignee_is":
    case "creator_is": {
      const names = peopleNames(ctx, c.people);
      return `${c.type === "creator_is" ? "created by" : "assignee is"} ${names.length ? joinWords(names, "or") : "…"}`;
    }
    case "assignee_is_not": {
      const names = peopleNames(ctx, c.people);
      if (names.length === 2) return `assignee is neither ${names[0]} nor ${names[1]}`;
      return names.length > 2 ? `assignee is none of ${joinWords(names, "and")}` : `assignee is not ${names[0] ?? "…"}`;
    }
    case "is_overdue":
      return "is overdue";
    case "due_within": {
      const days = wholeNumber(c.days);
      if (days === null) return "is due within a few days";
      return days === 0 ? "is due today" : `is due within ${days} day${days === 1 ? "" : "s"}`;
    }
    case "has_due_date":
      return "has a due date";
    case "no_due_date":
      return "has no due date";
    case "task_type_is":
      return `task type is ${c.kind ? labelOf(TASK_KIND_OPTIONS, c.kind) : "…"}`;
    case "has_open_subtasks":
      return "has open subtasks";
    case "all_subtasks_done":
      return "all subtasks are done";
    case "title_contains":
      return `name contains “${str(c.text)}”`;
    case "form_answer_contains":
      return c.question_id
        ? `the answer to “${formQuestionLabel(ctx, c.question_id)}” contains “${str(c.text)}”`
        : `a form answer contains “${str(c.text)}”`;
    default:
      return labelOf(CONDITIONS, c.type).toLowerCase();
  }
}

export function describeAction(a: RuleAction, ctx: RuleContext) {
  switch (a.type) {
    case "move_section":
      return `move to ${sectionName(ctx, a.section_id)}`;
    case "set_field":
      return `set ${fieldName(ctx, a.field_id)} to ${fieldValueLabel(ctx, a.field_id, a.value)}`;
    case "set_assignee":
      return a.assignee ? `assign ${personName(ctx, a.assignee)}` : "unassign";
    case "add_comment":
      return "comment";
    case "add_followers":
    case "notify": {
      const people = Array.isArray(a.people) ? a.people.map((p) => personName(ctx, p)).join(", ") : "";
      return `${a.type === "notify" ? "notify" : "add follower"} ${people}`;
    }
    case "request_approval":
      return `ask ${personName(ctx, a.approver)} to approve`;
    case "send_email":
      return `email ${
        a.to === "address"
          ? str(a.address)
          : a.to === "field"
            ? `the address in ${fieldName(ctx, a.field_id)}`
            : labelOf(EMAIL_RECIPIENTS, a.to).toLowerCase()
      }`;
    case "send_slack":
      return `post to Slack${a.format === "blocks" ? " as a task card" : ""} (${a.use_project_webhook !== true && str(a.webhook_hint) ? str(a.webhook_hint) : "project webhook"})`;
    case "call_webhook":
      return `call webhook (${a.use_project_webhook !== true && str(a.url_hint) ? str(a.url_hint) : "project webhook"}${a.signing_set === true ? ", signed" : ""})`;
    case "delay":
      return `wait ${a.hours} h`;
    case "complete_task":
      return "mark complete";
    case "reopen_task":
      return "mark incomplete";
    case "set_title":
      return `rename to “${str(a.title)}”`;
    case "create_subtasks": {
      const titles = Array.isArray(a.titles) ? a.titles.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];
      const what =
        titles.length === 0 ? "create subtasks" : titles.length === 1 ? `create subtask “${titles[0]}”` : `create ${titles.length} subtasks`;
      return a.assignee ? `${what} assigned to ${personName(ctx, a.assignee)}` : what;
    }
    case "apply_task_template":
      return `apply template “${templateName(ctx, a.template_id)}”`;
    case "add_to_project": {
      const project = otherProjectOf(ctx, a.project_id);
      const section = project?.sections.find((s) => s.id === a.section_id);
      return `add to ${project ? `“${project.name}”` : "another project"}${section ? ` in “${section.name}”` : ""}`;
    }
    case "set_due_date": {
      if (a.mode === "clear") return "clear the due date";
      const days = wholeNumber(a.days);
      const from = dueFromLabel(a.from);
      if (days === null) return "set the due date";
      if (days === 0) return a.business_days === true ? `set the due date to ${from} (or the next workday)` : `set the due date to ${from}`;
      const unit = `${a.business_days === true ? "business " : ""}day${Math.abs(days) === 1 ? "" : "s"}`;
      return `set the due date to ${Math.abs(days)} ${unit} ${days < 0 ? "before" : "from"} ${from}`;
    }
    case "add_tag":
      return `add tag “${tagName(ctx, a.tag_id)}”`;
    case "remove_tag":
      return `remove tag “${tagName(ctx, a.tag_id)}”`;
    default:
      return labelOf(ACTIONS, a.type).toLowerCase();
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

// Roles first (the task's assignee / creator), then everyone, with avatars.
export function personOptions(ctx: RuleContext, opts: { none?: string } = {}): SmartOption[] {
  return [
    ...(opts.none ? [{ value: "", label: opts.none, group: "Roles", icon: <UserMinus className="size-4" /> }] : []),
    ...PERSON_ROLES.map((r) => ({
      value: r.value as string,
      label: r.label,
      group: "Roles",
      description: r.value === "assignee" ? "Whoever the task is assigned to when the rule runs" : "Whoever created the task",
      icon: <User className="size-4" />,
    })),
    ...ctx.people.map((p) => ({ value: p.id, label: p.name, group: "People", icon: <Avatar name={p.name} /> })),
  ];
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
  const current = str(value);
  return (
    <SmartPicker
      id={id}
      label={label}
      value={current || (allowNone && value === null ? "" : null)}
      options={personOptions(ctx, { none: allowNone })}
      onChange={onChange}
      variant={look.variant ?? "chip"}
      highlight={look.highlight}
      placeholder={look.placeholder ?? "choose person"}
      // A saved person who's no longer listed isn't "nobody".
      renderValue={allowNone ? valueOr(current ? "someone removed" : allowNone) : undefined}
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
      options={personOptions(ctx)}
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
          value={value === true ? "true" : "false"}
          options={[
            { value: "true", label: "Checked" },
            { value: "false", label: "Unchecked" },
          ]}
          onChange={(v) => onChange(v === "true")}
          variant="chip"
        />
      );
    case "number":
      return (
        <input
          id={id}
          aria-label={`${field.name} value`}
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
          className={`${inputClass} w-28`}
        />
      );
    case "date":
      return (
        <input id={id} aria-label={`${field.name} value`} type="date" value={str(value)} onChange={(e) => onChange(e.currentTarget.value || null)} className={inputClass} />
      );
    default:
      return (
        <input id={id} aria-label={`${field.name} value`} value={str(value)} maxLength={1000} onChange={(e) => onChange(e.currentTarget.value)} className={inputClass} />
      );
  }
}
