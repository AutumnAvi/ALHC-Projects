"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useServerAction } from "@/components/toast";
import { createRule, updateRule } from "@/lib/actions";
import {
  ACTIONS,
  APPROVAL_DECISIONS,
  CONDITIONS,
  EMAIL_RECIPIENTS,
  EMAIL_TEMPLATES,
  TEXT_TOKENS,
  TRIGGERS,
  type ActionType,
  type ConditionType,
  type RuleAction,
  type RuleCondition,
  type RuleDef,
  type TriggerType,
} from "@/lib/rules";
import type { Json } from "@/lib/supabase/database.types";
import {
  FieldSelect,
  FieldValueInput,
  PeoplePicker,
  PersonSelect,
  SectionSelect,
  inputClass,
  labelClass,
  ruleFields,
  type RuleContext,
} from "./rule-shared";

type Draft = Pick<RuleDef, "name" | "triggerType" | "triggerConfig" | "conditions" | "actions">;

const EMPTY: Draft = {
  name: "",
  triggerType: "section_changed",
  triggerConfig: {},
  conditions: [],
  actions: [{ type: "add_comment", body: "" }],
};

function defaultsFor(type: ActionType): RuleAction {
  switch (type) {
    case "send_email":
      return { type, to: "submitter", template: "requester_update", message: "" };
    case "add_followers":
    case "notify":
      return { type, people: ["assignee"], ...(type === "notify" ? { message: "" } : {}) };
    case "request_approval":
      return { type, approver: "" };
    case "delay":
      return { type, hours: 24 };
    case "set_assignee":
      return { type, assignee: null };
    default:
      return { type };
  }
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function RuleEditor({
  projectId,
  rule,
  ctx,
  onDone,
}: {
  projectId: string;
  rule: RuleDef | null;
  ctx: RuleContext;
  onDone: () => void;
}) {
  const [pending, run] = useServerAction();
  const [draft, setDraft] = useState<Draft>(rule ?? EMPTY);
  const fields = ruleFields(ctx);
  const triggerField = fields.find((f) => f.id === draft.triggerConfig.field_id);
  const prefix = `rule-${rule?.id ?? "new"}`;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  function setConfig(patch: Record<string, Json | undefined>) {
    const next = { ...draft.triggerConfig };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") delete next[k];
      else next[k] = v;
    }
    set("triggerConfig", next);
  }
  function setCondition(index: number, next: RuleCondition | null) {
    set(
      "conditions",
      next ? draft.conditions.map((c, i) => (i === index ? next : c)) : draft.conditions.filter((_, i) => i !== index),
    );
  }
  function setAction(index: number, next: RuleAction | null) {
    set("actions", next ? draft.actions.map((a, i) => (i === index ? next : a)) : draft.actions.filter((_, i) => i !== index));
  }
  function moveAction(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= draft.actions.length) return;
    const copy = [...draft.actions];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    set("actions", copy);
  }

  return (
    <form
      className="space-y-5 rounded-lg border border-zinc-300 bg-white p-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const input = { ...draft };
          const result = rule ? await updateRule(rule.id, input) : await createRule(projectId, input);
          if (!result.error) onDone();
          return result;
        });
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${prefix}-name`} className={labelClass}>
          Rule name
        </label>
        <input
          id={`${prefix}-name`}
          value={draft.name}
          maxLength={200}
          placeholder="e.g. Tell the requester when work starts"
          onChange={(e) => set("name", e.currentTarget.value)}
          className={`${inputClass} w-full`}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-zinc-900">When</legend>
        <Row>
          <select
            aria-label="Trigger"
            value={draft.triggerType}
            onChange={(e) => setDraft((d) => ({ ...d, triggerType: e.currentTarget.value as TriggerType, triggerConfig: {} }))}
            className={inputClass}
          >
            {TRIGGERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {draft.triggerType === "section_changed" ? (
            <SectionSelect
              id={`${prefix}-trigger-section`}
              label="Section"
              value={draft.triggerConfig.section_id}
              ctx={ctx}
              onChange={(v) => setConfig({ section_id: v })}
            />
          ) : null}
          {draft.triggerType === "field_changed" ? (
            <>
              <FieldSelect
                id={`${prefix}-trigger-field`}
                label="Field"
                value={draft.triggerConfig.field_id}
                fields={fields.filter((f) => !f.boundToSections)}
                onChange={(v) => setConfig({ field_id: v, option_id: undefined })}
              />
              {triggerField && triggerField.options.length ? (
                <select
                  aria-label="Changes to"
                  value={typeof draft.triggerConfig.option_id === "string" ? draft.triggerConfig.option_id : ""}
                  onChange={(e) => setConfig({ option_id: e.currentTarget.value })}
                  className={inputClass}
                >
                  <option value="">to any value</option>
                  {triggerField.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      to {o.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </>
          ) : null}
          {draft.triggerType === "due_approaching" ? (
            <label className="flex items-center gap-1.5 text-sm text-zinc-700">
              <input
                type="number"
                min={0}
                max={30}
                value={typeof draft.triggerConfig.days === "number" ? draft.triggerConfig.days : 1}
                onChange={(e) => setConfig({ days: Number(e.currentTarget.value) })}
                className={`${inputClass} w-16`}
              />
              days before due
            </label>
          ) : null}
          {draft.triggerType === "approval_decided" ? (
            <fieldset className="flex flex-wrap gap-3">
              <legend className="sr-only">Decisions</legend>
              {APPROVAL_DECISIONS.map((d) => {
                const statuses = Array.isArray(draft.triggerConfig.statuses) ? draft.triggerConfig.statuses : [];
                return (
                  <label key={d.value} className="flex items-center gap-1.5 text-sm text-zinc-700">
                    <input
                      type="checkbox"
                      checked={statuses.includes(d.value)}
                      onChange={(e) => {
                        const next = e.currentTarget.checked
                          ? [...statuses, d.value]
                          : statuses.filter((s) => s !== d.value);
                        setConfig({ statuses: next.length ? next : undefined });
                      }}
                    />
                    {d.label}
                  </label>
                );
              })}
            </fieldset>
          ) : null}
          {draft.triggerType === "form_submitted" ? (
            <select
              aria-label="Form"
              value={typeof draft.triggerConfig.form_id === "string" ? draft.triggerConfig.form_id : ""}
              onChange={(e) => setConfig({ form_id: e.currentTarget.value })}
              className={inputClass}
            >
              <option value="">Any form</option>
              {ctx.forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
            </select>
          ) : null}
        </Row>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-zinc-900">Only if (all must match)</legend>
        {draft.conditions.map((condition, index) => (
          <Row key={index}>
            <select
              aria-label={`Condition ${index + 1}`}
              value={condition.type}
              onChange={(e) => setCondition(index, { type: e.currentTarget.value as ConditionType })}
              className={inputClass}
            >
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {condition.type === "section_is" || condition.type === "section_is_not" ? (
              <SectionSelect
                id={`${prefix}-c${index}-section`}
                label="Section"
                value={condition.section_id}
                ctx={ctx}
                onChange={(v) => setCondition(index, { ...condition, section_id: v })}
              />
            ) : null}
            {condition.type === "field_equals" || condition.type === "field_is_set" || condition.type === "field_is_empty" ? (
              <FieldSelect
                id={`${prefix}-c${index}-field`}
                label="Field"
                value={condition.field_id}
                fields={fields}
                onChange={(v) => setCondition(index, { type: condition.type, field_id: v })}
              />
            ) : null}
            {condition.type === "field_equals" ? (
              <FieldValueInput
                id={`${prefix}-c${index}-value`}
                field={fields.find((f) => f.id === condition.field_id)}
                value={condition.value}
                ctx={ctx}
                onChange={(v) => setCondition(index, { ...condition, value: v })}
              />
            ) : null}
            {condition.type === "source_is" ? (
              <select
                aria-label="Source"
                value={typeof condition.source === "string" ? condition.source : ""}
                onChange={(e) => setCondition(index, { ...condition, source: e.currentTarget.value })}
                className={inputClass}
              >
                <option value="">Choose…</option>
                <option value="form">A form</option>
                <option value="manual">Created in the app</option>
                <option value="import">An import</option>
              </select>
            ) : null}
            <button
              type="button"
              aria-label={`Remove condition ${index + 1}`}
              onClick={() => setCondition(index, null)}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            >
              <X className="size-4" />
            </button>
          </Row>
        ))}
        <button
          type="button"
          onClick={() => set("conditions", [...draft.conditions, { type: "is_incomplete" }])}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
        >
          <Plus className="size-3.5" aria-hidden />
          Add condition
        </button>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-zinc-900">Then (in order)</legend>
        <p className="text-xs text-zinc-500">Text can use {TEXT_TOKENS}.</p>
        {draft.actions.map((action, index) => (
          <div key={index} className="space-y-2 rounded-md bg-zinc-50 p-3">
            <Row>
              <span className="text-xs font-medium text-zinc-400">{index + 1}.</span>
              <select
                aria-label={`Action ${index + 1}`}
                value={action.type}
                onChange={(e) => setAction(index, defaultsFor(e.currentTarget.value as ActionType))}
                className={inputClass}
              >
                {ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
              <span className="flex-1" />
              <button
                type="button"
                aria-label={`Move action ${index + 1} up`}
                disabled={index === 0}
                onClick={() => moveAction(index, -1)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
              >
                <ArrowUp className="size-4" />
              </button>
              <button
                type="button"
                aria-label={`Move action ${index + 1} down`}
                disabled={index === draft.actions.length - 1}
                onClick={() => moveAction(index, 1)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
              >
                <ArrowDown className="size-4" />
              </button>
              <button
                type="button"
                aria-label={`Remove action ${index + 1}`}
                disabled={draft.actions.length === 1}
                onClick={() => setAction(index, null)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
              >
                <X className="size-4" />
              </button>
            </Row>
            <ActionFields
              prefix={`${prefix}-a${index}`}
              action={action}
              ctx={ctx}
              onChange={(next) => setAction(index, next)}
            />
          </div>
        ))}
        <button
          type="button"
          disabled={draft.actions.length >= 10}
          onClick={() => set("actions", [...draft.actions, defaultsFor("add_comment")])}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
        >
          <Plus className="size-3.5" aria-hidden />
          Add action
        </button>
      </fieldset>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || !draft.name.trim()}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {rule ? "Save rule" : "Create rule"}
        </button>
        <button type="button" onClick={onDone} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
          Cancel
        </button>
        {!rule ? <span className="text-xs text-zinc-500">New rules start turned off.</span> : null}
      </div>
    </form>
  );
}

function ActionFields({
  prefix,
  action,
  ctx,
  onChange,
}: {
  prefix: string;
  action: RuleAction;
  ctx: RuleContext;
  onChange: (next: RuleAction) => void;
}) {
  const fields = ruleFields(ctx);
  const text = (key: string, label: string, opts: { multiline?: boolean; placeholder?: string } = {}) => {
    const props = {
      id: `${prefix}-${key}`,
      "aria-label": label,
      placeholder: opts.placeholder ?? label,
      value: typeof action[key] === "string" ? (action[key] as string) : "",
      className: `${inputClass} w-full`,
    };
    return opts.multiline ? (
      <textarea {...props} rows={2} maxLength={5000} onChange={(e) => onChange({ ...action, [key]: e.currentTarget.value })} />
    ) : (
      <input {...props} maxLength={1000} onChange={(e) => onChange({ ...action, [key]: e.currentTarget.value })} />
    );
  };

  switch (action.type) {
    case "move_section":
      return (
        <SectionSelect id={`${prefix}-section`} label="Section" value={action.section_id} ctx={ctx} onChange={(v) => onChange({ ...action, section_id: v })} />
      );
    case "set_field":
      return (
        <Row>
          <FieldSelect
            id={`${prefix}-field`}
            label="Field"
            value={action.field_id}
            fields={fields}
            onChange={(v) => onChange({ type: action.type, field_id: v, value: null })}
          />
          <FieldValueInput
            id={`${prefix}-value`}
            field={fields.find((f) => f.id === action.field_id)}
            value={action.value}
            ctx={ctx}
            onChange={(v) => onChange({ ...action, value: v })}
          />
          {fields.find((f) => f.id === action.field_id)?.boundToSections ? (
            <span className="text-xs text-zinc-500">Status follows the section, so this moves the task.</span>
          ) : null}
        </Row>
      );
    case "set_assignee":
      return (
        <PersonSelect
          id={`${prefix}-assignee`}
          label="Assignee"
          value={action.assignee ?? ""}
          ctx={ctx}
          allowNone="Nobody (unassign)"
          onChange={(v) => onChange({ ...action, assignee: v || null })}
        />
      );
    case "add_comment":
      return text("body", "Comment", { multiline: true, placeholder: "@{assignee} this is ready for you" });
    case "add_followers":
      return <PeoplePicker idPrefix={`${prefix}-people`} label="Followers" value={action.people} ctx={ctx} onChange={(v) => onChange({ ...action, people: v })} />;
    case "notify":
      return (
        <div className="space-y-2">
          <PeoplePicker idPrefix={`${prefix}-people`} label="Notify" value={action.people} ctx={ctx} onChange={(v) => onChange({ ...action, people: v })} />
          {text("message", "Message")}
        </div>
      );
    case "request_approval":
      return (
        <div className="space-y-2">
          <PersonSelect id={`${prefix}-approver`} label="Approver" value={action.approver} ctx={ctx} onChange={(v) => onChange({ ...action, approver: v })} />
          {text("title", "Approval subtask title (optional)")}
          {text("note", "Note to the approver (optional)")}
        </div>
      );
    case "send_email":
      return (
        <div className="space-y-2">
          <Row>
            <select
              aria-label="Recipient"
              value={typeof action.to === "string" ? action.to : "submitter"}
              onChange={(e) => onChange({ ...action, to: e.currentTarget.value })}
              className={inputClass}
            >
              {EMAIL_RECIPIENTS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            {action.to === "field" ? (
              <FieldSelect
                id={`${prefix}-email-field`}
                label="Field holding the address"
                value={action.field_id}
                fields={fields.filter((f) => f.fieldType === "text")}
                onChange={(v) => onChange({ ...action, field_id: v })}
              />
            ) : null}
            {action.to === "address" ? (
              <input
                aria-label="Email address"
                type="email"
                placeholder="team@example.com"
                value={typeof action.address === "string" ? action.address : ""}
                onChange={(e) => onChange({ ...action, address: e.currentTarget.value })}
                className={inputClass}
              />
            ) : null}
            <select
              aria-label="Template"
              value={typeof action.template === "string" ? action.template : "requester_update"}
              onChange={(e) => onChange({ ...action, template: e.currentTarget.value })}
              className={inputClass}
            >
              {EMAIL_TEMPLATES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Row>
          {text("subject", "Subject (optional)")}
          {text("message", "Message", { multiline: true })}
          <Row>
            <span className={labelClass}>Include field</span>
            <FieldSelect
              id={`${prefix}-include`}
              label="Include a field value in the email"
              value={action.include_field_id}
              fields={fields}
              onChange={(v) => {
                const next = { ...action };
                if (v) next.include_field_id = v;
                else delete next.include_field_id;
                onChange(next);
              }}
            />
          </Row>
        </div>
      );
    case "delay":
      return (
        <label className="flex items-center gap-1.5 text-sm text-zinc-700">
          <input
            type="number"
            min={0.1}
            max={720}
            step={0.5}
            value={typeof action.hours === "number" ? action.hours : 24}
            onChange={(e) => onChange({ ...action, hours: Number(e.currentTarget.value) })}
            className={`${inputClass} w-20`}
          />
          hours, then run the remaining actions (skipped if the conditions stop matching or the rule is turned off)
        </label>
      );
    default:
      return null;
  }
}
