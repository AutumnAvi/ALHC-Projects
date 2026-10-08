"use client";

import type { FieldDef } from "@/lib/fields";
import type { ProjectIntegrations } from "@/lib/integrations-shared";
import {
  ACTIONS,
  APPROVAL_DECISIONS,
  CONDITIONS,
  EMAIL_RECIPIENTS,
  PERSON_ROLES,
  TRIGGERS,
  labelOf,
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

export const inputClass =
  "control h-auto min-h-8 py-1";
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

export function SectionSelect({
  id,
  label,
  value,
  ctx,
  onChange,
}: {
  id: string;
  label: string;
  value: Json | undefined;
  ctx: RuleContext;
  onChange: (value: string) => void;
}) {
  return (
    <select id={id} aria-label={label} value={str(value)} onChange={(e) => onChange(e.currentTarget.value)} className={inputClass}>
      <option value="">Choose section…</option>
      {ctx.sections.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

export function FieldSelect({
  id,
  label,
  value,
  fields,
  onChange,
}: {
  id: string;
  label: string;
  value: Json | undefined;
  fields: FieldDef[];
  onChange: (value: string) => void;
}) {
  return (
    <select id={id} aria-label={label} value={str(value)} onChange={(e) => onChange(e.currentTarget.value)} className={inputClass}>
      <option value="">Choose field…</option>
      {fields.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
          {f.boundToSections ? " (Status)" : ""}
        </option>
      ))}
    </select>
  );
}

export function PersonSelect({
  id,
  label,
  value,
  ctx,
  onChange,
  allowNone,
}: {
  id: string;
  label: string;
  value: Json | undefined;
  ctx: RuleContext;
  onChange: (value: string) => void;
  allowNone?: string;
}) {
  return (
    <select id={id} aria-label={label} value={str(value)} onChange={(e) => onChange(e.currentTarget.value)} className={inputClass}>
      <option value="">{allowNone ?? "Choose person…"}</option>
      <optgroup label="Roles">
        {PERSON_ROLES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="People">
        {ctx.people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

export function PeoplePicker({
  idPrefix,
  label,
  value,
  ctx,
  onChange,
}: {
  idPrefix: string;
  label: string;
  value: Json | undefined;
  ctx: RuleContext;
  onChange: (value: string[]) => void;
}) {
  const selected = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const options = [
    ...PERSON_ROLES.map((r) => ({ id: r.value as string, name: r.label })),
    ...ctx.people,
  ];
  return (
    <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <label key={o.id} htmlFor={`${idPrefix}-${o.id}`} className="flex items-center gap-1.5 text-sm text-zinc-700">
          <input
            id={`${idPrefix}-${o.id}`}
            type="checkbox"
            checked={selected.includes(o.id)}
            onChange={(e) =>
              onChange(e.currentTarget.checked ? [...selected, o.id] : selected.filter((s) => s !== o.id))
            }
          />
          {o.name}
        </label>
      ))}
    </fieldset>
  );
}

// Value editor matching how task_field_values stores each field type (bound Status → section id).
export function FieldValueInput({
  id,
  field,
  value,
  ctx,
  onChange,
}: {
  id: string;
  field: FieldDef | undefined;
  value: Json | undefined;
  ctx: RuleContext;
  onChange: (value: Json) => void;
}) {
  if (!field) return null;
  if (field.boundToSections) {
    return <SectionSelect id={id} label={`${field.name} value`} value={value} ctx={ctx} onChange={onChange} />;
  }
  switch (field.fieldType) {
    case "single_select":
      return (
        <select id={id} aria-label={`${field.name} value`} value={str(value)} onChange={(e) => onChange(e.currentTarget.value || null)} className={inputClass}>
          <option value="">Empty</option>
          {field.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case "multi_select": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
          <legend className="sr-only">{field.name} value</legend>
          {field.options.map((o) => (
            <label key={o.id} className="flex items-center gap-1.5 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={(e) =>
                  onChange(e.currentTarget.checked ? [...selected, o.id] : selected.filter((s) => s !== o.id))
                }
              />
              {o.name}
            </label>
          ))}
        </fieldset>
      );
    }
    case "boolean":
      return (
        <label className="flex items-center gap-1.5 text-sm text-zinc-700">
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} />
          Checked
        </label>
      );
    case "number":
      return (
        <input
          id={id}
          aria-label={`${field.name} value`}
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
          className={inputClass}
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
