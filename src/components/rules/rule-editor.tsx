"use client";

// The rule builder's building blocks (trigger settings, a condition, an action's settings, and the
// one-time signing-secret reveal), laid out by the rule canvas (rule-canvas.tsx).

import { FolderClosed, Plus, X } from "lucide-react";
import Link from "next/link";
import { useId, useState, useSyncExternalStore } from "react";
import type { RevealedSigningSecret } from "@/lib/actions";
import { dayLabel, isoDate, weekdayOf } from "@/lib/date-input";
import type { FieldDef } from "@/lib/fields";
import {
  DEFAULT_SECRET_HEADER,
  SIGNATURE_HEADER,
  SLACK_FORMATS,
  WEBHOOK_URL_ERROR,
  isAllowedHeaderName,
  isAllowedWebhookUrl,
} from "@/lib/integrations-shared";
import { SmartPicker } from "@/components/smart-picker";
import {
  APPROVAL_DECISIONS,
  CONDITIONS,
  DUE_FROM,
  EMAIL_RECIPIENTS,
  EMAIL_TEMPLATES,
  SCHEDULE_FREQUENCIES,
  TASK_KIND_OPTIONS,
  TASK_SOURCES,
  V2_CONDITIONS,
  compareOpsFor,
  type ActionType,
  type ConditionType,
  type RuleAction,
  type RuleCondition,
  type TriggerType,
} from "@/lib/rules";
import type { Json } from "@/lib/supabase/database.types";
import { DEFAULT_WORK_WEEK, WEEKDAYS, addWorkdays, describeWorkWeek, normalizeWorkWeek } from "@/lib/workdays";
import {
  FieldSelect,
  FieldValueInput,
  PeoplePicker,
  PersonSelect,
  SectionSelect,
  hourLabel,
  inputClass,
  labelClass,
  optionDot,
  ordinal,
  ruleFields,
  sectionOptions,
  tagOptions,
  valueOr,
  type RuleContext,
} from "./rule-shared";
import { vocabOptions } from "./rule-icons";

export function defaultsFor(type: ActionType): RuleAction {
  switch (type) {
    case "send_email":
      return { type, to: "submitter", template: "requester_update", message: "" };
    case "add_followers":
    case "notify":
      return { type, people: ["assignee"], ...(type === "notify" ? { message: "" } : {}) };
    case "request_approval":
      return { type, approver: "" };
    case "send_slack":
      return { type, message: "{task} moved to {section} in {project}" };
    case "call_webhook":
      return { type };
    case "delay":
      return { type, hours: 24 };
    case "set_assignee":
      return { type, assignee: null };
    case "set_due_date":
      return { type, mode: "relative", days: 2, business_days: true, from: "today" };
    case "create_subtasks":
      return { type, titles: [""] };
    case "set_title":
      return { type, title: "{task}" };
    default:
      return { type };
  }
}

// A new condition of this type (the database needs a number of days for Due within).
export function conditionDefaultsFor(type: ConditionType): RuleCondition {
  return type === "due_within" ? { type, days: 3 } : { type };
}

const NEEDS_V2 = "Needs this release’s database update";
const MAX_SUBTASK_TITLES = 20;

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function Word({ children }: { children: React.ReactNode }) {
  return <span className="text-zinc-600">{children}</span>;
}

function str(value: Json | undefined) {
  return typeof value === "string" ? value : "";
}

function wholeNumber(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

// A copy without `keys` (an emptied input removes its key, so the database sees "not set").
function omit<T extends Record<string, Json>>(item: T, ...keys: string[]): T {
  const copy = { ...item };
  for (const key of keys) delete copy[key];
  return copy;
}

// A small number box. What's typed stays as typed while it has focus (so "-" or an emptied box isn't
// replaced mid-edit); each change commits the number, or null when the box is empty or half typed.
function NumberBox({
  id,
  label,
  value,
  onCommit,
  min,
  max,
  whole = true,
  placeholder,
  className = "w-16",
}: {
  id?: string;
  label: string;
  value: number | null;
  onCommit: (value: number | null) => void;
  min?: number;
  max?: number;
  // Whole numbers only (days); off for number fields.
  whole?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      id={id}
      type="number"
      inputMode={whole && (min ?? 0) >= 0 ? "numeric" : undefined}
      aria-label={label}
      min={min}
      max={max}
      step={whole ? 1 : "any"}
      placeholder={placeholder}
      value={draft ?? (value ?? "")}
      onChange={(e) => {
        const raw = e.currentTarget.value;
        setDraft(raw);
        const n = raw === "" ? NaN : Number(raw);
        onCommit(Number.isFinite(n) ? (whole ? Math.trunc(n) : n) : null);
      }}
      onBlur={() => setDraft(null)}
      className={`${inputClass} ${className}`}
    />
  );
}

function noSubscribe() {
  return () => {};
}

function localToday() {
  const now = new Date();
  return isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate()) ?? "";
}

// The browser's date; null while rendering on the server, so nothing that uses it mismatches on hydration.
function useLocalToday(): string | null {
  return useSyncExternalStore(noSubscribe, localToday, () => null) || null;
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: hourLabel(h),
  keywords: [`${h}:00`, ...(h === 0 ? ["midnight"] : h === 12 ? ["noon"] : [])],
}));

const WEEKDAY_OPTIONS = WEEKDAYS.map((d) => ({ value: String(d.value), label: d.label, keywords: [d.short] }));

const MONTH_DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `the ${ordinal(i + 1)}` }));

// Shown once after a save that generated Call webhook signing secrets; nothing can show them again.
export function RevealedSecrets({
  secrets,
  onDone,
  describe = (s) => `Call webhook (action ${s.action})`,
}: {
  secrets: RevealedSigningSecret[];
  onDone: () => void;
  // Where the action sits (the canvas names the branch too).
  describe?: (secret: RevealedSigningSecret) => string;
}) {
  const [copied, setCopied] = useState<number | null>(null);
  return (
    <div role="status" className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-medium text-amber-900">
        Rule saved. Copy the signing {secrets.length === 1 ? "secret" : "secrets"} now — {secrets.length === 1 ? "it" : "they"}{" "}
        won’t be shown again.
      </p>
      {secrets.map((s) => (
        <div key={s.action} className="space-y-1">
          <p className="text-xs text-amber-900">{describe(s)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs text-zinc-900">{s.secret}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(s.secret).then(() => setCopied(s.action));
              }}
              className="rounded-md px-2.5 py-1 text-sm text-zinc-700 hover:bg-white"
            >
              {copied === s.action ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ))}
      <p className="text-xs text-amber-900">
        The receiver checks {SIGNATURE_HEADER} with it (see the Integrations settings page for the format).
      </p>
      <button
        type="button"
        onClick={onDone}
        className="rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600"
      >
        Done
      </button>
    </div>
  );
}

// The trigger's own settings (which section, field, option, days, decisions, endpoint, or form).
export function TriggerFields({
  prefix,
  triggerType,
  triggerConfig,
  ctx,
  onChange,
}: {
  prefix: string;
  triggerType: TriggerType;
  triggerConfig: Record<string, Json>;
  ctx: RuleContext;
  onChange: (config: Record<string, Json>) => void;
}) {
  const fields = ruleFields(ctx);
  const triggerField = fields.find((f) => f.id === triggerConfig.field_id);
  function setConfig(patch: Record<string, Json | undefined>) {
    const next = { ...triggerConfig };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") delete next[k];
      else next[k] = v;
    }
    onChange(next);
  }
  switch (triggerType) {
    case "section_changed":
      return (
        <SectionSelect
          id={`${prefix}-trigger-section`}
          label="Section"
          value={triggerConfig.section_id}
          ctx={ctx}
          onChange={(v) => setConfig({ section_id: v })}
        />
      );
    case "field_changed":
      return (
        <Row>
          <FieldSelect
            id={`${prefix}-trigger-field`}
            label="Field"
            value={triggerConfig.field_id}
            fields={fields.filter((f) => !f.boundToSections)}
            onChange={(v) => setConfig({ field_id: v, option_id: undefined })}
          />
          {triggerField && triggerField.options.length ? (
            <SmartPicker
              label="Changes to"
              value={typeof triggerConfig.option_id === "string" ? triggerConfig.option_id : ""}
              options={[
                { value: "", label: "to any value", description: "Any change to the field" },
                ...triggerField.options.map((o) => ({ value: o.id, label: `to ${o.name}` })),
              ]}
              onChange={(v) => setConfig({ option_id: v })}
              variant="chip"
              renderValue={valueOr(triggerConfig.option_id ? "to a removed option" : "to any value")}
            />
          ) : null}
        </Row>
      );
    case "due_approaching":
      return (
        <label className="flex items-center gap-1.5 text-sm text-zinc-700">
          <input
            type="number"
            min={0}
            max={30}
            value={typeof triggerConfig.days === "number" ? triggerConfig.days : 1}
            onChange={(e) => setConfig({ days: Number(e.currentTarget.value) })}
            className={`${inputClass} w-16`}
          />
          days before it’s due
        </label>
      );
    case "approval_decided": {
      const statuses = Array.isArray(triggerConfig.statuses)
        ? triggerConfig.statuses.filter((v): v is string => typeof v === "string")
        : [];
      return (
        <SmartPicker
          multiple
          label="Decisions"
          value={statuses}
          options={APPROVAL_DECISIONS.map((d) => ({ value: d.value, label: d.label }))}
          onChange={(next) => setConfig({ statuses: next.length ? next : undefined })}
          variant="chip"
          placeholder="with any decision"
          renderValue={(chosen) => (chosen.length ? <span>as {chosen.map((c) => c.label.toLowerCase()).join(" or ")}</span> : undefined)}
        />
      );
    }
    case "inbound_received":
      return (
        <SmartPicker
          label="Inbound webhook"
          value={typeof triggerConfig.endpoint_id === "string" ? triggerConfig.endpoint_id : ""}
          options={[
            { value: "", label: "Any inbound webhook" },
            ...ctx.inboundEndpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.name })),
          ]}
          onChange={(v) => setConfig({ endpoint_id: v })}
          variant="chip"
          renderValue={valueOr(triggerConfig.endpoint_id ? "a removed inbound webhook" : "Any inbound webhook")}
        />
      );
    case "form_submitted":
      return (
        <SmartPicker
          label="Form"
          value={typeof triggerConfig.form_id === "string" ? triggerConfig.form_id : ""}
          options={[{ value: "", label: "Any form" }, ...ctx.forms.map((f) => ({ value: f.id, label: f.title }))]}
          onChange={(v) => setConfig({ form_id: v })}
          variant="chip"
          renderValue={valueOr(triggerConfig.form_id ? "a removed form" : "Any form")}
          emptyText="Add a form to this project first"
        />
      );
    case "tag_added":
      return (
        <SmartPicker
          id={`${prefix}-trigger-tag`}
          label="Tag"
          value={str(triggerConfig.tag_id)}
          options={[{ value: "", label: "any tag", description: "Whichever tag is added" }, ...tagOptions(ctx, { archived: "marked" })]}
          onChange={(v) => setConfig({ tag_id: v })}
          variant="chip"
          renderValue={valueOr(triggerConfig.tag_id ? "a removed tag" : "any tag")}
          emptyText={ctx.tags?.length ? "No tag matches" : "No tags yet"}
        />
      );
    case "task_overdue": {
      // `days` = how many days overdue (1 = the day after the due date; missing or 0 counts as 1;
      // validate_rule allows up to 30), as workflow_tick reads it.
      const after = Math.max(wholeNumber(triggerConfig.days) ?? 1, 1);
      return (
        <span className="flex items-center gap-1.5 text-sm text-zinc-700">
          <NumberBox
            id={`${prefix}-trigger-overdue-days`}
            label="Days after the due date"
            value={after}
            min={1}
            max={30}
            onCommit={(n) => {
              if (n !== null) setConfig({ days: Math.min(Math.max(n, 1), 30) });
            }}
          />
          {after === 1 ? "day after it’s due (when it becomes overdue)" : "days after it’s due"}
        </span>
      );
    }
    case "scheduled":
      return <ScheduleFields prefix={prefix} config={triggerConfig} ctx={ctx} setConfig={setConfig} />;
    default:
      return null;
  }
}

// On a schedule: how often, the weekday or day of the month, and the hour (in the rule's time zone,
// which the canvas saves with the rule).
function ScheduleFields({
  prefix,
  config,
  ctx,
  setConfig,
}: {
  prefix: string;
  config: Record<string, Json>;
  ctx: RuleContext;
  setConfig: (patch: Record<string, Json | undefined>) => void;
}) {
  const frequency = str(config.frequency);
  const workWeek = normalizeWorkWeek(ctx.workWeek ?? DEFAULT_WORK_WEEK);
  return (
    <Row>
      <SmartPicker
        id={`${prefix}-schedule-frequency`}
        label="How often"
        value={frequency || null}
        options={SCHEDULE_FREQUENCIES.map((f) => ({ ...f }))}
        onChange={(v) =>
          setConfig({
            frequency: v,
            // Weekly starts on the first workday and monthly on the 1st; other frequencies drop them.
            weekday: v === "weekly" ? (wholeNumber(config.weekday) ?? workWeek[0]) : undefined,
            month_day: v === "monthly" ? (wholeNumber(config.month_day) ?? 1) : undefined,
          })
        }
        variant="chip"
        placeholder="choose how often"
      />
      {frequency === "weekly" ? (
        <SmartPicker
          id={`${prefix}-schedule-weekday`}
          label="Day of the week"
          value={String(wholeNumber(config.weekday) ?? 0)}
          options={WEEKDAY_OPTIONS}
          onChange={(v) => setConfig({ weekday: Number(v) })}
          variant="chip"
          renderValue={(chosen) => <span>on {chosen[0]?.label ?? "Sunday"}</span>}
        />
      ) : null}
      {frequency === "monthly" ? (
        <SmartPicker
          id={`${prefix}-schedule-month-day`}
          label="Day of the month"
          value={String(wholeNumber(config.month_day) ?? 1)}
          options={MONTH_DAY_OPTIONS}
          onChange={(v) => setConfig({ month_day: Number(v) })}
          variant="chip"
          renderValue={(chosen) => <span>on {chosen[0]?.label ?? "the 1st"}</span>}
        />
      ) : null}
      {frequency ? (
        <SmartPicker
          id={`${prefix}-schedule-hour`}
          label="Time of day"
          value={String(wholeNumber(config.hour) ?? 9)}
          options={HOUR_OPTIONS}
          onChange={(v) => setConfig({ hour: Number(v) })}
          variant="chip"
          renderValue={(chosen) => <span>at {chosen[0]?.label ?? hourLabel(9)}</span>}
        />
      ) : null}
      {frequency === "workdays" ? <span className="text-xs text-zinc-500">({describeWorkWeek(workWeek)})</span> : null}
    </Row>
  );
}

// One condition: its type, then what it compares (section, field, value, or source).
export function ConditionFields({
  prefix,
  condition,
  ctx,
  onChange,
}: {
  prefix: string;
  condition: RuleCondition;
  ctx: RuleContext;
  onChange: (next: RuleCondition) => void;
}) {
  const fields = ruleFields(ctx);
  return (
    <Row>
      <SmartPicker
        label="Condition"
        value={condition.type}
        options={vocabOptions(CONDITIONS, { disabled: (v) => (ctx.v2 === false && V2_CONDITIONS.has(v) ? NEEDS_V2 : null) })}
        onChange={(v) => onChange(conditionDefaultsFor(v as ConditionType))}
        variant="chip"
        searchable
      />
      <V2ConditionFields prefix={prefix} condition={condition} ctx={ctx} onChange={onChange} />
      {condition.type === "section_is" || condition.type === "section_is_not" ? (
        <SectionSelect
          id={`${prefix}-section`}
          label="Section"
          value={condition.section_id}
          ctx={ctx}
          onChange={(v) => onChange({ ...condition, section_id: v })}
        />
      ) : null}
      {condition.type === "field_equals" || condition.type === "field_is_set" || condition.type === "field_is_empty" ? (
        <FieldSelect
          id={`${prefix}-field`}
          label="Field"
          value={condition.field_id}
          fields={fields}
          onChange={(v) => onChange({ type: condition.type, field_id: v })}
        />
      ) : null}
      {condition.type === "field_equals" ? (
        <FieldValueInput
          id={`${prefix}-value`}
          field={fields.find((f) => f.id === condition.field_id)}
          value={condition.value}
          ctx={ctx}
          onChange={(v) => onChange({ ...condition, value: v })}
        />
      ) : null}
      {condition.type === "source_is" ? (
        <SmartPicker
          label="Source"
          value={typeof condition.source === "string" ? condition.source : null}
          options={TASK_SOURCES.map((x) => ({ ...x }))}
          onChange={(v) => onChange({ ...condition, source: v })}
          variant="chip"
          placeholder="choose source"
        />
      ) : null}
    </Row>
  );
}

// The Automations V2 conditions' settings (null for the ones without any).
function V2ConditionFields({
  prefix,
  condition,
  ctx,
  onChange,
}: {
  prefix: string;
  condition: RuleCondition;
  ctx: RuleContext;
  onChange: (next: RuleCondition) => void;
}) {
  switch (condition.type) {
    case "field_compare": {
      const fields = ruleFields(ctx).filter((f) => compareOpsFor(f.fieldType, f.boundToSections).length > 0);
      const field = fields.find((f) => f.id === condition.field_id);
      const ops = field ? compareOpsFor(field.fieldType, field.boundToSections) : [];
      return (
        <>
          <FieldSelect
            id={`${prefix}-compare-field`}
            label="Field"
            value={condition.field_id}
            fields={fields}
            onChange={(v) => {
              if (v === condition.field_id) return;
              // A new field starts over: its first comparison, no value yet.
              const next = fields.find((f) => f.id === v);
              const op = next ? compareOpsFor(next.fieldType, next.boundToSections)[0]?.value : undefined;
              onChange({ type: condition.type, field_id: v, ...(op ? { op } : {}) });
            }}
          />
          {field ? (
            <SmartPicker
              id={`${prefix}-compare-op`}
              label="Comparison"
              value={str(condition.op) || null}
              options={ops.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(v) => onChange({ ...condition, op: v })}
              variant="chip"
              placeholder="choose comparison"
            />
          ) : null}
          {field ? (
            <CompareValueInput
              id={`${prefix}-compare-value`}
              field={field}
              value={condition.value}
              ctx={ctx}
              onChange={(v) => onChange(v === null ? omit(condition, "value") : { ...condition, value: v })}
            />
          ) : null}
        </>
      );
    }
    case "has_tag":
    case "lacks_tag":
      return (
        <SmartPicker
          id={`${prefix}-tag`}
          label="Tag"
          value={str(condition.tag_id) || null}
          options={tagOptions(ctx, { archived: "marked" })}
          onChange={(v) => onChange({ ...condition, tag_id: v })}
          variant="chip"
          placeholder="choose tag"
          emptyText={ctx.tags?.length ? "No tag matches" : "No tags yet"}
        />
      );
    case "assignee_is":
    case "assignee_is_not":
    case "creator_is":
      return (
        <PeoplePicker
          idPrefix={`${prefix}-people`}
          label={condition.type === "creator_is" ? "Created by" : "Assignee"}
          value={condition.people}
          ctx={ctx}
          onChange={(v) => onChange(v.length ? { ...condition, people: v } : omit(condition, "people"))}
        />
      );
    case "due_within": {
      const days = wholeNumber(condition.days);
      return (
        <span className="flex items-center gap-1.5 text-sm text-zinc-700">
          <NumberBox
            id={`${prefix}-days`}
            label="Due within this many days"
            value={days}
            min={0}
            max={365}
            placeholder="3"
            onCommit={(n) => onChange(n === null ? omit(condition, "days") : { ...condition, days: n })}
          />
          {days === 1 ? "day" : "days"}
        </span>
      );
    }
    case "task_type_is":
      return (
        <SmartPicker
          id={`${prefix}-kind`}
          label="Task type"
          value={str(condition.kind) || null}
          options={TASK_KIND_OPTIONS.map((k) => ({ ...k }))}
          onChange={(v) => onChange({ ...condition, kind: v })}
          variant="chip"
          placeholder="choose type"
        />
      );
    case "title_contains":
      return (
        <input
          id={`${prefix}-text`}
          aria-label="Text in the task name"
          placeholder="video"
          value={str(condition.text)}
          maxLength={200}
          onChange={(e) => onChange({ ...condition, text: e.currentTarget.value })}
          className={`${inputClass} w-40`}
        />
      );
    case "form_answer_contains": {
      // Every question of every form, under its form's title (a question id appears once).
      const seen = new Set<string>();
      const questions = ctx.forms.flatMap((form) =>
        (form.questions ?? []).flatMap((q) => {
          if (seen.has(q.id)) return [];
          seen.add(q.id);
          return [{ value: q.id, label: q.label || "Untitled question", group: form.title }];
        }),
      );
      const known = !condition.question_id || seen.has(str(condition.question_id));
      return (
        <>
          <input
            id={`${prefix}-text`}
            aria-label="Text in the form answer"
            placeholder="print"
            value={str(condition.text)}
            maxLength={200}
            onChange={(e) => onChange({ ...condition, text: e.currentTarget.value })}
            className={`${inputClass} w-40`}
          />
          <SmartPicker
            id={`${prefix}-question`}
            label="Form question"
            value={str(condition.question_id)}
            options={[{ value: "", label: "in any answer", description: "Any question of the task’s form submission" }, ...questions]}
            onChange={(v) => onChange(v ? { ...condition, question_id: v } : omit(condition, "question_id"))}
            variant="chip"
            renderValue={(chosen) =>
              chosen[0] ? <span className="truncate">in “{chosen[0].label}”</span> : <span>{known ? "in any answer" : "in a removed question"}</span>
            }
            emptyText={ctx.forms.length ? "No question matches" : "Add a form to this project first"}
          />
        </>
      );
    }
    default:
      return null;
  }
}

// The value a Field compares condition compares with (task_field_values' shapes: a number, a
// YYYY-MM-DD date, text, one option id, true / false, or a section id for the section-bound Status).
function CompareValueInput({
  id,
  field,
  value,
  ctx,
  onChange,
}: {
  id: string;
  field: FieldDef;
  value: Json | undefined;
  ctx: RuleContext;
  onChange: (value: Json) => void;
}) {
  const label = `${field.name} value to compare with`;
  if (field.boundToSections) {
    return <SectionSelect id={id} label={label} value={value} ctx={ctx} onChange={onChange} />;
  }
  switch (field.fieldType) {
    case "number":
      return (
        <NumberBox
          id={id}
          label={label}
          value={typeof value === "number" ? value : null}
          whole={false}
          className="w-28"
          onCommit={onChange}
        />
      );
    case "date":
      return <input id={id} aria-label={label} type="date" value={str(value)} onChange={(e) => onChange(e.currentTarget.value || null)} className={inputClass} />;
    case "single_select":
    case "multi_select":
      return (
        <SmartPicker
          id={id}
          label={label}
          value={str(value) || null}
          options={field.options.map((o) => ({ value: o.id, label: o.name, icon: optionDot(o.color) }))}
          onChange={onChange}
          variant="chip"
          placeholder="choose option"
          emptyText={field.options.length ? "No option matches" : "This field has no options yet"}
        />
      );
    case "boolean":
      return (
        <SmartPicker
          id={id}
          label={label}
          value={value === true ? "true" : value === false ? "false" : null}
          options={[
            { value: "true", label: "Checked" },
            { value: "false", label: "Unchecked" },
          ]}
          onChange={(v) => onChange(v === "true")}
          variant="chip"
          placeholder="choose value"
        />
      );
    default:
      return (
        <input
          id={id}
          aria-label={label}
          value={str(value)}
          maxLength={1000}
          onChange={(e) => onChange(e.currentTarget.value === "" ? null : e.currentTarget.value)}
          className={`${inputClass} w-40`}
        />
      );
  }
}

// Actions whose settings fit on the sentence line (part = inline). The rest draw below it.
export const INLINE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "move_section", "set_field", "set_assignee", "add_followers", "request_approval", "delay",
  // Automations V2 (Mark complete / incomplete have no settings at all).
  "complete_task", "reopen_task", "add_tag", "remove_tag", "add_to_project", "set_due_date", "apply_task_template",
]);
// Of those, the ones with more settings below the line too (part = block).
export const INLINE_AND_BLOCK_ACTION_TYPES: ReadonlySet<string> = new Set(["request_approval"]);

// An action's settings. The sentence builder draws short ones on the action's line (part = inline: a
// section, a field and its value, a person, hours) and the rest below it (part = block: messages,
// recipients, integrations). Without `part` everything is drawn.
export function ActionFields({
  projectId,
  prefix,
  action,
  ctx,
  onChange,
  part,
}: {
  projectId: string;
  prefix: string;
  action: RuleAction;
  ctx: RuleContext;
  onChange: (next: RuleAction) => void;
  part?: "inline" | "block";
}) {
  const fields = ruleFields(ctx);
  const inline = part !== "block";
  const block = part !== "inline";
  const text = (key: string, label: string, opts: { multiline?: boolean; placeholder?: string; maxLength?: number } = {}) => {
    const props = {
      id: `${prefix}-${key}`,
      "aria-label": label,
      placeholder: opts.placeholder ?? label,
      value: typeof action[key] === "string" ? (action[key] as string) : "",
      className: `${inputClass} w-full`,
    };
    return opts.multiline ? (
      <textarea {...props} rows={2} maxLength={opts.maxLength ?? 5000} onChange={(e) => onChange({ ...action, [key]: e.currentTarget.value })} />
    ) : (
      <input {...props} maxLength={opts.maxLength ?? 1000} onChange={(e) => onChange({ ...action, [key]: e.currentTarget.value })} />
    );
  };

  switch (action.type) {
    case "move_section":
      return !inline ? null : (
        <SectionSelect id={`${prefix}-section`} label="Section" value={action.section_id} ctx={ctx} onChange={(v) => onChange({ ...action, section_id: v })} />
      );
    case "set_field":
      return !inline ? null : (
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
      return !inline ? null : (
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
      return !block ? null : text("body", "Comment", { multiline: true, placeholder: "@{assignee} this is ready for you" });
    case "add_followers":
      return !inline ? null : <PeoplePicker idPrefix={`${prefix}-people`} label="Followers" value={action.people} ctx={ctx} onChange={(v) => onChange({ ...action, people: v })} />;
    case "notify":
      return !block ? null : (
        <div className="space-y-2">
          <PeoplePicker idPrefix={`${prefix}-people`} label="Notify" value={action.people} ctx={ctx} onChange={(v) => onChange({ ...action, people: v })} />
          {text("message", "Message")}
        </div>
      );
    case "request_approval":
      if (part === "inline") {
        return <PersonSelect id={`${prefix}-approver`} label="Approver" value={action.approver} ctx={ctx} onChange={(v) => onChange({ ...action, approver: v })} placeholder="choose approver" />;
      }
      return (
        <div className="space-y-2">
          {part === "block" ? null : (
            <PersonSelect id={`${prefix}-approver`} label="Approver" value={action.approver} ctx={ctx} onChange={(v) => onChange({ ...action, approver: v })} />
          )}
          {text("title", "Approval subtask title (optional)")}
          {text("note", "Note to the approver (optional)")}
        </div>
      );
    case "send_email":
      return !block ? null : (
        <div className="space-y-2">
          <Row>
            <span className="text-zinc-600">to</span>
            <SmartPicker
              label="Recipient"
              value={typeof action.to === "string" ? action.to : "submitter"}
              options={EMAIL_RECIPIENTS.map((r) => ({ ...r }))}
              onChange={(v) => onChange({ ...action, to: v })}
              variant="chip"
            />
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
            <span className="text-zinc-600">using</span>
            <SmartPicker
              label="Template"
              value={typeof action.template === "string" ? action.template : "requester_update"}
              options={EMAIL_TEMPLATES.map((t) => ({ ...t }))}
              onChange={(v) => onChange({ ...action, template: v })}
              variant="chip"
            />
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
    case "send_slack":
    case "call_webhook":
      return !block ? null : <IntegrationFields projectId={projectId} prefix={prefix} action={action} ctx={ctx} onChange={onChange} />;
    case "delay":
      return !inline ? null : (
        <label className="flex items-center gap-1.5 text-sm text-zinc-700" title="The remaining actions are skipped if the conditions stop matching or the rule is turned off">
          <span className="sr-only">Hours to wait</span>
          <input
            type="number"
            min={0.1}
            max={720}
            step={0.5}
            value={typeof action.hours === "number" ? action.hours : 24}
            onChange={(e) => onChange({ ...action, hours: Number(e.currentTarget.value) })}
            className={`${inputClass} w-20`}
          />
          hours, then continue
        </label>
      );
    case "complete_task":
    case "reopen_task":
      return null;
    case "add_tag":
    case "remove_tag":
      return !inline ? null : (
        <SmartPicker
          id={`${prefix}-tag`}
          label="Tag"
          value={str(action.tag_id) || null}
          // An archived tag can still be removed, but not added.
          options={tagOptions(ctx, { archived: action.type === "add_tag" ? "disabled" : "marked" })}
          onChange={(v) => onChange({ ...action, tag_id: v })}
          variant="chip"
          placeholder="choose tag"
          emptyText={ctx.tags?.length ? "No tag matches" : "No tags yet"}
        />
      );
    case "add_to_project": {
      if (!inline) return null;
      const projects = ctx.otherProjects ?? [];
      const project = projects.find((p) => p.id === action.project_id);
      return (
        <Row>
          <SmartPicker
            id={`${prefix}-project`}
            label="Project"
            value={str(action.project_id) || null}
            options={projects.map((p) => ({ value: p.id, label: p.name, icon: <FolderClosed className="size-4" /> }))}
            // Another project's sections don't carry over.
            onChange={(v) => {
              if (v !== action.project_id) onChange({ ...omit(action, "section_id"), project_id: v });
            }}
            variant="chip"
            placeholder="choose project"
            // Unfilled, the picker draws its dashed placeholder; a saved project missing from the list
            // (the viewer isn't an Editor there) is named as such.
            renderValue={action.project_id ? valueOr("a project you can’t edit") : undefined}
            emptyText={projects.length ? "No project matches" : "You aren’t an Editor in another project"}
          />
          {project ? (
            <>
              <Word>in</Word>
              <SmartPicker
                id={`${prefix}-project-section`}
                label={`Section in ${project.name}`}
                value={str(action.section_id)}
                options={[
                  { value: "", label: "no section", description: "Listed under “No section”" },
                  ...sectionOptions({ ...ctx, sections: project.sections }),
                ]}
                onChange={(v) => onChange(v ? { ...action, section_id: v } : omit(action, "section_id"))}
                variant="chip"
                renderValue={valueOr("no section")}
              />
            </>
          ) : null}
        </Row>
      );
    }
    case "set_due_date":
      return !inline ? null : <SetDueDateFields prefix={prefix} action={action} ctx={ctx} onChange={onChange} />;
    case "apply_task_template": {
      if (!inline) return null;
      const templates = ctx.taskTemplates ?? [];
      return (
        <SmartPicker
          id={`${prefix}-template`}
          label="Task template"
          value={str(action.template_id) || null}
          options={templates.map((t) => ({ value: t.id, label: t.name }))}
          onChange={(v) => onChange({ ...action, template_id: v })}
          variant="chip"
          placeholder="choose template"
          emptyText={templates.length ? "No template matches" : "Add a task template first (Settings → Templates)"}
        />
      );
    }
    case "set_title":
      return !block ? null : text("title", "New task name", { placeholder: "[{task}] Review", maxLength: 500 });
    case "create_subtasks":
      return !block ? null : <CreateSubtasksFields prefix={prefix} action={action} ctx={ctx} onChange={onChange} />;
    default:
      return null;
  }
}

// Set due date: "to [2] [business days] from [today]" (or "clear it"), with an example in the
// browser's own calendar.
function SetDueDateFields({
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
  const today = useLocalToday();
  const clear = action.mode === "clear";
  const days = wholeNumber(action.days);
  const business = action.business_days === true;
  const from = str(action.from) || "today";
  const workWeek = normalizeWorkWeek(ctx.workWeek ?? DEFAULT_WORK_WEEK);
  const plural = days === null || Math.abs(days) !== 1;

  let example: string | null = null;
  if (!clear && today && days !== null && Math.abs(days) <= 365) {
    const result = addWorkdays(today, days, business, workWeek);
    const year = Number(today.slice(0, 4));
    const day = (d: string) => `${WEEKDAYS[weekdayOf(d)].short}, ${dayLabel(d, year)}`;
    const start = from === "today" ? "today" : `${from === "due_date" ? "due" : "starting"} ${day(today)}`;
    if (result) example = `e.g. ${start} → ${day(result)}`;
  }

  return (
    <Row>
      <SmartPicker
        id={`${prefix}-due-mode`}
        label="Set or clear the due date"
        value={clear ? "clear" : "relative"}
        options={[
          { value: "relative", label: "to", description: "A number of days from a date" },
          { value: "clear", label: "clear it", description: "Removes the due date" },
        ]}
        onChange={(v) => {
          // Picking the current choice again keeps the days, unit, and start.
          if (v === (clear ? "clear" : "relative")) return;
          onChange(v === "clear" ? { type: action.type, mode: "clear" } : defaultsFor("set_due_date"));
        }}
        variant="chip"
      />
      {clear ? null : (
        <>
          <NumberBox
            id={`${prefix}-due-days`}
            label="Days (negative for earlier)"
            value={days}
            min={-365}
            max={365}
            placeholder="2"
            onCommit={(n) => onChange(n === null ? omit(action, "days") : { ...action, days: n })}
          />
          <span data-tooltip={business ? `Business days: ${describeWorkWeek(workWeek)}` : undefined}>
            <SmartPicker
              id={`${prefix}-due-unit`}
              label="Count days or business days"
              value={business ? "business" : "days"}
              options={[
                { value: "days", label: plural ? "days" : "day", description: "Every day of the week" },
                {
                  value: "business",
                  label: plural ? "business days" : "business day",
                  description: `Only workdays (${describeWorkWeek(workWeek)}; Admin console → Organization)`,
                },
              ]}
              onChange={(v) => onChange({ ...action, business_days: v === "business" })}
              variant="chip"
            />
          </span>
          <Word>from</Word>
          <SmartPicker
            id={`${prefix}-due-from`}
            label="Count from"
            value={from}
            options={DUE_FROM.map((d) => ({ ...d }))}
            onChange={(v) => onChange({ ...action, from: v })}
            variant="chip"
          />
          {example ? <span className="text-xs text-zinc-500">{example}</span> : null}
        </>
      )}
    </Row>
  );
}

// Create subtasks: one name per row (1–20; placeholders work), and who to assign them to.
function CreateSubtasksFields({
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
  // validate_rule refuses a blank name, so rows still being typed (an Enter-added row, a cleared one)
  // live only here and the action stores the filled-in names.
  const stored = Array.isArray(action.titles)
    ? action.titles.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];
  const [rows, setRows] = useState<string[]>(stored.length ? stored : [""]);
  const filled = (list: string[]) => list.filter((t) => t.trim() !== "");
  // The action changed from outside (another action took this slot, a move, a template): start over.
  if (JSON.stringify(filled(rows)) !== JSON.stringify(stored)) setRows(stored.length ? stored : [""]);
  const titles = rows;
  const setTitles = (next: string[]) => {
    setRows(next);
    onChange({ ...action, titles: filled(next) });
  };
  const inputId = (i: number) => `${prefix}-subtask-${i}`;

  function addAfter(i: number) {
    if (titles.length >= MAX_SUBTASK_TITLES) return;
    setTitles([...titles.slice(0, i + 1), "", ...titles.slice(i + 1)]);
    requestAnimationFrame(() => document.getElementById(inputId(i + 1))?.focus());
  }

  return (
    <div className="space-y-1.5">
      <ol aria-label="Subtasks to create" className="space-y-1">
        {titles.map((title, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <span aria-hidden className="w-4 text-right text-xs tabular-nums text-zinc-400">
              {i + 1}.
            </span>
            <input
              id={inputId(i)}
              aria-label={`Subtask ${i + 1} name`}
              placeholder={i === 0 ? "Draft the copy for {task}" : "Subtask name"}
              value={title}
              maxLength={500}
              onChange={(e) => setTitles(titles.map((t, j) => (j === i ? e.currentTarget.value : t)))}
              onKeyDown={(e) => {
                // Enter adds the next row, like a checklist.
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  addAfter(i);
                }
              }}
              className={`${inputClass} min-w-0 flex-1`}
            />
            <button
              type="button"
              aria-label={`Remove subtask ${i + 1}`}
              data-tooltip="Remove subtask"
              disabled={titles.length === 1}
              onClick={() => setTitles(titles.filter((_, j) => j !== i))}
              className="btn-icon size-6"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ol>
      <Row>
        {titles.length < MAX_SUBTASK_TITLES ? (
          <button type="button" onClick={() => addAfter(titles.length - 1)} className="btn-ghost h-6 px-1.5 text-xs">
            <Plus className="size-3.5" aria-hidden />
            Add subtask
          </button>
        ) : (
          <span className="text-xs text-zinc-500">Up to {MAX_SUBTASK_TITLES} subtasks</span>
        )}
        <span className="flex items-center gap-1 text-sm">
          <Word>assigned to</Word>
          <PersonSelect
            id={`${prefix}-subtask-assignee`}
            label="Assign the subtasks to"
            value={action.assignee ?? null}
            ctx={ctx}
            allowNone="Nobody"
            onChange={(v) => onChange(v ? { ...action, assignee: v } : omit(action, "assignee"))}
          />
        </span>
      </Row>
    </div>
  );
}

// Slack / webhook fields. Saved URLs and secrets are never sent to the browser: the action only carries
// a redacted hint (host + last 4 characters, or "saved" for a secret). Typing a value sends it once in
// plain text; the database stores it out of reach of clients and writes back a fresh hint.
function IntegrationFields({
  projectId,
  prefix,
  action,
  ctx,
  onChange,
}: {
  projectId: string;
  prefix: string;
  action: RuleAction;
  ctx: RuleContext;
  onChange: (next: RuleAction) => void;
}) {
  const slack = action.type === "send_slack";
  const projectDefault = slack ? ctx.integrations?.slackWebhook : ctx.integrations?.webhook;
  const useProject = action.use_project_webhook === true;
  const settingsLink = (
    <Link href={`/projects/${projectId}/settings/integrations`} className="text-accent-700 hover:underline">
      Settings → Integrations
    </Link>
  );

  return (
    <div className="space-y-2">
      {slack ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${prefix}-message`} className={labelClass}>
            Slack message
          </label>
          <textarea
            id={`${prefix}-message`}
            rows={2}
            maxLength={4000}
            placeholder="{task} moved to {section} in {project}"
            value={typeof action.message === "string" ? action.message : ""}
            onChange={(e) => onChange({ ...action, message: e.currentTarget.value })}
            className={`${inputClass} w-full`}
          />
          <p className="text-xs text-zinc-500">
            Tokens work here too, plus <span className="font-mono">{"{task_link}"}</span> (the task’s title linked to it
            in the app; people still sign in to open it). Task details are escaped, so a title can’t ping @channel.
          </p>
          <label htmlFor={`${prefix}-format`} className={`${labelClass} mt-1`}>
            Message style
          </label>
          <SmartPicker
            id={`${prefix}-format`}
            label="Message style"
            value={action.format === "blocks" ? "blocks" : "text"}
            options={SLACK_FORMATS.map((f) => ({ value: f.value, label: f.label }))}
            onChange={(v) => {
              const next = { ...action };
              if (v === "blocks") next.format = "blocks";
              else delete next.format;
              onChange(next);
            }}
            className="w-full max-w-xs"
          />
          {action.format === "blocks" ? (
            <p className="text-xs text-zinc-500">
              Your message, then a card with the task title (linked), project, assignee, due date, status, and an Open
              task button. The message is also sent as plain text for notifications.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-zinc-500">
          POSTs a JSON summary of the task (event, rule, project, task id/title/Req #/section/assignee/due date, and a
          link) to an https:// address.
        </p>
      )}

      {projectDefault || useProject ? (
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={useProject}
            onChange={(e) => {
              const next = { ...action };
              if (e.currentTarget.checked) next.use_project_webhook = true;
              else delete next.use_project_webhook;
              onChange(next);
            }}
          />
          Use the project {slack ? "Slack webhook" : "webhook"} ({projectDefault ?? <>not set — add it in {settingsLink}</>})
        </label>
      ) : null}

      {useProject ? null : (
        <>
          <SecretField
            id={`${prefix}-url`}
            label={slack ? "Slack incoming webhook URL" : "Webhook URL (https://)"}
            placeholder={slack ? "https://hooks.slack.com/services/…" : "https://example.com/hooks/alhc"}
            action={action}
            plainKey={slack ? "webhook_url" : "url"}
            savedHint={typeof action[slack ? "webhook_hint" : "url_hint"] === "string" ? String(action[slack ? "webhook_hint" : "url_hint"]) : null}
            validate={(v) => (isAllowedWebhookUrl(v) ? null : WEBHOOK_URL_ERROR)}
            onChange={onChange}
          />
          {!projectDefault && !action[slack ? "webhook_ref" : "url_ref"] && !action[slack ? "webhook_url" : "url"] ? (
            <p className="text-xs text-zinc-500">
              Paste a URL here, or add a project default in {settingsLink}. Without either, runs fail with a clear error.
            </p>
          ) : null}
          {projectDefault ? (
            <p className="text-xs text-zinc-500">Leave the URL empty to use the project default.</p>
          ) : null}
          {slack ? null : (
            <>
              <SecretField
                id={`${prefix}-secret`}
                label="Shared secret (optional)"
                placeholder="Sent as a header, never in the body"
                action={action}
                plainKey="secret"
                savedHint={action.secret_set === true ? "Saved secret" : null}
                validate={(v) => (v.length > 500 ? "The shared secret is limited to 500 characters" : null)}
                onChange={onChange}
              />
              <div className="flex flex-col gap-1">
                <label htmlFor={`${prefix}-header`} className={labelClass}>
                  Secret header name
                </label>
                <input
                  id={`${prefix}-header`}
                  value={typeof action.secret_header === "string" ? action.secret_header : ""}
                  placeholder={DEFAULT_SECRET_HEADER}
                  maxLength={100}
                  aria-invalid={
                    typeof action.secret_header === "string" && action.secret_header !== "" && !isAllowedHeaderName(action.secret_header)
                  }
                  aria-describedby={`${prefix}-header-help`}
                  onChange={(e) => {
                    const next = { ...action };
                    if (e.currentTarget.value) next.secret_header = e.currentTarget.value;
                    else delete next.secret_header;
                    onChange(next);
                  }}
                  className={`${inputClass} w-full max-w-xs`}
                />
                <p id={`${prefix}-header-help`} className="text-xs text-zinc-500">
                  Defaults to {DEFAULT_SECRET_HEADER}. Use “Authorization” with a secret like “Bearer …” for token auth.
                </p>
              </div>
              <SigningSecretField action={action} onChange={onChange} />
            </>
          )}
        </>
      )}
    </div>
  );
}

// A write-only value: shows the saved hint with Replace / Remove, or a password-style input.
function SecretField({
  id,
  label,
  placeholder,
  action,
  plainKey,
  savedHint,
  validate,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  action: RuleAction;
  plainKey: string;
  savedHint: string | null;
  validate: (value: string) => string | null;
  onChange: (next: RuleAction) => void;
}) {
  const helpId = useId();
  const typed = typeof action[plainKey] === "string" ? (action[plainKey] as string) : undefined;
  const [mode, setMode] = useState<"saved" | "editing" | "removed">(
    savedHint ? (typed === "" ? "removed" : typed ? "editing" : "saved") : "editing",
  );
  const error = typed ? validate(typed.trim()) : null;

  function setTyped(value: string | undefined) {
    const next = { ...action };
    if (value === undefined) delete next[plainKey];
    else next[plainKey] = value;
    onChange(next);
  }

  if (mode === "saved" && savedHint) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={labelClass}>{label}</span>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700">{savedHint}</span>
        <button
          type="button"
          onClick={() => setMode("editing")}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
        >
          Replace
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("removed");
            setTyped("");
          }}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
        >
          Remove
        </button>
      </div>
    );
  }
  if (mode === "removed") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={labelClass}>{label}</span>
        <span className="text-xs text-zinc-500">Removed when you save.</span>
        <button
          type="button"
          onClick={() => {
            setMode("saved");
            const next = { ...action };
            delete next[plainKey];
            onChange(next);
          }}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
        >
          Undo
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={typed ?? ""}
          maxLength={2000}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? helpId : undefined}
          onChange={(e) => setTyped(e.currentTarget.value || undefined)}
          className={`${inputClass} min-w-0 flex-1`}
        />
        {savedHint ? (
          <button
            type="button"
            onClick={() => {
              setMode("saved");
              const next = { ...action };
              delete next[plainKey];
              onChange(next);
            }}
            className="rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
          >
            Keep saved ({savedHint})
          </button>
        ) : null}
      </div>
      {error ? (
        <p id={helpId} className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// This action's own signing secret (only for its own URL; the project URL uses the project's secret).
// The app generates it on save and shows it once; afterwards only "saved" is known.
function SigningSecretField({ action, onChange }: { action: RuleAction; onChange: (next: RuleAction) => void }) {
  const saved = action.signing_set === true;
  const generating = action.generate_signing_secret === true;
  const removing = action.signing_secret === "";
  const ownUrl = Boolean(action.url_ref) || (typeof action.url === "string" && action.url.trim() !== "");
  const buttonClass = "rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100";

  function update(patch: { generate?: boolean; remove?: boolean }) {
    const next = { ...action };
    delete next.generate_signing_secret;
    delete next.signing_secret;
    if (patch.generate) next.generate_signing_secret = true;
    if (patch.remove) next.signing_secret = "";
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-1">
      <span className={labelClass}>Request signing (optional)</span>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {generating ? (
          <>
            <span className="text-xs text-zinc-600">A new signing secret is generated when you save, and shown once.</span>
            <button type="button" onClick={() => update({})} className={buttonClass}>
              Undo
            </button>
          </>
        ) : removing ? (
          <>
            <span className="text-xs text-zinc-500">Signing is removed when you save.</span>
            <button type="button" onClick={() => update({})} className={buttonClass}>
              Undo
            </button>
          </>
        ) : saved ? (
          <>
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700">Signing secret saved</span>
            <button type="button" onClick={() => update({ generate: true })} className={buttonClass}>
              Regenerate
            </button>
            <button type="button" onClick={() => update({ remove: true })} className={buttonClass}>
              Remove
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={!ownUrl}
            onClick={() => update({ generate: true })}
            className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Generate a signing secret
          </button>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        {ownUrl || saved
          ? `Adds ${SIGNATURE_HEADER} (an HMAC of the timestamp and body) so the receiver can verify each request.`
          : "Add this action’s own URL to sign it; the project webhook uses the project’s signing secret."}
      </p>
    </div>
  );
}
