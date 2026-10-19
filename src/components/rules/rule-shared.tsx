"use client";

import { Columns3, PenLine, User, UserMinus } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import { OPTION_SWATCH_CLASSES, type FieldDef, type OptionColor } from "@/lib/fields";
import type { ProjectIntegrations } from "@/lib/integrations-shared";
import {
  ACTIONS,
  APPROVAL_DECISIONS,
  CONDITIONS,
  EMAIL_RECIPIENTS,
  PERSON_ROLES,
  TRIGGERS,
  labelOf,
  splitBranches,
  type RuleAction,
  type RuleCondition,
  type RuleDef,
} from "@/lib/rules";
import type { Json } from "@/lib/supabase/database.types";

export type RuleContext = {
  sections: { id: string; name: string }[];
  fields: FieldDef[];
  people: { id: string; name: string }[];
  forms: { id: string; title: string }[];
  // Redacted project defaults (Settings → Integrations); null when not loaded (below Admin).
  integrations: ProjectIntegrations | null;
  // Inbound webhooks of the project (Settings → Inbound); empty below Admin.
  inboundEndpoints: { id: string; name: string }[];
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
    const conditions = branch.conditions.map((c) => describeCondition(c, ctx)).join(" and ");
    const actions = branch.actions.map((a) => describeAction(a, ctx)).join(", then ");
    const label = branches.length === 1 ? (conditions ? "If" : "") : branchLabel(index, branches.length, branch.conditions.length > 0);
    return { label, conditions, actions };
  });
}

// The whole rule as one sentence: "When a task moves into Review, if Priority is High, assign Dana and
// move to Video intake." Branches read "…; otherwise if …, …; otherwise, …".
export function ruleSentence(rule: Pick<RuleDef, "triggerType" | "triggerConfig" | "conditions" | "actions">, ctx: RuleContext) {
  const trigger = describeTrigger(rule, ctx);
  const when = `When ${trigger.charAt(0).toLowerCase()}${trigger.slice(1)}`;
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

function optionDot(color: string) {
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
