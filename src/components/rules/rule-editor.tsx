"use client";

// The rule builder's building blocks (trigger settings, a condition, an action's settings, and the
// one-time signing-secret reveal), laid out by the rule canvas (rule-canvas.tsx).

import { FolderClosed, Plus, X } from "lucide-react";
import Link from "next/link";
import { useId, useState, useSyncExternalStore } from "react";
import type { RevealedSigningSecret } from "@/lib/actions";
import { dayLabel, isoDate, weekdayOf } from "@/lib/date-input";
import { numberPrefixOf, type FieldDef } from "@/lib/fields";
import {
  DEFAULT_SECRET_HEADER,
  SIGNATURE_HEADER,
  SLACK_FORMATS,
  WEBHOOK_URL_ERROR,
  isAllowedHeaderName,
  isAllowedWebhookUrl,
} from "@/lib/integrations-shared";
import { ParamSlot, useParamSlot } from "@/components/param-slot";
import { SmartPicker } from "@/components/smart-picker";
import {
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  ASSIGN_MODES,
  CREATE_LINKS,
  DESCRIPTION_MODES,
  LIST_OPS,
  UNBLOCK_KINDS,
  CONDITIONS,
  DATE_CHANGES,
  DATE_OPS,
  DATE_SUBJECTS,
  DUE_FROM,
  EMAIL_RECIPIENTS,
  EMAIL_TEMPLATES,
  OFFSET_UNITS,
  RANGE_OPS,
  SCHEDULE_FREQUENCIES,
  TASK_KIND_OPTIONS,
  TASK_SOURCES,
  compareOpsFor,
  triggerOffset,
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
  MISSING_INPUT,
  PeoplePicker,
  PersonSelect,
  RuleDateInput,
  SectionSelect,
  inputClass,
  labelClass,
  needsUpdate,
  tagsHidden,
  optionDot,
  personCompareVerb,
  ordinal,
  ruleFields,
  scheduleWeekdays,
  sectionOptions,
  sideOptions,
  tagOptions,
  timeLabel,
  valueOr,
  WithSymbol,
  numberValueLabel,
  type RuleContext,
} from "./rule-shared";
import { PlaceholderInput } from "./placeholder-input";
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
    case "set_start_date":
      return { type, mode: "relative", days: 0, from: "today" };
    case "create_subtasks":
      return { type, titles: [""] };
    case "set_title":
      return { type, title: "{task}" };
    case "create_task":
      return { type, kind: "task", title: "Follow up on {{task.name}}" };
    case "set_description":
      return { type, text: "" };
    case "remove_followers":
      return { type, people: [] };
    default:
      return { type };
  }
}

// A new condition of this type (the database needs a number of days for Due within).
export function conditionDefaultsFor(type: ConditionType): RuleCondition {
  switch (type) {
    case "due_within":
    case "start_within":
      return { type, days: 3 };
    case "date_compare":
      return { type, date: "due", op: "before" };
    case "approval_status_is":
      return { type, statuses: ["approved"] };
    case "person_compare":
      // "The assignee is the creator" — the most asked-for comparison.
      return { type, left: "assignee", op: "is", people: ["creator"] };
    default:
      return { type };
  }
}
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
  // Inside a rule step's ParamSlot: highlighted while the number is still missing (rule-params.ts).
  const slot = useParamSlot<number | null>(onCommit);
  const missing = slot.missing && value === null && !draft;
  return (
    <input
      id={id}
      type="number"
      aria-invalid={missing || undefined}
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
      className={`${inputClass} ${className} ${missing ? MISSING_INPUT : ""}`}
    />
  );
}

// A short text box (Name contains, an email address). Inside a ParamSlot it's highlighted while empty.
function TextBox({
  id,
  label,
  value,
  onChange,
  placeholder,
  maxLength = 1000,
  type = "text",
  className = "w-40",
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  type?: "text" | "email";
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
      maxLength={maxLength}
      onChange={(e) => onChange(e.currentTarget.value)}
      className={`${inputClass} ${className} ${missing ? MISSING_INPUT : ""}`}
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

// Times of day in quarter hours ("9:30 AM"), searchable by "9:30" or "21:30".
const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  const clock = `${h}:${String(m).padStart(2, "0")}`;
  return {
    value: `${h}:${m}`,
    label: timeLabel(h, m),
    keywords: [clock, `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, ...(i === 0 ? ["midnight"] : i === 48 ? ["noon"] : [])],
  };
});

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
        <ParamSlot param="section_id">
          <SmartPicker
            id={`${prefix}-trigger-section`}
            label="Section"
            value={str(triggerConfig.section_id)}
            options={[
              {
                value: "",
                label: "any section",
                description: "Whichever section it moves to",
                ...(ctx.v3 === false ? { disabled: true, disabledReason: "Needs this release’s database update" } : {}),
              },
              ...sectionOptions(ctx),
            ]}
            onChange={(v) => setConfig({ section_id: v })}
            variant="chip"
            // A new rule starts without a section: before V3's database that has to be picked.
            placeholder="choose section"
            renderValue={triggerConfig.section_id || ctx.v3 !== false ? valueOr(triggerConfig.section_id ? "a removed section" : "any section") : undefined}
            emptyText={ctx.sections.length ? "No section matches" : "This project has no sections yet"}
          />
  
        </ParamSlot>      );
    case "section_left":
      return (
        <ParamSlot param="section_id">
          <SectionSelect
            id={`${prefix}-trigger-section-left`}
            label="Section it leaves"
            value={triggerConfig.section_id}
            ctx={ctx}
            onChange={(v) => setConfig({ section_id: v })}
          />
  
        </ParamSlot>      );
    case "task_unblocked": {
      const kinds = Array.isArray(triggerConfig.kinds) ? triggerConfig.kinds.filter((v): v is string => typeof v === "string") : [];
      return (
        <ParamSlot param="kinds">
          <SmartPicker
            multiple
            id={`${prefix}-trigger-kinds`}
            label="Which dependencies"
            value={kinds}
            options={UNBLOCK_KINDS.map((k) => ({ ...k }))}
            onChange={(next) => setConfig({ kinds: next.length ? next : undefined })}
            variant="chip"
            placeholder="any dependency"
            renderValue={(chosen) => (chosen.length ? <span>by {chosen.map((c) => c.label).join(" or ")} dependencies</span> : undefined)}
          />
  
        </ParamSlot>      );
    }
    case "task_type_changed":
      return (
        <ParamSlot param="kind">
          <SmartPicker
            id={`${prefix}-trigger-kind`}
            label="Changes to"
            value={str(triggerConfig.kind)}
            options={[{ value: "", label: "to any type" }, ...TASK_KIND_OPTIONS.map((k) => ({ value: k.value, label: `to ${k.label.toLowerCase()}` }))]}
            onChange={(v) => setConfig({ kind: v })}
            variant="chip"
            renderValue={valueOr("to any type")}
          />
  
        </ParamSlot>      );
    case "field_changed":
      return (
        <Row>
          <ParamSlot param="field_id">
            <FieldSelect
              id={`${prefix}-trigger-field`}
              label="Field"
              value={triggerConfig.field_id}
              fields={fields.filter((f) => !f.boundToSections)}
              onChange={(v) => setConfig({ field_id: v, option_id: undefined })}
            />
  
          </ParamSlot>          {triggerField && triggerField.options.length ? (
            <ParamSlot param="option_id">
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
  
            </ParamSlot>          ) : null}
        </Row>
      );
    case "due_approaching":
    case "start_approaching":
    case "task_overdue":
    case "start_reached":
      return <OffsetFields prefix={prefix} triggerType={triggerType} config={triggerConfig} ctx={ctx} onChange={onChange} />;
    case "due_date_changed":
    case "start_date_changed":
      return (
        <ParamSlot param="change">
          <SmartPicker
            id={`${prefix}-trigger-change`}
            label="Which changes"
            value={str(triggerConfig.change) || "any"}
            options={DATE_CHANGES.map((d) => ({
              ...d,
              ...(d.value !== "any" && ctx.v3 === false ? { disabled: true, disabledReason: "Needs this release’s database update" } : {}),
            }))}
            onChange={(v) => setConfig({ change: v === "any" ? undefined : v })}
            variant="chip"
          />
  
        </ParamSlot>      );
    case "approval_decided": {
      const statuses = Array.isArray(triggerConfig.statuses)
        ? triggerConfig.statuses.filter((v): v is string => typeof v === "string")
        : [];
      return (
        <ParamSlot param="statuses">
          <SmartPicker
            multiple
            label="Decisions"
            value={statuses}
            options={APPROVAL_DECISIONS.map((d) => ({ value: d.value, label: d.label }))}
            onChange={(next) => setConfig({ statuses: next.length ? next : undefined })}
            variant="chip"
            placeholder="any decision"
            renderValue={(chosen) => (chosen.length ? <span>as {chosen.map((c) => c.label.toLowerCase()).join(" or ")}</span> : undefined)}
          />
  
        </ParamSlot>      );
    }
    case "inbound_received":
      return (
        <ParamSlot param="endpoint_id">
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
  
        </ParamSlot>      );
    case "form_submitted":
      return (
        <ParamSlot param="form_id">
          <SmartPicker
            label="Form"
            value={typeof triggerConfig.form_id === "string" ? triggerConfig.form_id : ""}
            options={[{ value: "", label: "Any form" }, ...ctx.forms.map((f) => ({ value: f.id, label: f.title }))]}
            onChange={(v) => setConfig({ form_id: v })}
            variant="chip"
            renderValue={valueOr(triggerConfig.form_id ? "a removed form" : "Any form")}
            emptyText="Add a form to this project first"
          />
  
        </ParamSlot>      );
    case "tag_added":
      return (
        <ParamSlot param="tag_id">
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
  
        </ParamSlot>      );
    case "scheduled":
      return <ScheduleFields prefix={prefix} config={triggerConfig} ctx={ctx} setConfig={setConfig} />;
    case "follower_added":
      return (
        <ParamSlot param="people">
          <PeoplePicker
            idPrefix={`${prefix}-trigger-people`}
            label="Who starts following"
            value={triggerConfig.people}
            ctx={ctx}
            placeholder="anyone"
            onChange={(v) => setConfig({ people: v.length ? v : undefined })}
          />
  
        </ParamSlot>      );
    default:
      return null;
  }
}

// How long before / after a date trigger fires: "[2] [days] before it's due", "[4] [hours] after it
// starts". Days keep the older { days } shape (so a rule saved before Automations V3 stays the same);
// hours and weeks write { amount, unit } (rule_trigger_offset).
function OffsetFields({
  prefix,
  triggerType,
  config,
  ctx,
  onChange,
}: {
  prefix: string;
  triggerType: TriggerType;
  config: Record<string, Json>;
  ctx: RuleContext;
  onChange: (config: Record<string, Json>) => void;
}) {
  const startArrives = triggerType === "start_reached";
  const overdue = triggerType === "task_overdue";
  const { amount, unit } = triggerOffset(config, startArrives ? 0 : 1);
  const spec = OFFSET_UNITS.find((u) => u.value === unit) ?? OFFSET_UNITS[1];
  // Days: legacy limits (0–30; overdue at least 1). Hours and weeks: rule_offset_problem's.
  const min = unit === "days" ? (overdue ? 1 : 0) : spec.min;
  const max = unit === "days" ? 30 : spec.max;
  const shown = unit === "days" && overdue ? Math.max(amount, 1) : amount;
  const base = { ...config };
  delete base.days;
  delete base.amount;
  delete base.unit;
  function write(nextAmount: number, nextUnit: string) {
    if (nextUnit === "days") onChange({ ...base, days: nextAmount });
    else onChange({ ...base, amount: nextAmount, unit: nextUnit });
  }
  const tail =
    triggerType === "due_approaching"
      ? "before it’s due"
      : triggerType === "start_approaching"
        ? "before it starts"
        : overdue
          ? unit === "days" && shown === 1
            ? "after it’s due (when it becomes overdue)"
            : "after it’s due"
          : shown === 0
            ? "after it starts (on the start date)"
            : "after it starts";
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-sm text-zinc-700">
      <ParamSlot param="days">
        <NumberBox
          id={`${prefix}-trigger-offset`}
          label={`How many ${spec.label}`}
          value={shown}
          min={min}
          max={max}
          onCommit={(n) => {
            if (n !== null) write(Math.min(Math.max(n, min), max), unit);
          }}
        />
  
      </ParamSlot>      <SmartPicker
        id={`${prefix}-trigger-unit`}
        label="Hours, days, or weeks"
        value={unit}
        options={OFFSET_UNITS.map((u) => ({
          value: u.value,
          label: shown === 1 ? u.one : u.label,
          description:
            u.value === "hours" ? "From the time (a date without a time counts from the end of the day)" : u.value === "days" ? "Whole days in the rule’s time zone" : "7 days each",
          ...(u.value !== "days" && ctx.v3 === false ? { disabled: true, disabledReason: "Needs this release’s database update" } : {}),
        }))}
        onChange={(v) => {
          if (v === unit) return;
          const s2 = OFFSET_UNITS.find((u) => u.value === v) ?? OFFSET_UNITS[1];
          const lo = v === "days" ? (overdue ? 1 : 0) : s2.min;
          const hi = v === "days" ? 30 : s2.max;
          write(Math.min(Math.max(shown, lo), hi), v);
        }}
        variant="chip"
      />
      {tail}
    </span>
  );
}

// On a schedule: how often (every N days or weeks), the weekdays or day of the month, and the time (in
// the rule's time zone, which the canvas saves with the rule). Every N counts from `anchor` (today when
// it's set).
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
  const today = useLocalToday();
  const frequency = str(config.frequency);
  const workWeek = normalizeWorkWeek(ctx.workWeek ?? DEFAULT_WORK_WEEK);
  const every = Math.max(wholeNumber(config.interval) ?? 1, 1);
  const hour = wholeNumber(config.hour) ?? 9;
  const minute = wholeNumber(config.minute) ?? 0;
  const v3 = ctx.v3 !== false;
  const needs = { disabled: true, disabledReason: "Needs this release’s database update" } as const;
  const repeats = frequency === "daily" || frequency === "weekly";
  const unitWord = frequency === "weekly" ? (every === 1 ? "week" : "weeks") : every === 1 ? "day" : "days";
  return (
    <Row>
      <ParamSlot param="frequency">
        <SmartPicker
          id={`${prefix}-schedule-frequency`}
          label="How often"
          value={frequency || null}
          options={SCHEDULE_FREQUENCIES.map((f) => ({ ...f }))}
          onChange={(v) =>
            setConfig({
              frequency: v,
              // Weekly starts on the first workday and monthly on the 1st; other frequencies drop them.
              // (several weekdays with this release's database; one weekday before it).
              weekdays: v === "weekly" && v3 ? (frequency === "weekly" ? scheduleWeekdays(config) : [workWeek[0]]) : undefined,
              weekday: v === "weekly" && !v3 ? (wholeNumber(config.weekday) ?? workWeek[0]) : undefined,
              month_day: v === "monthly" ? (wholeNumber(config.month_day) ?? 1) : undefined,
              interval: undefined,
              anchor: undefined,
            })
          }
          variant="chip"
          placeholder="choose how often"
        />
  
      </ParamSlot>      {repeats ? (
        <span className="flex items-center gap-1 text-sm text-zinc-700" data-tooltip={!v3 ? "Every few days or weeks needs this release’s database update" : undefined}>
          <Word>every</Word>
          <NumberBox
            id={`${prefix}-schedule-interval`}
            label={`Every how many ${frequency === "weekly" ? "weeks" : "days"}`}
            value={every}
            min={1}
            max={frequency === "weekly" ? 52 : 365}
            onCommit={(n) => {
              if (n === null || !v3) return;
              const next = Math.min(Math.max(n, 1), frequency === "weekly" ? 52 : 365);
              setConfig({ interval: next === 1 ? undefined : next, anchor: next === 1 ? undefined : str(config.anchor) || today || undefined });
            }}
          />
          <Word>{unitWord}</Word>
        </span>
      ) : null}
      {frequency === "weekly" ? (
        v3 ? (
          <SmartPicker
            multiple
            id={`${prefix}-schedule-weekdays`}
            label="Days of the week"
            value={scheduleWeekdays(config).map(String)}
            options={WEEKDAY_OPTIONS}
            onChange={(v) => {
              const days = v.map(Number).filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
              if (days.length) setConfig({ weekdays: days, weekday: undefined });
            }}
            variant="chip"
            renderValue={(chosen) => <span>on {chosen.length === 7 ? "every day" : chosen.map((c) => c.label).join(", ") || "Sunday"}</span>}
          />
        ) : (
          <SmartPicker
            id={`${prefix}-schedule-weekday`}
            label="Day of the week"
            value={String(wholeNumber(config.weekday) ?? 0)}
            options={WEEKDAY_OPTIONS}
            onChange={(v) => setConfig({ weekday: Number(v) })}
            variant="chip"
            renderValue={(chosen) => <span>on {chosen[0]?.label ?? "Sunday"}</span>}
          />
        )
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
          id={`${prefix}-schedule-time`}
          label="Time of day"
          value={`${hour}:${minute}`}
          options={TIME_OPTIONS.map((t) => (!v3 && !t.value.endsWith(":0") ? { ...t, ...needs } : t))}
          onChange={(v) => {
            const [h, m] = v.split(":").map(Number);
            setConfig({ hour: h, minute: m ? m : undefined });
          }}
          variant="chip"
          searchable
          renderValue={() => <span>at {timeLabel(hour, minute)}</span>}
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
        options={vocabOptions(CONDITIONS, { disabled: needsUpdate(ctx), hidden: tagsHidden(ctx, [condition.type]) })}
        onChange={(v) => onChange(conditionDefaultsFor(v as ConditionType))}
        variant="chip"
        searchable
      />
      <V2ConditionFields prefix={prefix} condition={condition} ctx={ctx} onChange={onChange} />
      {condition.type === "section_is" || condition.type === "section_is_not" ? (
        <ParamSlot param="section_id">
          <SectionSelect
            id={`${prefix}-section`}
            label="Section"
            value={condition.section_id}
            ctx={ctx}
            onChange={(v) => onChange({ ...condition, section_id: v })}
          />
        </ParamSlot>
      ) : null}
      {condition.type === "field_equals" || condition.type === "field_is_set" || condition.type === "field_is_empty" ? (
        <ParamSlot param="field_id">
          <FieldSelect
            id={`${prefix}-field`}
            label="Field"
            value={condition.field_id}
            fields={fields}
            onChange={(v) => onChange({ type: condition.type, field_id: v })}
          />
        </ParamSlot>
      ) : null}
      {condition.type === "field_equals" ? (
        <ParamSlot param="value">
          <FieldValueInput
            id={`${prefix}-value`}
            field={fields.find((f) => f.id === condition.field_id)}
            value={condition.value}
            ctx={ctx}
            onChange={(v) => onChange({ ...condition, value: v })}
          />
        </ParamSlot>
      ) : null}
      {condition.type === "source_is" ? (
        <ParamSlot param="source">
          <SmartPicker
            label="Source"
            value={typeof condition.source === "string" ? condition.source : null}
            options={TASK_SOURCES.map((x) => ({ ...x }))}
            onChange={(v) => onChange(v === condition.source ? condition : { type: condition.type, source: v })}
            variant="chip"
            placeholder="choose source"
          />
        </ParamSlot>
      ) : null}
      {condition.type === "source_is" && condition.source === "form" ? (
        // Automations V3: which form (any form when none is picked).
        <ParamSlot param="form_id">
          <SmartPicker
            id={`${prefix}-source-form`}
            label="Which form"
            value={str(condition.form_id)}
            options={[
              { value: "", label: "any form", description: "Whichever of this project's forms made the task" },
              ...ctx.forms.map((f) => ({ value: f.id, label: f.title, ...(ctx.v3 === false ? { disabled: true, disabledReason: "Needs this release’s database update" } : {}) })),
            ]}
            onChange={(v) => onChange(v ? { ...condition, form_id: v } : omit(condition, "form_id"))}
            variant="chip"
            renderValue={valueOr(condition.form_id ? "a removed form" : "any form")}
            emptyText="Add a form to this project first"
          />
        </ParamSlot>
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
          <ParamSlot param="field_id">
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
          </ParamSlot>
          {field ? (
            <ParamSlot param="op">
              <SmartPicker
                id={`${prefix}-compare-op`}
                label="Comparison"
                value={str(condition.op) || null}
                options={ops.map((o) => ({ value: o.value, label: o.label }))}
                onChange={(v) => {
                  // A list of options and a single value don't carry over into each other.
                  const list = LIST_OPS.has(v) !== LIST_OPS.has(str(condition.op));
                  const base = list ? omit(condition, "value", "to") : RANGE_OPS.has(v) ? condition : omit(condition, "to");
                  onChange({ ...base, op: v });
                }}
                variant="chip"
                placeholder="choose comparison"
              />
            </ParamSlot>
          ) : null}
          {field && LIST_OPS.has(str(condition.op)) ? (
            <ParamSlot param="value">
              <SmartPicker
                multiple
                id={`${prefix}-compare-values`}
                label={`${field.name} values`}
                value={Array.isArray(condition.value) ? condition.value.filter((v): v is string => typeof v === "string") : []}
                options={
                  field.boundToSections
                    ? sectionOptions(ctx)
                    : field.options.map((o) => ({ value: o.id, label: o.name, icon: optionDot(o.color) }))
                }
                onChange={(v) => onChange(v.length ? { ...condition, value: v } : omit(condition, "value"))}
                variant="chip"
                placeholder="choose options"
              />
            </ParamSlot>
          ) : field ? (
            <ParamSlot param="value">
              <CompareValueInput
                id={`${prefix}-compare-value`}
                field={field}
                value={condition.value}
                ctx={ctx}
                onChange={(v) => onChange(v === null ? omit(condition, "value") : { ...condition, value: v })}
              />
            </ParamSlot>
          ) : null}
          {field && RANGE_OPS.has(str(condition.op)) ? (
            <>
              <Word>and</Word>
              <ParamSlot param="to">
                <CompareValueInput
                  id={`${prefix}-compare-to`}
                  field={field}
                  value={condition.to}
                  ctx={ctx}
                  onChange={(v) => onChange(v === null ? omit(condition, "to") : { ...condition, to: v })}
                />
              </ParamSlot>
            </>
          ) : null}
        </>
      );
    }
    case "has_tag":
    case "lacks_tag":
      return (
        <ParamSlot param="tag_id">
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
        </ParamSlot>
      );
    case "assignee_is":
    case "assignee_is_not":
    case "creator_is":
      return (
        <ParamSlot param="people">
          <PeoplePicker
            idPrefix={`${prefix}-people`}
            label={condition.type === "creator_is" ? "Created by" : "Assignee"}
            value={condition.people}
            ctx={ctx}
            onChange={(v) => onChange(v.length ? { ...condition, people: v } : omit(condition, "people"))}
          />
        </ParamSlot>
      );
    case "due_within":
    case "start_within": {
      const days = wholeNumber(condition.days);
      return (
        <span className="flex items-center gap-1.5 text-sm text-zinc-700">
          <ParamSlot param="days">
            <NumberBox
              id={`${prefix}-days`}
              label={`${condition.type === "due_within" ? "Due" : "Starts"} within this many days`}
              value={days}
              min={0}
              max={365}
              placeholder="3"
              onCommit={(n) => onChange(n === null ? omit(condition, "days") : { ...condition, days: n })}
            />
          </ParamSlot>
          {days === 1 ? "day" : "days"}
        </span>
      );
    }
    case "date_compare": {
      const range = RANGE_OPS.has(str(condition.op));
      return (
        <>
          <ParamSlot param="date">
            <SmartPicker
              id={`${prefix}-date-subject`}
              label="Which date"
              value={str(condition.date) || null}
              options={DATE_SUBJECTS.map((d) => ({ ...d }))}
              onChange={(v) => onChange({ ...condition, date: v })}
              variant="chip"
              placeholder="choose which date"
            />
          </ParamSlot>
          <ParamSlot param="op">
            <SmartPicker
              id={`${prefix}-date-op`}
              label="Comparison"
              value={str(condition.op) || null}
              options={DATE_OPS.map((o) => ({ ...o }))}
              onChange={(v) => onChange(RANGE_OPS.has(v) ? { ...condition, op: v } : { ...omit(condition, "to"), op: v })}
              variant="chip"
              placeholder="choose comparison"
            />
          </ParamSlot>
          <ParamSlot param="value">
            <RuleDateInput
              id={`${prefix}-date-value`}
              label={range ? "From" : "Date"}
              value={condition.value}
              onChange={(v) => onChange(v ? { ...condition, value: v } : omit(condition, "value"))}
            />
          </ParamSlot>
          {range ? (
            <>
              <Word>and</Word>
              <ParamSlot param="to">
                <RuleDateInput
                  id={`${prefix}-date-to`}
                  label="To"
                  value={condition.to}
                  onChange={(v) => onChange(v ? { ...condition, to: v } : omit(condition, "to"))}
                />
              </ParamSlot>
            </>
          ) : null}
        </>
      );
    }
    case "section_is_one_of":
    case "section_is_none_of": {
      const ids = Array.isArray(condition.section_ids) ? condition.section_ids.filter((v): v is string => typeof v === "string") : [];
      return (
        <ParamSlot param="section_ids">
          <SmartPicker
            multiple
            id={`${prefix}-sections`}
            label="Sections"
            value={ids}
            options={sectionOptions(ctx)}
            onChange={(v) => onChange(v.length ? { ...condition, section_ids: v } : omit(condition, "section_ids"))}
            variant="chip"
            placeholder="choose sections"
            emptyText={ctx.sections.length ? "No section matches" : "This project has no sections yet"}
          />
        </ParamSlot>
      );
    }
    case "approval_status_is": {
      const statuses = Array.isArray(condition.statuses) ? condition.statuses.filter((v): v is string => typeof v === "string") : [];
      return (
        <ParamSlot param="statuses">
          <SmartPicker
            multiple
            id={`${prefix}-approval-statuses`}
            label="Approval statuses"
            value={statuses}
            options={APPROVAL_STATUSES.map((x) => ({ ...x }))}
            onChange={(v) => onChange(v.length ? { ...condition, statuses: v } : omit(condition, "statuses"))}
            variant="chip"
            placeholder="choose statuses"
          />
        </ParamSlot>
      );
    }
    case "task_type_is":
    case "task_type_is_not":
      return (
        <ParamSlot param="kind">
          <SmartPicker
            id={`${prefix}-kind`}
            label="Task type"
            value={str(condition.kind) || null}
            options={TASK_KIND_OPTIONS.map((k) => ({ ...k }))}
            onChange={(v) => onChange({ ...condition, kind: v })}
            variant="chip"
            placeholder="choose type"
          />
        </ParamSlot>
      );
    case "person_compare":
      return (
        <>
          <ParamSlot param="left">
            <SmartPicker
              id={`${prefix}-side`}
              label="Who to compare"
              value={str(condition.left) || null}
              options={sideOptions(ctx)}
              onChange={(v) => onChange({ ...condition, left: v })}
              variant="chip"
              placeholder="choose who"
            />
          </ParamSlot>
          <ParamSlot param="op">
            <SmartPicker
              id={`${prefix}-op`}
              label="Is or isn't"
              value={condition.op === "is_not" || condition.op === "is" ? condition.op : null}
              options={[
                { value: "is", label: personCompareVerb(condition.left, false), description: "One of the people you pick" },
                { value: "is_not", label: personCompareVerb(condition.left, true), description: "None of the people you pick" },
              ]}
              onChange={(v) => onChange({ ...condition, op: v })}
              variant="chip"
              placeholder="choose is or isn’t"
            />
          </ParamSlot>
          <ParamSlot param="people">
            <PeoplePicker
              idPrefix={`${prefix}-compare-people`}
              label="Compared with"
              value={condition.people}
              ctx={ctx}
              onChange={(v) => onChange(v.length ? { ...condition, people: v } : omit(condition, "people"))}
            />
          </ParamSlot>
        </>
      );
    case "title_contains":
      return (
        <ParamSlot param="text">
          <TextBox
            id={`${prefix}-text`}
            label="Text in the task name"
            placeholder="video"
            value={str(condition.text)}
            maxLength={200}
            onChange={(v) => onChange({ ...condition, text: v })}
          />
        </ParamSlot>
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
          <ParamSlot param="text">
            <TextBox
              id={`${prefix}-text`}
              label="Text in the form answer"
              placeholder="print"
              value={str(condition.text)}
              maxLength={200}
              onChange={(v) => onChange({ ...condition, text: v })}
            />
          </ParamSlot>
          <ParamSlot param="question_id">
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
          </ParamSlot>
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
    case "number": {
      const symbol = numberPrefixOf(field);
      return (
        <WithSymbol symbol={symbol}>
          <NumberBox
            id={id}
            label={numberValueLabel(label, symbol)}
            value={typeof value === "number" ? value : null}
            whole={false}
            className="w-28"
            onCommit={onChange}
          />
        </WithSymbol>
      );
    }
    case "date":
      return <RuleDateInput id={id} label={label} value={value} onChange={onChange} />;
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
        <TextBox id={id} label={label} value={str(value)} onChange={(v) => onChange(v === "" ? null : v)} />
      );
  }
}

// Actions whose settings fit on the sentence line (part = inline). The rest draw below it.
export const INLINE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "move_section", "set_field", "set_assignee", "add_followers", "remove_followers", "request_approval", "delay",
  // Automations V2 (Mark complete / incomplete have no settings at all).
  "complete_task", "reopen_task", "add_tag", "remove_tag", "add_to_project", "set_due_date", "apply_task_template",
  // Automations V3.
  "set_start_date", "move_to_project", "remove_from_project", "set_task_type", "set_description", "create_task",
  "convert_to_project",
]);
// Of those, the ones with more settings below the line too (part = block).
export const INLINE_AND_BLOCK_ACTION_TYPES: ReadonlySet<string> = new Set(["request_approval", "set_description", "create_task", "convert_to_project"]);

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
  // Rule text takes {{placeholders}} (Automations V2): an insert picker and a live preview.
  const text = (key: string, label: string, opts: { multiline?: boolean; placeholder?: string; maxLength?: number } = {}) => (
    <ParamSlot param={key}>
      <PlaceholderInput
        id={`${prefix}-${key}`}
        label={label}
        ctx={ctx}
        multiline={opts.multiline}
        placeholder={opts.placeholder ?? label}
        maxLength={opts.maxLength ?? (opts.multiline ? 5000 : 1000)}
        value={typeof action[key] === "string" ? (action[key] as string) : ""}
        onChange={(v) => onChange({ ...action, [key]: v })}
      />
    </ParamSlot>
  );

  switch (action.type) {
    case "move_section":
      return !inline ? null : (
        <ParamSlot param="section_id">
          <SectionSelect id={`${prefix}-section`} label="Section" value={action.section_id} ctx={ctx} onChange={(v) => onChange({ ...action, section_id: v })} />
        </ParamSlot>
      );
    case "set_field":
      return !inline ? null : (
        <Row>
          <ParamSlot param="field_id">
            <FieldSelect
              id={`${prefix}-field`}
              label="Field"
              value={action.field_id}
              fields={fields}
              onChange={(v) => onChange({ type: action.type, field_id: v, value: null })}
            />
          </ParamSlot>
          <ParamSlot param="value">
            <FieldValueInput
              id={`${prefix}-value`}
              field={fields.find((f) => f.id === action.field_id)}
              value={action.value}
              ctx={ctx}
              onChange={(v) => onChange({ ...action, value: v })}
            />
          </ParamSlot>
          {fields.find((f) => f.id === action.field_id)?.boundToSections ? (
            <span className="text-xs text-zinc-500">Status follows the section, so this moves the task.</span>
          ) : null}
        </Row>
      );
    case "set_assignee":
      return !inline ? null : <SetAssigneeFields prefix={prefix} action={action} ctx={ctx} onChange={onChange} />;
    case "remove_followers":
      return !inline ? null : (
        <ParamSlot param="people">
          <PeoplePicker idPrefix={`${prefix}-people`} label="Stop following" value={action.people} ctx={ctx} onChange={(v) => onChange({ ...action, people: v })} />
        </ParamSlot>
      );
    case "add_comment":
      return !block ? null : text("body", "Comment", { multiline: true, placeholder: "{assignee} “{{task.name}}” is ready for you" });
    case "add_followers":
      return !inline ? null : <ParamSlot param="people"><PeoplePicker idPrefix={`${prefix}-people`} label="Followers" value={action.people} ctx={ctx} onChange={(v) => onChange({ ...action, people: v })} /></ParamSlot>;
    case "notify":
      return !block ? null : (
        <div className="space-y-2">
          <ParamSlot param="people">
            <PeoplePicker idPrefix={`${prefix}-people`} label="Notify" value={action.people} ctx={ctx} onChange={(v) => onChange({ ...action, people: v })} />
          </ParamSlot>
          {text("message", "Message")}
        </div>
      );
    case "request_approval":
      if (part === "inline") {
        return <ParamSlot param="approver"><PersonSelect id={`${prefix}-approver`} label="Approver" value={action.approver} ctx={ctx} onChange={(v) => onChange({ ...action, approver: v })} placeholder="choose approver" /></ParamSlot>;
      }
      return (
        <div className="space-y-2">
          {part === "block" ? null : (
            <ParamSlot param="approver">
              <PersonSelect id={`${prefix}-approver`} label="Approver" value={action.approver} ctx={ctx} onChange={(v) => onChange({ ...action, approver: v })} />
            </ParamSlot>
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
            <ParamSlot param="to">
              <SmartPicker
                label="Recipient"
                value={str(action.to) || null}
                options={EMAIL_RECIPIENTS.map((r) => ({ ...r }))}
                onChange={(v) => onChange({ ...action, to: v })}
                variant="chip"
                placeholder="choose a recipient"
              />
            </ParamSlot>
            {action.to === "field" ? (
              <ParamSlot param="field_id">
                <FieldSelect
                  id={`${prefix}-email-field`}
                  label="Field holding the address"
                  value={action.field_id}
                  fields={fields.filter((f) => f.fieldType === "text")}
                  onChange={(v) => onChange({ ...action, field_id: v })}
                />
              </ParamSlot>
            ) : null}
            {action.to === "address" ? (
              <ParamSlot param="address">
                <TextBox
                  label="Email address"
                  type="email"
                  placeholder="team@example.com"
                  value={str(action.address)}
                  maxLength={320}
                  className="w-56"
                  onChange={(v) => onChange({ ...action, address: v })}
                />
              </ParamSlot>
            ) : null}
            <span className="text-zinc-600">using</span>
            <ParamSlot param="template">
              <SmartPicker
                label="Template"
                value={typeof action.template === "string" ? action.template : "requester_update"}
                options={EMAIL_TEMPLATES.map((t) => ({ ...t }))}
                onChange={(v) => onChange({ ...action, template: v })}
                variant="chip"
              />
            </ParamSlot>
          </Row>
          {text("subject", "Subject (optional)")}
          {text("message", "Message", { multiline: true })}
          <Row>
            <span className={labelClass}>Include field</span>
            <ParamSlot param="include_field_id">
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
            </ParamSlot>
          </Row>
        </div>
      );
    case "send_slack":
    case "call_webhook":
      return !block ? null : <IntegrationFields projectId={projectId} prefix={prefix} action={action} ctx={ctx} onChange={onChange} />;
    case "delay":
      return !inline ? null : (
        <span className="flex items-center gap-1.5 text-sm text-zinc-700" title="The remaining actions are skipped if the conditions stop matching or the rule is turned off">
          <ParamSlot param="hours">
            <NumberBox
              id={`${prefix}-hours`}
              label="Hours to wait"
              value={typeof action.hours === "number" && Number.isFinite(action.hours) ? action.hours : null}
              whole={false}
              min={0.1}
              max={720}
              placeholder="24"
              className="w-20"
              onCommit={(n) => onChange(n === null ? omit(action, "hours") : { ...action, hours: n })}
            />
          </ParamSlot>
          hours, then continue
        </span>
      );
    case "complete_task":
    case "reopen_task":
    case "remove_from_project":
      return null;
    case "set_task_type":
      return !inline ? null : (
        <ParamSlot param="kind">
          <SmartPicker
            id={`${prefix}-set-kind`}
            label="Task type"
            value={str(action.kind) || null}
            options={TASK_KIND_OPTIONS.map((k) => ({ value: k.value, label: k.label.toLowerCase() }))}
            onChange={(v) => onChange({ ...action, kind: v })}
            variant="chip"
            placeholder="choose a task type"
            renderValue={(chosen) => (chosen[0] ? <span>to {chosen[0].label}</span> : undefined)}
          />
        </ParamSlot>
      );
    case "set_description": {
      const mode = (
          <ParamSlot param="mode">
            <SmartPicker
              id={`${prefix}-description-mode`}
              label="Replace or add"
              value={str(action.mode) || "replace"}
              options={DESCRIPTION_MODES.map((m) => ({ ...m }))}
              onChange={(v) => onChange(v === "replace" ? omit(action, "mode") : { ...action, mode: v })}
              variant="chip"
            />
          </ParamSlot>
      );
      const body = text("text", "Description", { multiline: true, placeholder: "Brief from {{form.field.Details}}", maxLength: 10000 });
      if (part === "inline") return mode;
      if (part === "block") return body;
      return (
        <div className="space-y-2">
          {mode}
          {body}
        </div>
      );
    }
    case "convert_to_project": {
      const inlinePart = (
        <Row>
          <ParamSlot param="template_id">
            <SmartPicker
              id={`${prefix}-convert-template`}
              label="Blank or from a template"
              value={str(action.template_id)}
              options={[
                { value: "", label: "blank", description: "Sections and fields are up to you" },
                ...(ctx.projectTemplates ?? []).map((t) => ({ value: t.id, label: `from “${t.name}”`, icon: <FolderClosed className="size-4" /> })),
              ]}
              onChange={(v) => onChange(v ? { ...action, template_id: v } : omit(action, "template_id"))}
              variant="chip"
              searchable
              renderValue={valueOr(action.template_id ? "from a removed template" : "blank")}
            />
          </ParamSlot>
          <Word>in</Word>
          <ParamSlot param="portfolio_id">
            <SmartPicker
              id={`${prefix}-convert-portfolio`}
              label="Portfolio"
              value={str(action.portfolio_id)}
              options={[{ value: "", label: "no portfolio" }, ...(ctx.portfolios ?? []).map((p) => ({ value: p.id, label: p.name }))]}
              onChange={(v) => onChange(v ? { ...action, portfolio_id: v } : omit(action, "portfolio_id"))}
              variant="chip"
              renderValue={valueOr(action.portfolio_id ? "a portfolio you can’t edit" : "no portfolio")}
            />
          </ParamSlot>
        </Row>
      );
      const blockPart = (
        <div className="space-y-2">
          {text("name", "Project name (empty = the task’s name)", { placeholder: "Event: {{task.name}}", maxLength: 200 })}
          <Row>
            <Word>and</Word>
            <ParamSlot param="members">
              <SmartPicker
                id={`${prefix}-convert-members`}
                label="Who joins"
                value={str(action.members) || "none"}
                options={[
                  { value: "none", label: "invite nobody else", description: "Only the rule’s owner (who owns the project)" },
                  { value: "task_people", label: "invite the task’s people", description: "Its assignee and followers, as Editors" },
                ]}
                onChange={(v) => onChange(v === "none" ? omit(action, "members") : { ...action, members: v })}
                variant="chip"
              />
            </ParamSlot>
            <SmartPicker
              id={`${prefix}-convert-brief`}
              label="Brief task"
              value={action.brief === false ? "no" : "yes"}
              options={[
                { value: "yes", label: "add a brief task", description: "The task’s description and links to its files" },
                { value: "no", label: "no brief task" },
              ]}
              onChange={(v) => onChange(v === "yes" ? omit(action, "brief") : { ...action, brief: false })}
              variant="chip"
            />
            <SmartPicker
              id={`${prefix}-convert-complete`}
              label="Then the task"
              value={action.complete_task === true ? "yes" : "no"}
              options={[
                { value: "no", label: "keep the task open" },
                { value: "yes", label: "complete the task", description: "Not approval tasks: only their approvers complete them" },
              ]}
              onChange={(v) => onChange(v === "yes" ? { ...action, complete_task: true } : omit(action, "complete_task"))}
              variant="chip"
            />
          </Row>
          <p className="text-xs text-zinc-500">The rule’s owner owns the new project. A comment on the task links to it.</p>
        </div>
      );
      if (part === "inline") return inlinePart;
      if (part === "block") return blockPart;
      return (
        <div className="space-y-2">
          {inlinePart}
          {blockPart}
        </div>
      );
    }
    case "create_task":
      if (part) return <CreateTaskFields prefix={prefix} action={action} ctx={ctx} onChange={onChange} part={part} text={text} />;
      return (
        <div className="space-y-2">
          <CreateTaskFields prefix={prefix} action={action} ctx={ctx} onChange={onChange} part="inline" text={text} />
          <CreateTaskFields prefix={prefix} action={action} ctx={ctx} onChange={onChange} part="block" text={text} />
        </div>
      );
    case "add_tag":
    case "remove_tag":
      return !inline ? null : (
        <ParamSlot param="tag_id">
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
        </ParamSlot>
      );
    case "add_to_project":
    case "move_to_project": {
      if (!inline) return null;
      const projects = ctx.otherProjects ?? [];
      const project = projects.find((p) => p.id === action.project_id);
      return (
        <Row>
          <ParamSlot param="project_id">
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
          </ParamSlot>
          {project ? (
            <>
              <Word>in</Word>
              <ParamSlot param="section_id">
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
              </ParamSlot>
            </>
          ) : null}
        </Row>
      );
    }
    case "set_due_date":
    case "set_start_date":
      return !inline ? null : <SetDateFields prefix={prefix} action={action} ctx={ctx} onChange={onChange} />;
    case "apply_task_template": {
      if (!inline) return null;
      const templates = ctx.taskTemplates ?? [];
      return (
        <ParamSlot param="template_id">
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
        </ParamSlot>
      );
    }
    case "set_title":
      return !block ? null : text("title", "New task name", { placeholder: "[{{field.Request type}}] {{task.name}}", maxLength: 500 });
    case "create_subtasks":
      return !block ? null : <CreateSubtasksFields prefix={prefix} action={action} ctx={ctx} onChange={onChange} />;
    default:
      return null;
  }
}

// Create a task: "[a milestone] in [this project] › [section]" on the line, then its name, description,
// assignee, due date, and link to this task below (mirrors execute_rule_actions' create_task).
function CreateTaskFields({
  prefix,
  action,
  ctx,
  onChange,
  part,
  text,
}: {
  prefix: string;
  action: RuleAction;
  ctx: RuleContext;
  onChange: (next: RuleAction) => void;
  part?: "inline" | "block";
  text: (key: string, label: string, opts?: { multiline?: boolean; placeholder?: string; maxLength?: number }) => React.ReactNode;
}) {
  const projects = ctx.otherProjects ?? [];
  const projectId = str(action.project_id);
  const other = projects.find((p) => p.id === projectId);
  const sections = projectId ? (other?.sections ?? []) : ctx.sections;
  const dueDays = wholeNumber(action.due_days);
  if (part !== "block") {
    return (
      <Row>
        <ParamSlot param="kind">
          <SmartPicker
            id={`${prefix}-create-kind`}
            label="What to create"
            value={str(action.kind) || "task"}
            options={TASK_KIND_OPTIONS.map((k) => ({ value: k.value, label: k.value === "approval" ? "an approval" : `a ${k.label.toLowerCase()}` }))}
            onChange={(v) => onChange({ ...action, kind: v })}
            variant="chip"
          />
        </ParamSlot>
        <Word>in</Word>
        <ParamSlot param="project_id">
          <SmartPicker
            id={`${prefix}-create-project`}
            label="Project"
            value={projectId}
            options={[
              { value: "", label: ctx.projectName ? `this project (${ctx.projectName})` : "this project", icon: <FolderClosed className="size-4" /> },
              ...projects.map((p) => ({ value: p.id, label: p.name, icon: <FolderClosed className="size-4" /> })),
            ]}
            onChange={(v) => {
              if (v !== projectId) onChange(v ? { ...omit(action, "section_id"), project_id: v } : omit(action, "project_id", "section_id"));
            }}
            variant="chip"
            renderValue={valueOr(projectId ? "a project you can’t edit" : "this project")}
            searchable
          />
        </ParamSlot>
        <ParamSlot param="section_id">
          <SmartPicker
            id={`${prefix}-create-section`}
            label="Section"
            value={str(action.section_id)}
            options={[{ value: "", label: "no section", description: "Listed under “No section”" }, ...sectionOptions({ ...ctx, sections })]}
            onChange={(v) => onChange(v ? { ...action, section_id: v } : omit(action, "section_id"))}
            variant="chip"
            renderValue={valueOr("no section")}
          />
        </ParamSlot>
      </Row>
    );
  }
  return (
    <div className="space-y-2">
      {text("title", "Name of the new task", { placeholder: "Design for {{task.name}}", maxLength: 500 })}
      {text("notes", "Description (optional)", { multiline: true, maxLength: 10000 })}
      <Row>
        <Word>{action.kind === "approval" ? "approver" : "assigned to"}</Word>
        <ParamSlot param="assignee">
          <PersonSelect
            id={`${prefix}-create-assignee`}
            label={action.kind === "approval" ? "Approver" : "Assignee"}
            value={action.assignee ?? null}
            ctx={ctx}
            allowNone="Nobody"
            onChange={(v) => onChange(v ? { ...action, assignee: v } : omit(action, "assignee"))}
          />
        </ParamSlot>
        <Word>due</Word>
        <SmartPicker
          id={`${prefix}-create-due`}
          label="Due date"
          value={dueDays === null ? "none" : "days"}
          options={[
            { value: "none", label: "no due date" },
            { value: "days", label: "some days from today" },
          ]}
          onChange={(v) => onChange(v === "none" ? omit(action, "due_days", "business_days") : { ...action, due_days: dueDays ?? 3, business_days: true })}
          variant="chip"
        />
        {dueDays !== null ? (
          <>
            <ParamSlot param="due_days">
              <NumberBox
                id={`${prefix}-create-due-days`}
                label="Days from today"
                value={dueDays}
                min={0}
                max={365}
                onCommit={(n) => {
                  if (n !== null) onChange({ ...action, due_days: Math.min(Math.max(n, 0), 365) });
                }}
              />
            </ParamSlot>
            <SmartPicker
              id={`${prefix}-create-due-unit`}
              label="Days or business days"
              value={action.business_days === true ? "business" : "days"}
              options={[
                { value: "days", label: dueDays === 1 ? "day" : "days" },
                { value: "business", label: dueDays === 1 ? "business day" : "business days" },
              ]}
              onChange={(v) => onChange({ ...action, business_days: v === "business" })}
              variant="chip"
            />
          </>
        ) : null}
      </Row>
      <Row>
        <Word>and</Word>
        <ParamSlot param="link">
          <SmartPicker
            id={`${prefix}-create-link`}
            label="Link to this task"
            value={str(action.link) || "none"}
            options={CREATE_LINKS.map((l) => ({ ...l }))}
            onChange={(v) => onChange(v === "none" ? omit(action, "link") : { ...action, link: v })}
            variant="chip"
          />
        </ParamSlot>
      </Row>
    </div>
  );
}

// Set assignee: "[to] [Dana]", "[round robin among] [Dana, Sam]", or "[to the least busy of] […]"
// (Automations V3 adds the last two and People fields as people).
function SetAssigneeFields({
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
  const mode = action.mode === "round_robin" || action.mode === "balanced" ? action.mode : "person";
  return (
    <Row>
      <ParamSlot param="mode">
        <SmartPicker
          id={`${prefix}-assign-mode`}
          label="How to pick the assignee"
          value={mode}
          options={ASSIGN_MODES.map((m) => ({
            ...m,
            ...(m.value !== "person" && ctx.v3 === false ? { disabled: true, disabledReason: "Needs this release’s database update" } : {}),
          }))}
          onChange={(v) => {
            if (v === mode) return;
            if (v === "person") onChange({ type: action.type, assignee: null });
            else onChange({ type: action.type, mode: v, people: Array.isArray(action.people) ? action.people : [] });
          }}
          variant="chip"
        />
      </ParamSlot>
      {mode === "person" ? (
        <ParamSlot param="assignee">
          <PersonSelect
            id={`${prefix}-assignee`}
            label="Assignee"
            value={action.assignee === undefined ? null : action.assignee}
            ctx={ctx}
            allowNone="Nobody (unassign)"
            onChange={(v) => onChange({ ...action, assignee: v || null })}
          />
        </ParamSlot>
      ) : (
        <ParamSlot param="people">
          <PeoplePicker
            idPrefix={`${prefix}-assign-pool`}
            label={mode === "round_robin" ? "People who take turns" : "People to balance between"}
            value={action.people}
            ctx={ctx}
            onChange={(v) => onChange({ ...action, people: v })}
          />
        </ParamSlot>
      )}
    </Row>
  );
}

// Set due / start date: "to [2] [business days] from [today]", "to [3] [hours] from now", "on [Nov 2]",
// or "clear it", with an example in the browser's own calendar (mirrors rule_set_task_date). Weeks,
// hours, and a fixed date arrive with Automations V3's database update.
function SetDateFields({
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
  const mode = action.mode === "clear" || action.mode === "date" ? action.mode : "relative";
  const days = wholeNumber(action.days);
  const unit = action.unit === "weeks" || action.unit === "hours" ? action.unit : "days";
  const business = action.business_days === true && unit === "days";
  const from = str(action.from) || "today";
  const workWeek = normalizeWorkWeek(ctx.workWeek ?? DEFAULT_WORK_WEEK);
  const plural = days === null || Math.abs(days) !== 1;
  const what = action.type === "set_start_date" ? "start date" : "due date";
  const needs = ctx.v3 === false ? ({ disabled: true, disabledReason: "Needs this release’s database update" } as const) : {};

  let example: string | null = null;
  if (mode === "relative" && unit !== "hours" && today && days !== null && Math.abs(days) <= 365) {
    const result = unit === "weeks" ? addWorkdays(today, days * 7, false, workWeek) : addWorkdays(today, days, business, workWeek);
    const year = Number(today.slice(0, 4));
    const day = (d: string) => `${WEEKDAYS[weekdayOf(d)].short}, ${dayLabel(d, year)}`;
    const start = from === "today" ? "today" : `${from === "due_date" ? "due" : "starting"} ${day(today)}`;
    if (result) example = `e.g. ${start} → ${day(result)}`;
  }

  const unitOptions = [
    { value: "days", label: plural ? "days" : "day", description: "Every day of the week" },
    {
      value: "business",
      label: plural ? "business days" : "business day",
      description: `Only workdays (${describeWorkWeek(workWeek)}; Admin console → Organization)`,
    },
    { value: "weeks", label: plural ? "weeks" : "week", description: "Calendar weeks (7 days each)", ...needs },
    { value: "hours", label: plural ? "hours" : "hour", description: "From now; sets a time too", ...needs },
  ];

  return (
    <Row>
      <ParamSlot param="mode">
        <SmartPicker
          id={`${prefix}-date-mode`}
          label={`Set or clear the ${what}`}
          value={mode}
          options={[
            { value: "relative", label: "to", description: "Some days, weeks, or hours from a date" },
            { value: "date", label: "on", description: "A date you pick", ...needs },
            { value: "clear", label: "clear it", description: `Removes the ${what}` },
          ]}
          onChange={(v) => {
            // Picking the current choice again keeps the rest.
            if (v === mode) return;
            if (v === "clear") onChange({ type: action.type, mode: "clear" });
            else if (v === "date") onChange({ type: action.type, mode: "date" });
            else onChange(defaultsFor(action.type));
          }}
          variant="chip"
        />
      </ParamSlot>
      {mode === "date" ? (
        <ParamSlot param="date">
          <RuleDateInput
            id={`${prefix}-date-day`}
            label={what === "due date" ? "Due date" : "Start date"}
            value={action.date}
            onChange={(v) => onChange(v ? { ...action, date: v } : omit(action, "date"))}
          />
        </ParamSlot>
      ) : null}
      {mode === "relative" ? (
        <>
          <ParamSlot param="days">
            <NumberBox
              id={`${prefix}-date-days`}
              label={unit === "hours" ? "Hours from now" : `${unit === "weeks" ? "Weeks" : "Days"} (negative for earlier)`}
              value={days}
              min={unit === "hours" ? 1 : unit === "weeks" ? -52 : -365}
              max={unit === "hours" ? 2160 : unit === "weeks" ? 52 : 365}
              placeholder="2"
              onCommit={(n) => onChange(n === null ? omit(action, "days") : { ...action, days: n })}
            />
          </ParamSlot>
          <span data-tooltip={business ? `Business days: ${describeWorkWeek(workWeek)}` : undefined}>
            <SmartPicker
              id={`${prefix}-date-unit`}
              label="Count days, business days, weeks, or hours"
              value={business ? "business" : unit}
              options={unitOptions}
              onChange={(v) => {
                const base = omit(action, "unit", "business_days");
                if (v === "business") onChange({ ...base, business_days: true });
                else if (v === "days") onChange(base);
                else if (v === "hours") onChange({ ...omit(base, "from"), unit: v, days: Math.max(days ?? 1, 1) });
                else onChange({ ...base, unit: v });
              }}
              variant="chip"
            />
          </span>
          {unit === "hours" ? (
            <Word>from now</Word>
          ) : (
            <>
              <Word>from</Word>
              <ParamSlot param="from">
                <SmartPicker
                  id={`${prefix}-date-from`}
                  label="Count from"
                  value={from}
                  options={DUE_FROM.map((d) => ({ ...d }))}
                  onChange={(v) => onChange({ ...action, from: v })}
                  variant="chip"
                />
              </ParamSlot>
            </>
          )}
          {example ? <span className="text-xs text-zinc-500">{example}</span> : null}
        </>
      ) : null}
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
      <ParamSlot param="titles">
        <ol aria-label="Subtasks to create" className="space-y-1">
          {titles.map((title, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span aria-hidden className="w-4 text-right text-xs tabular-nums text-zinc-400">
                {i + 1}.
              </span>
              <PlaceholderInput
                id={inputId(i)}
                label={`Subtask ${i + 1} name`}
                ctx={ctx}
                placeholder={i === 0 ? "Draft the copy for {{task.name}}" : "Subtask name"}
                value={title}
                maxLength={500}
                className="flex-1"
                onChange={(v) => setTitles(titles.map((t, j) => (j === i ? v : t)))}
                onKeyDown={(e) => {
                  // Enter adds the next row, like a checklist.
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    addAfter(i);
                  }
                }}
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
      </ParamSlot>
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
          <ParamSlot param="assignee">
            <PersonSelect
              id={`${prefix}-subtask-assignee`}
              label="Assign the subtasks to"
              value={action.assignee ?? null}
              ctx={ctx}
              allowNone="Nobody"
              onChange={(v) => onChange(v ? { ...action, assignee: v } : omit(action, "assignee"))}
            />
          </ParamSlot>
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
          <ParamSlot param="message">
            <PlaceholderInput
              id={`${prefix}-message`}
              label="Slack message"
              ctx={ctx}
              multiline
              maxLength={4000}
              placeholder="{{task.name}} moved to {{task.section}} in {{project.name}}"
              value={typeof action.message === "string" ? action.message : ""}
              onChange={(v) => onChange({ ...action, message: v })}
            />
          </ParamSlot>
          <p className="text-xs text-zinc-500">
            Placeholders work here too ({"{{task.url}}"} or <span className="font-mono">{"{task_link}"}</span> link the task’s
            title in the app; people still sign in to open it). Task details are escaped, so a title can’t ping @channel.
          </p>
          <label htmlFor={`${prefix}-format`} className={`${labelClass} mt-1`}>
            Message style
          </label>
          <ParamSlot param="format">
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
          </ParamSlot>
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
