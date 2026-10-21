"use client";

// Portfolio rules (Automations V3, batch D): the portfolio's Rules tab (rules with on / off, manual
// runs, and the run log) and the rule builder, a sentence like the project rule canvas — When / If /
// Then — with the same searchable, grouped pickers (no browser select popups).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, CirclePause, Copy, Play, Plus, Trash2, UserRound, X, Zap } from "lucide-react";
import { RulePauseControls } from "@/components/rules/rule-pause";
import { Avatar } from "@/components/avatar";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { RuleDateInput, optionDot, scheduleLabel, type RuleContext } from "@/components/rules/rule-shared";
import { TriggerFields } from "@/components/rules/rule-editor";
import { RunSteps } from "@/components/rules/run-steps";
import {
  createPortfolioRule,
  deletePortfolioRule,
  duplicatePortfolioRule,
  runPortfolioRule,
  setPortfolioRuleEnabled,
  setPortfolioRulePausedUntil,
  updatePortfolioRule,
} from "@/lib/actions";
import {
  MEMBER_ROLES,
  PORTFOLIO_ACTIONS,
  PORTFOLIO_CONDITIONS,
  PORTFOLIO_TEXT_PLACEHOLDERS,
  PORTFOLIO_TRIGGERS,
  PROJECT_PEOPLE_ROLES,
  PROJECT_STATUSES,
  describePortfolioAction,
  portfolioActionDefaults,
  portfolioConditionDefaults,
  portfolioRuleSentence,
  type PortfolioActionType,
  type PortfolioConditionType,
  type PortfolioRuleContext,
  type PortfolioRuleDef,
  type PortfolioRuleItem,
  type PortfolioRuleRun,
  type PortfolioTriggerType,
} from "@/lib/portfolio-rules";
import { runReason } from "@/lib/rules";
import { runSteps } from "@/lib/rule-steps";
import type { Json } from "@/lib/supabase/database.types";

const INPUT = "control h-auto min-h-7 py-0.5";

const RUN_STATUS: Record<PortfolioRuleRun["status"], { label: string; className: string }> = {
  succeeded: { label: "Ran", className: "bg-green-50 text-green-800" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700" },
  skipped: { label: "Skipped", className: "bg-zinc-100 text-zinc-600" },
};

function vocab(list: readonly { value: string; label: string; group?: string; description?: string; keywords?: readonly string[] }[]): SmartOption[] {
  return list.map((x) => ({ value: x.value, label: x.label, group: x.group, description: x.description, keywords: x.keywords }));
}

function str(value: Json | undefined) {
  return typeof value === "string" ? value : "";
}

function strings(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function whole(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function omit<T extends Record<string, Json>>(item: T, ...keys: string[]): T {
  const copy = { ...item };
  for (const key of keys) delete copy[key];
  return copy;
}

const actionLabel = (type: string) => PORTFOLIO_ACTIONS.find((a) => a.value === type)?.label ?? type;

// The schedule picker is the project rule builder's (same vocabulary, same database function).
function scheduleCtx(ctx: PortfolioRuleContext): RuleContext {
  return { sections: [], fields: [], people: ctx.people, forms: [], integrations: null, inboundEndpoints: [], workWeek: ctx.workWeek, v3: true };
}

function sentence(rule: Pick<PortfolioRuleDef, "triggerType" | "triggerConfig" | "conditions" | "actions">, ctx: PortfolioRuleContext) {
  return portfolioRuleSentence(rule, ctx, rule.triggerType === "scheduled" ? scheduleLabel(rule.triggerConfig) : undefined);
}

// ---------------------------------------------------------------------------------------------
// The Rules tab
// ---------------------------------------------------------------------------------------------

export function PortfolioRulesView({
  portfolioId,
  rules,
  runs,
  ctx,
  canEdit,
  canRun,
}: {
  portfolioId: string;
  // Null: this release's database update isn't applied.
  rules: PortfolioRuleDef[] | null;
  runs: PortfolioRuleRun[];
  ctx: PortfolioRuleContext;
  canEdit: boolean;
  canRun: boolean;
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const names = new Map((rules ?? []).map((r) => [r.id, r.name]));

  if (rules === null) {
    return (
      <div className="px-gutter py-6">
        <EmptyState icon={Zap} title="Portfolio rules need this release’s database update">
          Once it’s applied, rules can remind owners about status updates, set statuses, and more.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-gutter py-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-zinc-900">Rules</h2>
          <p className="text-sm text-zinc-600">
            Automate the projects in this portfolio: remind owners to post a status, flag projects that run late, keep fields
            and members in step. Rules act with their owner’s access.
          </p>
        </div>
        {canEdit ? (
          <Link href={`/portfolios/${portfolioId}/rules/new`} className="btn-primary h-8 px-3">
            <Plus className="size-4" aria-hidden />
            Add rule
          </Link>
        ) : null}
      </div>

      {rules.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No rules yet"
          action={
            canEdit ? (
              <Link href={`/portfolios/${portfolioId}/rules/new`} className="btn-secondary h-8 px-3">
                Add a rule
              </Link>
            ) : undefined
          }
        >
          {canEdit ? "For example: when a project goes off track, notify its members." : "Portfolio admins and owners add rules here."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {rules.map((rule) => (
            <li key={rule.id} className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2" data-tooltip={canEdit ? (rule.enabled ? "Turn off" : "Turn on") : undefined}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={rule.enabled}
                    disabled={!canEdit || pending}
                    aria-label={`${rule.name}: ${rule.enabled ? "on" : "off"}`}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      run(() => setPortfolioRuleEnabled(rule.id, on));
                    }}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden
                    className="relative inline-block h-5 w-9 rounded-full bg-zinc-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent-500 peer-checked:after:translate-x-4 peer-disabled:opacity-60 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500"
                  />
                </label>
                <Link href={`/portfolios/${portfolioId}/rules/${rule.id}`} className="min-w-0 flex-1 truncate font-medium text-zinc-900 hover:underline">
                  {rule.name}
                </Link>
                {rule.triggerType === "manual" && rule.enabled && canRun ? (
                  <SmartPicker
                    label={`Run “${rule.name}” on a project`}
                    value={null}
                    options={ctx.projects.map((p) => ({ value: p.id, label: p.name }))}
                    onChange={(projectId) =>
                      run(async () => {
                        const result = await runPortfolioRule(rule.id, projectId);
                        if (!result.error) {
                          notify(
                            result.status === "conditions"
                              ? "Nothing ran: the conditions don’t match that project"
                              : result.summary.length
                                ? result.summary.join(" · ")
                                : `Rule ${result.status === "skipped" ? "skipped" : "ran"}`,
                          );
                        }
                        return result;
                      })
                    }
                    variant="ghost"
                    searchable
                    emptyText="No project in this portfolio"
                    className="h-7 px-2 text-xs"
                    renderValue={() => (
                      <>
                        <Play className="size-3.5" aria-hidden />
                        Run on…
                      </>
                    )}
                  />
                ) : null}
                {canEdit && rule.enabled ? (
                  <RulePauseControls
                    name={rule.name}
                    pausedUntil={rule.pausedUntil}
                    disabled={pending}
                    onChange={(until) => run(() => setPortfolioRulePausedUntil(rule.id, until))}
                  />
                ) : null}
                {canEdit ? (
                  <button
                    type="button"
                    aria-label={`Duplicate ${rule.name}`}
                    data-tooltip="Duplicate (the copy starts off)"
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        const result = await duplicatePortfolioRule(rule.id);
                        if (!result.error) notify(`Copied “${rule.name}” (off until you turn it on)`);
                        return result;
                      })
                    }
                    className="btn-icon size-7"
                  >
                    <Copy className="size-4" />
                  </button>
                ) : null}
                {canEdit ? (
                  <button
                    type="button"
                    aria-label={`Delete ${rule.name}`}
                    data-tooltip="Delete rule"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Delete the rule “${rule.name}”?`)) run(() => deletePortfolioRule(rule.id));
                    }}
                    className="btn-icon size-7"
                  >
                    <Trash2 className="size-4" />
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-zinc-600">{sentence(rule, ctx)}</p>
              {rule.pausedAt ? (
                <p className="mt-1 flex items-center gap-1 text-xs text-amber-800">
                  <CirclePause className="size-3.5" aria-hidden />
                  Paused after failing again and again{rule.pauseReason ? `: ${rule.pauseReason}` : ""}. Turn it back on once it’s fixed.
                </p>
              ) : rule.nextRunAt && rule.enabled ? (
                <p className="mt-1 text-xs text-zinc-500">
                  Next run <Timestamp iso={rule.nextRunAt} />
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <section aria-label="Recent runs">
        <h3 className="mb-2 text-sm font-semibold text-zinc-900">Recent runs</h3>
        <RunLog runs={runs} ruleName={(id) => names.get(id) ?? "A removed rule"} />
      </section>
    </div>
  );
}

function RunLog({ runs, ruleName }: { runs: PortfolioRuleRun[]; ruleName?: (id: string) => string }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (runs.length === 0) {
    return <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-500">No runs yet.</p>;
  }
  return (
    <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
      {runs.map((r) => {
        const expanded = open.has(r.id);
        const reason = runReason(r.detail);
        const logged = runSteps(r.detail);
        return (
          <li key={r.id}>
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`Steps of this run (${RUN_STATUS[r.status].label})`}
                onClick={() =>
                  setOpen((current) => {
                    const next = new Set(current);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    return next;
                  })
                }
                className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-zinc-100"
              >
                <ChevronRight className={`size-3.5 text-zinc-400 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden />
                <span className={`rounded-full px-2 py-0.5 text-2xs font-medium ${RUN_STATUS[r.status].className}`}>{RUN_STATUS[r.status].label}</span>
              </button>
              {ruleName ? <span className="text-sm text-zinc-800">{ruleName(r.ruleId)}</span> : null}
              {r.projectId ? (
                <Link href={`/projects/${r.projectId}/overview`} className="min-w-0 truncate text-sm text-zinc-600 hover:underline">
                  {r.projectName ?? "a project you can’t open"}
                </Link>
              ) : null}
              {reason ? <span className="min-w-0 truncate text-xs text-zinc-500">· {reason}</span> : null}
              <span className="ml-auto text-xs text-zinc-400">
                <Timestamp iso={r.createdAt} />
              </span>
            </div>
            {expanded ? (
              <div className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-3">
                {r.status === "skipped" ? (
                  <p className="text-xs text-zinc-600">Skipped{reason ? `: ${reason}` : ""}. Nothing ran.</p>
                ) : (
                  <RunSteps steps={logged.steps} error={logged.error} actionLabel={actionLabel} />
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5">{children}</div>;
}

function SentenceRow({ word, children }: { word: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-t border-zinc-100 px-4 py-2.5 first:border-t-0">
      <span className="mt-1 w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">{word}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm text-zinc-700">{children}</div>
    </div>
  );
}

function NumberInput({ label, value, min, max, onChange }: { label: string; value: number | null; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={1}
      value={value ?? ""}
      onChange={(e) => {
        const n = Number(e.currentTarget.value);
        if (e.currentTarget.value !== "" && Number.isFinite(n)) onChange(Math.min(Math.max(Math.trunc(n), min), max));
      }}
      className={`${INPUT} w-16`}
    />
  );
}

function TextInput({ label, value, onChange, placeholder, wide = false }: { label: string; value: Json | undefined; onChange: (v: string) => void; placeholder?: string; wide?: boolean }) {
  return (
    <input
      aria-label={label}
      value={str(value)}
      placeholder={placeholder}
      maxLength={1000}
      onChange={(e) => onChange(e.currentTarget.value)}
      className={`${INPUT} ${wide ? "w-full" : "w-56"}`}
    />
  );
}

const statusOptions = PROJECT_STATUSES.map((s) => ({ value: s.value, label: s.label }));

function peopleOptions(ctx: PortfolioRuleContext, roles: boolean): SmartOption[] {
  return [
    ...(roles ? PROJECT_PEOPLE_ROLES.map((r) => ({ value: r.value as string, label: r.label, group: "On the project", icon: <UserRound className="size-4" /> })) : []),
    ...ctx.people.map((p) => ({ value: p.id, label: p.name, group: "People", icon: <Avatar name={p.name} /> })),
  ];
}

function FieldValue({ ctx, fieldId, value, onChange }: { ctx: PortfolioRuleContext; fieldId: Json | undefined; value: Json | undefined; onChange: (v: Json) => void }) {
  const field = ctx.fields.find((f) => f.id === fieldId);
  if (!field) return null;
  if (field.fieldType === "single_select") {
    return (
      <SmartPicker
        label={`${field.name} value`}
        value={str(value) || null}
        options={field.options.map((o) => ({ value: o.id, label: o.name, icon: optionDot(o.color) }))}
        onChange={onChange}
        variant="chip"
        placeholder="choose option"
      />
    );
  }
  if (field.fieldType === "date") return <RuleDateInput label={`${field.name} value`} value={value} onChange={(v) => onChange(v)} />;
  if (field.fieldType === "number") {
    return (
      <input
        type="number"
        aria-label={`${field.name} value`}
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
        className={`${INPUT} w-28`}
      />
    );
  }
  return <TextInput label={`${field.name} value`} value={value} onChange={(v) => onChange(v || null)} />;
}

function FieldPicker({ ctx, value, onChange, options = "all" }: { ctx: PortfolioRuleContext; value: Json | undefined; onChange: (id: string) => void; options?: "all" | "select" }) {
  const fields = options === "select" ? ctx.fields.filter((f) => f.fieldType === "single_select") : ctx.fields;
  return (
    <SmartPicker
      label="Field"
      value={str(value) || null}
      options={fields.map((f) => ({ value: f.id, label: f.name }))}
      onChange={onChange}
      variant="chip"
      placeholder="choose field"
      emptyText={ctx.fields.length ? "No field matches" : "Add a field in Settings → Fields first"}
    />
  );
}

function TriggerSettings({
  triggerType,
  config,
  ctx,
  onChange,
}: {
  triggerType: PortfolioTriggerType;
  config: Record<string, Json>;
  ctx: PortfolioRuleContext;
  onChange: (config: Record<string, Json>) => void;
}) {
  switch (triggerType) {
    case "status_changed":
      return (
        <SmartPicker
          multiple
          label="To which statuses"
          value={strings(config.statuses)}
          options={statusOptions}
          onChange={(v) => onChange(v.length ? { ...config, statuses: v } : omit(config, "statuses"))}
          variant="chip"
          placeholder="any status"
          renderValue={(chosen) => (chosen.length ? <span>to {chosen.map((c) => c.label.toLowerCase()).join(" or ")}</span> : undefined)}
        />
      );
    case "field_changed": {
      const field = ctx.fields.find((f) => f.id === config.field_id);
      return (
        <Row>
          <FieldPicker ctx={ctx} value={config.field_id} onChange={(v) => onChange({ ...omit(config, "option_id"), field_id: v })} />
          {field?.fieldType === "single_select" ? (
            <SmartPicker
              label="Changes to"
              value={str(config.option_id)}
              options={[{ value: "", label: "to any value" }, ...field.options.map((o) => ({ value: o.id, label: `to ${o.name}`, icon: optionDot(o.color) }))]}
              onChange={(v) => onChange(v ? { ...config, option_id: v } : omit(config, "option_id"))}
              variant="chip"
            />
          ) : null}
        </Row>
      );
    }
    case "due_approaching":
    case "item_overdue": {
      const min = triggerType === "item_overdue" ? 1 : 0;
      return (
        <span className="flex items-center gap-1.5">
          <NumberInput label="Days" value={Math.max(whole(config.days) ?? 1, min)} min={min} max={60} onChange={(n) => onChange({ ...config, days: n })} />
          {triggerType === "due_approaching" ? "days before it’s due" : "days after it’s due"}
        </span>
      );
    }
    case "scheduled":
      return <TriggerFields prefix="portfolio-rule" triggerType="scheduled" triggerConfig={config} ctx={scheduleCtx(ctx)} onChange={onChange} />;
    default:
      return null;
  }
}

function ConditionSettings({ c, ctx, onChange }: { c: PortfolioRuleItem; ctx: PortfolioRuleContext; onChange: (next: PortfolioRuleItem) => void }) {
  switch (c.type) {
    case "status_is":
    case "status_is_not":
      return (
        <SmartPicker multiple label="Statuses" value={strings(c.statuses)} options={statusOptions} onChange={(v) => onChange({ ...c, statuses: v })} variant="chip" placeholder="choose statuses" />
      );
    case "owner_is":
    case "owner_is_not":
      return (
        <SmartPicker multiple label="People" value={strings(c.people)} options={peopleOptions(ctx, false)} onChange={(v) => onChange({ ...c, people: v })} variant="chip" placeholder="choose people" searchable />
      );
    case "due_within":
      return (
        <span className="flex items-center gap-1.5">
          <NumberInput label="Days" value={whole(c.days)} min={0} max={365} onChange={(n) => onChange({ ...c, days: n })} />
          days
        </span>
      );
    case "date_compare": {
      const range = c.op === "between" || c.op === "not_between";
      return (
        <Row>
          <SmartPicker
            label="Comparison"
            value={str(c.op) || null}
            options={[
              { value: "before", label: "is before" },
              { value: "after", label: "is after" },
              { value: "on", label: "is on" },
              { value: "on_or_before", label: "is on or before" },
              { value: "on_or_after", label: "is on or after" },
              { value: "between", label: "is between" },
              { value: "not_between", label: "isn’t between" },
            ]}
            onChange={(v) => onChange(v === "between" || v === "not_between" ? { ...c, op: v } : { ...omit(c, "to"), op: v })}
            variant="chip"
          />
          <RuleDateInput label="Date" value={c.value} onChange={(v) => onChange(v ? { ...c, value: v } : omit(c, "value"))} />
          {range ? (
            <>
              <span className="text-zinc-600">and</span>
              <RuleDateInput label="To" value={c.to} onChange={(v) => onChange(v ? { ...c, to: v } : omit(c, "to"))} />
            </>
          ) : null}
        </Row>
      );
    }
    case "field_equals":
    case "field_is_set":
    case "field_is_empty":
      return (
        <Row>
          <FieldPicker ctx={ctx} value={c.field_id} onChange={(v) => onChange({ type: c.type, field_id: v })} />
          {c.type === "field_equals" ? <FieldValue ctx={ctx} fieldId={c.field_id} value={c.value} onChange={(v) => onChange({ ...c, value: v })} /> : null}
        </Row>
      );
    default:
      return null;
  }
}

const PLACEHOLDER_HINT = `Placeholders: ${PORTFOLIO_TEXT_PLACEHOLDERS.map((p) => `{{${p.key}}}`).join(", ")}`;

function ActionSettings({ a, ctx, onChange }: { a: PortfolioRuleItem; ctx: PortfolioRuleContext; onChange: (next: PortfolioRuleItem) => void }) {
  switch (a.type) {
    case "set_status":
      return (
        <Row>
          <SmartPicker label="Status" value={str(a.status) || null} options={statusOptions} onChange={(v) => onChange({ ...a, status: v })} variant="chip" placeholder="choose status" />
          <TextInput label="Note (optional)" value={a.note} placeholder="Note (optional)" onChange={(v) => onChange(v ? { ...a, note: v } : omit(a, "note"))} />
        </Row>
      );
    case "status_reminder":
      return (
        <div className="w-full space-y-1">
          <TextInput label="Message (optional)" value={a.message} wide placeholder="Time for a status update on {{project.name}}." onChange={(v) => onChange(v ? { ...a, message: v } : omit(a, "message"))} />
          <p className="text-xs text-zinc-500">{PLACEHOLDER_HINT}</p>
        </div>
      );
    case "notify":
      return (
        <div className="w-full space-y-1.5">
          <SmartPicker multiple label="Who" value={strings(a.people)} options={peopleOptions(ctx, true)} onChange={(v) => onChange({ ...a, people: v })} variant="chip" placeholder="choose who" searchable />
          <TextInput label="Message" value={a.message} wide placeholder="{{project.name}} is {{project.status}}" onChange={(v) => onChange({ ...a, message: v })} />
          <p className="text-xs text-zinc-500">{PLACEHOLDER_HINT}</p>
        </div>
      );
    case "set_owner":
      return (
        <SmartPicker label="New owner" value={str(a.person) || null} options={peopleOptions(ctx, false)} onChange={(v) => onChange({ ...a, person: v })} variant="chip" placeholder="choose person" searchable />
      );
    case "set_due_date": {
      const mode = a.mode === "clear" || a.mode === "date" ? a.mode : "relative";
      return (
        <Row>
          <SmartPicker
            label="Set or clear"
            value={mode}
            options={[
              { value: "relative", label: "to", description: "Some days from today" },
              { value: "date", label: "on", description: "A date you pick" },
              { value: "clear", label: "clear it" },
            ]}
            onChange={(v) => onChange(v === "relative" ? portfolioActionDefaults("set_due_date") : { type: a.type, mode: v })}
            variant="chip"
          />
          {mode === "date" ? <RuleDateInput label="Due date" value={a.date} onChange={(v) => onChange(v ? { ...a, date: v } : omit(a, "date"))} /> : null}
          {mode === "relative" ? (
            <>
              <NumberInput label="Days" value={whole(a.days)} min={-365} max={365} onChange={(n) => onChange({ ...a, days: n })} />
              <SmartPicker
                label="Days or business days"
                value={a.business_days === true ? "business" : "days"}
                options={[
                  { value: "days", label: "days" },
                  { value: "business", label: "business days" },
                ]}
                onChange={(v) => onChange({ ...a, business_days: v === "business" })}
                variant="chip"
              />
              <span className="text-zinc-600">from today</span>
            </>
          ) : null}
        </Row>
      );
    }
    case "set_name":
      return (
        <div className="w-full space-y-1">
          <TextInput label="New name" value={a.name} wide onChange={(v) => onChange({ ...a, name: v })} />
          <p className="text-xs text-zinc-500">{PLACEHOLDER_HINT}</p>
        </div>
      );
    case "set_field":
      return (
        <Row>
          <FieldPicker ctx={ctx} value={a.field_id} onChange={(v) => onChange({ type: a.type, field_id: v })} />
          <FieldValue ctx={ctx} fieldId={a.field_id} value={a.value} onChange={(v) => onChange({ ...a, value: v })} />
        </Row>
      );
    case "add_members":
    case "remove_members":
      return (
        <Row>
          <SmartPicker multiple label="People" value={strings(a.people)} options={peopleOptions(ctx, false)} onChange={(v) => onChange({ ...a, people: v })} variant="chip" placeholder="choose people" searchable />
          {a.type === "add_members" ? (
            <>
              <span className="text-zinc-600">as</span>
              <SmartPicker label="Role" value={str(a.role) || "editor"} options={MEMBER_ROLES.map((r) => ({ ...r }))} onChange={(v) => onChange({ ...a, role: v })} variant="chip" />
            </>
          ) : null}
        </Row>
      );
    case "add_to_portfolio":
      return (
        <SmartPicker
          label="Portfolio"
          value={str(a.portfolio_id) || null}
          options={ctx.otherPortfolios.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(v) => onChange({ ...a, portfolio_id: v })}
          variant="chip"
          placeholder="choose portfolio"
          emptyText="You don’t edit another portfolio"
        />
      );
    default:
      return null;
  }
}

export function PortfolioRuleBuilder({
  portfolioId,
  rule,
  runs,
  ctx,
  canEdit,
}: {
  portfolioId: string;
  rule: PortfolioRuleDef | null;
  runs: PortfolioRuleRun[];
  ctx: PortfolioRuleContext;
  canEdit: boolean;
}) {
  const router = useRouter();
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const back = `/portfolios/${portfolioId}/rules`;
  const [name, setName] = useState(rule?.name ?? "");
  const [enabled, setEnabled] = useState(rule ? rule.enabled : true);
  const [ownerId, setOwnerId] = useState<string | null>(rule?.ownerId ?? null);
  const [triggerType, setTriggerType] = useState<PortfolioTriggerType>(rule?.triggerType ?? "status_changed");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, Json>>(rule?.triggerConfig ?? {});
  const [conditions, setConditions] = useState<PortfolioRuleItem[]>(rule?.conditions ?? []);
  const [actions, setActions] = useState<PortfolioRuleItem[]>(rule?.actions ?? [{ type: "status_reminder" }]);

  const draft = { triggerType, triggerConfig, conditions, actions };
  const owner = ownerId ? ctx.members.find((m) => m.id === ownerId) : null;

  function save() {
    if (!name.trim()) {
      notify("Give the rule a name");
      return;
    }
    if (actions.length === 0) {
      notify("Add at least one action");
      return;
    }
    run(async () => {
      const input = {
        name,
        enabled,
        triggerType,
        triggerConfig,
        conditions,
        actions,
        ownerId,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      const result = rule ? await updatePortfolioRule(rule.id, input) : await createPortfolioRule(portfolioId, input);
      if (!result.error) {
        notify(rule ? "Rule saved" : enabled ? "Rule created and on" : "Rule created (off)");
        router.push(back);
      }
      return result;
    });
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-gutter py-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={back} aria-label="Back to rules" data-tooltip="Back to rules" className="btn-icon">
          <ArrowLeft className="size-4" />
        </Link>
        <label htmlFor="portfolio-rule-name" className="sr-only">
          Rule name
        </label>
        <input
          id="portfolio-rule-name"
          value={name}
          readOnly={!canEdit}
          maxLength={200}
          placeholder="Untitled rule"
          onChange={(e) => setName(e.currentTarget.value)}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-base font-semibold text-zinc-900 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
        />
        <SmartPicker
          label={`Owner: ${owner?.name ?? (ownerId ? "someone removed" : rule ? "the rule’s creator" : "you")}`}
          value={ownerId}
          options={ctx.members.map((m) => ({ value: m.id, label: m.name, icon: <Avatar name={m.name} /> }))}
          onChange={setOwnerId}
          variant="ghost"
          searchable
          disabled={!canEdit}
          className="h-8 max-w-48 px-1.5"
          renderValue={() => (
            <>
              {owner ? <Avatar name={owner.name} /> : <UserRound className="size-4" aria-hidden />}
              <span className="hidden truncate md:inline">{owner?.name ?? (rule ? "Creator" : "You")}</span>
            </>
          )}
        />
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" role="switch" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.currentTarget.checked)} className="peer sr-only" />
          <span
            aria-hidden
            className="relative inline-block h-5 w-9 rounded-full bg-zinc-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent-500 peer-checked:after:translate-x-4 peer-disabled:opacity-60 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500"
          />
          {enabled ? "Active" : "Off"}
        </label>
        {canEdit ? (
          <button type="button" onClick={save} disabled={pending} className="btn-primary h-8 px-3">
            {pending ? "Saving…" : rule ? "Save" : "Create rule"}
          </button>
        ) : null}
      </div>

      <div className="rounded-xl border border-accent-100 bg-accent-50/60 px-4 py-3">
        <p className="text-2xs font-semibold uppercase tracking-wide text-accent-700">Summary</p>
        <p className="mt-1 text-sm text-zinc-800" aria-live="polite">
          {sentence(draft, ctx)}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          Projects in <span className="font-medium text-zinc-700">{ctx.portfolioName}</span>. Actions use the owner’s access: they can only do what the
          owner could do by hand.
        </p>
      </div>

      <fieldset disabled={!canEdit} className="m-0 rounded-xl border border-zinc-200 bg-white p-0 shadow-sm">
        <SentenceRow word="When">
          <Row>
            <SmartPicker
              label="Trigger"
              value={triggerType}
              options={vocab(PORTFOLIO_TRIGGERS)}
              onChange={(v) => {
                setTriggerType(v as PortfolioTriggerType);
                setTriggerConfig(v === "scheduled" ? { frequency: "weekly", weekdays: [ctx.workWeek?.[0] ?? 0], hour: 9 } : {});
              }}
              variant="chip"
              searchable
              panelWidth={340}
            />
            <TriggerSettings triggerType={triggerType} config={triggerConfig} ctx={ctx} onChange={setTriggerConfig} />
          </Row>
        </SentenceRow>
        <SentenceRow word="If">
          {conditions.length === 0 ? <p className="pt-1 text-xs text-zinc-500">Every project (no conditions).</p> : null}
          {conditions.map((c, i) => (
            <Row key={i}>
              {i > 0 ? <span className="text-xs font-semibold text-zinc-400">and</span> : null}
              <SmartPicker
                label={`Condition ${i + 1}`}
                value={c.type}
                options={vocab(PORTFOLIO_CONDITIONS)}
                onChange={(v) => setConditions(conditions.map((x, j) => (j === i ? portfolioConditionDefaults(v as PortfolioConditionType) : x)))}
                variant="chip"
                searchable
              />
              <ConditionSettings c={c} ctx={ctx} onChange={(next) => setConditions(conditions.map((x, j) => (j === i ? next : x)))} />
              {canEdit ? (
                <button type="button" aria-label={`Remove condition ${i + 1}`} data-tooltip="Remove condition" onClick={() => setConditions(conditions.filter((_, j) => j !== i))} className="btn-icon size-6">
                  <X className="size-3.5" />
                </button>
              ) : null}
            </Row>
          ))}
          {canEdit && conditions.length < 20 ? (
            <SmartPicker
              label="Add condition"
              value={null}
              options={vocab(PORTFOLIO_CONDITIONS)}
              onChange={(v) => setConditions([...conditions, portfolioConditionDefaults(v as PortfolioConditionType)])}
              variant="ghost"
              searchable
              className="h-6 self-start px-1.5 text-xs"
              renderValue={() => (
                <>
                  <Plus className="size-3.5" aria-hidden />
                  {conditions.length ? "And…" : "Add condition"}
                </>
              )}
            />
          ) : null}
        </SentenceRow>
        <SentenceRow word="Then">
          <ol className="flex flex-col gap-2">
            {actions.map((a, i) => (
              <li key={i} className="flex flex-col gap-1">
                <Row>
                  <span className="w-4 text-xs font-medium tabular-nums text-zinc-400">{i + 1}.</span>
                  <SmartPicker
                    label={`Action ${i + 1}`}
                    value={a.type}
                    options={vocab(PORTFOLIO_ACTIONS)}
                    onChange={(v) => setActions(actions.map((x, j) => (j === i ? portfolioActionDefaults(v as PortfolioActionType) : x)))}
                    variant="chip"
                    searchable
                    panelWidth={340}
                  />
                  <ActionSettings a={a} ctx={ctx} onChange={(next) => setActions(actions.map((x, j) => (j === i ? next : x)))} />
                  {canEdit ? (
                    <button
                      type="button"
                      aria-label={`Remove action ${i + 1}`}
                      data-tooltip="Remove action"
                      disabled={actions.length === 1}
                      onClick={() => setActions(actions.filter((_, j) => j !== i))}
                      className="btn-icon size-6"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                </Row>
                <span className="sr-only">{describePortfolioAction(a, ctx)}</span>
              </li>
            ))}
          </ol>
          {canEdit && actions.length < 10 ? (
            <SmartPicker
              label="Add action"
              value={null}
              options={vocab(PORTFOLIO_ACTIONS)}
              onChange={(v) => setActions([...actions, portfolioActionDefaults(v as PortfolioActionType)])}
              variant="ghost"
              searchable
              panelWidth={340}
              className="h-6 self-start px-1.5 text-xs"
              renderValue={() => (
                <>
                  <Plus className="size-3.5" aria-hidden />
                  Then…
                </>
              )}
            />
          ) : null}
        </SentenceRow>
      </fieldset>

      {rule ? (
        <section aria-label="Activity">
          <h3 className="mb-2 text-sm font-semibold text-zinc-900">Activity</h3>
          <RunLog runs={runs} />
        </section>
      ) : null}
    </div>
  );
}
