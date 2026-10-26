"use client";

// My Tasks rules (Automations V3, batch E): a "Rules" button on My tasks opens the person's own rules —
// when a task is assigned to me / is due soon / is overdue, (if …), move it to one of my sections, set
// its due date, or complete it — built as a sentence with the searchable pickers.

import { useState } from "react";
import { FolderClosed, Pencil, Plus, Trash2, X, Zap } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useConfirm } from "@/components/confirm";
import { ParamSlot, StepParams, StepPrompt, useParamSlot } from "@/components/param-slot";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import { MISSING_INPUT } from "@/components/rules/rule-shared";
import { useNotify, useServerAction } from "@/components/toast";
import { deleteMyTaskRule, saveMyTaskRule, setMyTaskRuleEnabled } from "@/lib/actions";
import {
  MY_TASK_ACTIONS,
  MY_TASK_CONDITIONS,
  MY_TASK_TRIGGERS,
  myTaskRuleSentence,
  type MyTaskAction,
  type MyTaskCondition,
  type MyTaskRule,
  type MyTaskRuleContext,
  type MyTaskRuleItem,
  type MyTaskTrigger,
} from "@/lib/my-task-rules";
import { missingParams, ruleProblems, saveBlockedReason, stepProblems, type StepScope } from "@/lib/rule-params";
import type { Json } from "@/lib/supabase/database.types";

const TRIGGER_SCOPE: StepScope = { system: "my_tasks", kind: "trigger" };
const CONDITION_SCOPE: StepScope = { system: "my_tasks", kind: "condition" };
const ACTION_SCOPE: StepScope = { system: "my_tasks", kind: "action" };

// The keys a step is still missing (its editors are highlighted).
function missingKeys(step: MyTaskRuleItem, scope: StepScope) {
  return missingParams(step, scope).map((p) => p.key);
}

const INPUT = "control h-auto min-h-7 py-0.5";

const vocab = (list: readonly { value: string; label: string; description?: string; keywords?: readonly string[] }[]): SmartOption[] =>
  list.map((x) => ({ value: x.value, label: x.label, description: x.description, keywords: x.keywords }));

const whole = (v: Json | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
const strings = (v: Json | undefined) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function conditionDefaults(type: MyTaskCondition): MyTaskRuleItem {
  if (type === "in_project" || type === "not_in_project") return { type, project_ids: [] };
  if (type === "due_within") return { type, days: 3 };
  if (type === "task_type_is") return { type, kind: "task" };
  return { type };
}

function actionDefaults(type: MyTaskAction, ctx: MyTaskRuleContext): MyTaskRuleItem {
  if (type === "move_to_section") return { type, section_id: ctx.sections[0]?.id ?? "" };
  if (type === "set_due_date") return { type, days: 1, business_days: true };
  return { type };
}

function DaysInput({ label, value, min, max, onChange }: { label: string; value: number | null; min: number; max: number; onChange: (n: number) => void }) {
  const slot = useParamSlot<number>(onChange);
  const missing = slot.missing && value === null;
  return (
    <input
      type="number"
      aria-label={label}
      aria-invalid={missing || undefined}
      min={min}
      max={max}
      value={value ?? ""}
      onChange={(e) => {
        const n = Number(e.currentTarget.value);
        if (e.currentTarget.value !== "" && Number.isFinite(n)) onChange(Math.min(Math.max(Math.trunc(n), min), max));
      }}
      className={`${INPUT} w-16 ${missing ? MISSING_INPUT : ""}`}
    />
  );
}

export function MyTaskRulesButton({ rules, ctx }: { rules: MyTaskRule[] | null; ctx: MyTaskRuleContext }) {
  const [open, setOpen] = useState(false);
  const count = rules?.filter((r) => r.enabled).length ?? 0;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary" data-tooltip="Your own rules for tasks assigned to you">
        <Zap className="size-4" aria-hidden />
        Rules{count ? ` (${count})` : ""}
      </button>
      {open ? <MyTaskRulesDialog rules={rules} ctx={ctx} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function MyTaskRulesDialog({ rules, ctx, onClose }: { rules: MyTaskRule[] | null; ctx: MyTaskRuleContext; onClose: () => void }) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<MyTaskRule | "new" | null>(null);

  return (
    <Dialog title="My tasks rules" description="Only you see these. They act on tasks assigned to you, with your access." onClose={onClose} width="max-w-2xl">
      {rules === null ? (
        <p className="text-sm text-zinc-600">My Tasks rules need this release’s database update.</p>
      ) : editing ? (
        <MyTaskRuleEditor rule={editing === "new" ? null : editing} ctx={ctx} onDone={() => setEditing(null)} />
      ) : (
        <div className="flex flex-col gap-3">
          {rules.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-500">
              No rules yet. For example: when a task is due tomorrow, move it to Do today.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
              {rules.map((rule) => (
                <li key={rule.id} className="flex items-start gap-3 px-3 py-2.5">
                  <label className="mt-0.5 flex items-center">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`${rule.name}: ${rule.enabled ? "on" : "off"}`}
                      checked={rule.enabled}
                      disabled={pending}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        run(() => setMyTaskRuleEnabled(rule.id, on));
                      }}
                      className="peer sr-only"
                    />
                    <span
                      aria-hidden
                      className="relative inline-block h-5 w-9 rounded-full bg-zinc-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent-500 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500"
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900">{rule.name}</p>
                    <p className="text-sm text-zinc-600">{myTaskRuleSentence(rule, ctx)}</p>
                  </div>
                  <button type="button" aria-label={`Edit ${rule.name}`} data-tooltip="Edit rule" onClick={() => setEditing(rule)} className="btn-icon">
                    <Pencil className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${rule.name}`}
                    data-tooltip="Delete rule"
                    disabled={pending}
                    onClick={async () => {
                      if (await confirm({ title: `Delete the rule “${rule.name}”?`, confirmLabel: "Delete", tone: "danger" })) run(() => deleteMyTaskRule(rule.id));
                    }}
                    className="btn-icon hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setEditing("new")} className="btn-secondary self-start">
            <Plus className="size-4" aria-hidden />
            Add rule
          </button>
        </div>
      )}
    </Dialog>
  );
}

// A condition's settings (which projects, how many days, which task type).
export function MyTaskConditionFields({ c, ctx, onChange }: { c: MyTaskRuleItem; ctx: MyTaskRuleContext; onChange: (next: MyTaskRuleItem) => void }) {
  const projectOptions = ctx.projects.map((p) => ({ value: p.id, label: p.name, icon: <FolderClosed className="size-4" /> }));
  return (
    <>
      {c.type === "in_project" || c.type === "not_in_project" ? (
        <ParamSlot param="project_ids">
          <SmartPicker
            multiple
            label="Projects"
            value={strings(c.project_ids)}
            options={projectOptions}
            onChange={(v) => onChange({ ...c, project_ids: v })}
            variant="chip"
            placeholder="choose projects"
            searchable
          />
        </ParamSlot>
      ) : null}
      {c.type === "due_within" ? (
        <>
          <ParamSlot param="days">
            <DaysInput label="Days" value={whole(c.days)} min={0} max={365} onChange={(n) => onChange({ ...c, days: n })} />
          </ParamSlot>
          days
        </>
      ) : null}
      {c.type === "task_type_is" ? (
        <ParamSlot param="kind">
          <SmartPicker
            label="Task type"
            value={typeof c.kind === "string" && c.kind ? c.kind : null}
            options={[
              { value: "task", label: "Task" },
              { value: "milestone", label: "Milestone" },
              { value: "approval", label: "Approval" },
            ]}
            onChange={(v) => onChange({ ...c, kind: v })}
            variant="chip"
            placeholder="choose a task type"
          />
        </ParamSlot>
      ) : null}
    </>
  );
}

// An action's settings (which of my sections, how many days).
export function MyTaskActionFields({ a, ctx, onChange }: { a: MyTaskRuleItem; ctx: MyTaskRuleContext; onChange: (next: MyTaskRuleItem) => void }) {
  const sectionOptions = ctx.sections.map((s) => ({ value: s.id, label: s.name }));
  return (
    <>
      {a.type === "move_to_section" ? (
        <ParamSlot param="section_id">
          <SmartPicker
            label="Section"
            value={typeof a.section_id === "string" && a.section_id ? a.section_id : null}
            options={sectionOptions}
            onChange={(v) => onChange({ ...a, section_id: v })}
            variant="chip"
            placeholder="choose section"
          />
        </ParamSlot>
      ) : null}
      {a.type === "set_due_date" ? (
        <>
          <ParamSlot param="days">
            <DaysInput label="Days from today" value={whole(a.days)} min={0} max={365} onChange={(n) => onChange({ ...a, days: n })} />
          </ParamSlot>
          <SmartPicker
            label="Days or business days"
            value={a.business_days === true ? "business" : "days"}
            options={[
              { value: "days", label: "days from today" },
              { value: "business", label: "business days from today" },
            ]}
            onChange={(v) => onChange({ ...a, business_days: v === "business" })}
            variant="chip"
          />
        </>
      ) : null}
    </>
  );
}

export function MyTaskRuleEditor({ rule, ctx, onDone }: { rule: MyTaskRule | null; ctx: MyTaskRuleContext; onDone: () => void }) {
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const [name, setName] = useState(rule?.name ?? "");
  const [triggerType, setTriggerType] = useState<MyTaskTrigger>(rule?.triggerType ?? "due_approaching");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, Json>>(rule?.triggerConfig ?? { days: 1 });
  const [conditions, setConditions] = useState<MyTaskRuleItem[]>(rule?.conditions ?? []);
  const [actions, setActions] = useState<MyTaskRuleItem[]>(
    rule?.actions ?? [actionDefaults("move_to_section", ctx)],
  );
  const days = whole(triggerConfig.days);
  // Every step's settings (rule-params.ts): Save waits until nothing required is missing.
  const problems = ruleProblems({ triggerType, triggerConfig, conditions, actions }, "my_tasks");
  const blocked = saveBlockedReason(problems);

  function save() {
    if (!name.trim()) {
      notify("Give the rule a name");
      return;
    }
    if (blocked) {
      notify(blocked);
      return;
    }
    run(async () => {
      const result = await saveMyTaskRule(rule?.id ?? null, {
        name,
        enabled: rule?.enabled ?? true,
        triggerType,
        triggerConfig,
        conditions,
        actions,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (!result.error) {
        notify(rule ? "Rule saved" : "Rule created");
        onDone();
      }
      return result;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
        Name
        <input value={name} maxLength={200} onChange={(e) => setName(e.currentTarget.value)} placeholder="Due tomorrow → Do today" className="field" />
      </label>
      <p className="rounded-lg bg-accent-50/60 px-3 py-2 text-sm text-zinc-800" aria-live="polite">
        {myTaskRuleSentence({ triggerType, triggerConfig, conditions, actions }, ctx)}
      </p>
      <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 text-sm text-zinc-700">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-12 text-xs font-semibold uppercase tracking-wide text-zinc-500">When</span>
          <SmartPicker
            label="Trigger"
            value={triggerType}
            options={vocab(MY_TASK_TRIGGERS)}
            onChange={(v) => {
              setTriggerType(v as MyTaskTrigger);
              setTriggerConfig(v === "assigned" ? {} : { days: 1 });
            }}
            variant="chip"
          />
          <StepParams missing={missingKeys({ type: triggerType, ...triggerConfig }, TRIGGER_SCOPE)}>
          {triggerType !== "assigned" ? (
            <>
              <ParamSlot param="days">
                <DaysInput
                  label="Days"
                  value={days ?? 1}
                  min={triggerType === "task_overdue" ? 1 : 0}
                  max={60}
                  onChange={(n) => setTriggerConfig({ ...triggerConfig, days: n })}
                />
              </ParamSlot>
              {triggerType === "due_approaching" ? "days before it’s due" : "days after it’s due"}
            </>
          ) : null}
          </StepParams>
          <StepPrompt problems={stepProblems({ type: triggerType, ...triggerConfig }, TRIGGER_SCOPE)} />
        </div>
        <div className="flex flex-col gap-1.5">
          {conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <span className="w-12 text-xs font-semibold uppercase tracking-wide text-zinc-500">{i === 0 ? "If" : "And"}</span>
              <SmartPicker
                label={`Condition ${i + 1}`}
                value={c.type}
                options={vocab(MY_TASK_CONDITIONS)}
                onChange={(v) => setConditions(conditions.map((x, j) => (j === i ? conditionDefaults(v as MyTaskCondition) : x)))}
                variant="chip"
              />
              <StepParams missing={missingKeys(c, CONDITION_SCOPE)}>
                <MyTaskConditionFields c={c} ctx={ctx} onChange={(next) => setConditions(conditions.map((x, j) => (j === i ? next : x)))} />
              </StepParams>
              <StepPrompt problems={stepProblems(c, CONDITION_SCOPE)} />
              <button type="button" aria-label={`Remove condition ${i + 1}`} data-tooltip="Remove condition" onClick={() => setConditions(conditions.filter((_, j) => j !== i))} className="btn-icon size-6">
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {conditions.length < 10 ? (
            <SmartPicker
              label="Add condition"
              value={null}
              options={vocab(MY_TASK_CONDITIONS)}
              onChange={(v) => setConditions([...conditions, conditionDefaults(v as MyTaskCondition)])}
              variant="ghost"
              className="h-6 self-start px-1.5 text-xs"
              renderValue={() => (
                <>
                  <Plus className="size-3.5" aria-hidden />
                  {conditions.length ? "And…" : "Add condition"}
                </>
              )}
            />
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          {actions.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <span className="w-12 text-xs font-semibold uppercase tracking-wide text-zinc-500">{i === 0 ? "Then" : "And"}</span>
              <SmartPicker
                label={`Action ${i + 1}`}
                value={a.type}
                options={vocab(MY_TASK_ACTIONS)}
                onChange={(v) => setActions(actions.map((x, j) => (j === i ? actionDefaults(v as MyTaskAction, ctx) : x)))}
                variant="chip"
              />
              <StepParams missing={missingKeys(a, ACTION_SCOPE)}>
                <MyTaskActionFields a={a} ctx={ctx} onChange={(next) => setActions(actions.map((x, j) => (j === i ? next : x)))} />
              </StepParams>
              <StepPrompt problems={stepProblems(a, ACTION_SCOPE)} />
              <button
                type="button"
                aria-label={`Remove action ${i + 1}`}
                data-tooltip="Remove action"
                disabled={actions.length === 1}
                onClick={() => setActions(actions.filter((_, j) => j !== i))}
                className="btn-icon size-6"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {actions.length < 5 ? (
            <SmartPicker
              label="Add action"
              value={null}
              options={vocab(MY_TASK_ACTIONS)}
              onChange={(v) => setActions([...actions, actionDefaults(v as MyTaskAction, ctx)])}
              variant="ghost"
              className="h-6 self-start px-1.5 text-xs"
              renderValue={() => (
                <>
                  <Plus className="size-3.5" aria-hidden />
                  Then…
                </>
              )}
            />
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {blocked ? (
          <span id="my-task-rule-save-blocked" role="status" className="mr-auto text-xs text-amber-800" title={problems.join("\n")}>
            {blocked}
          </span>
        ) : null}
        <button type="button" onClick={onDone} className="btn-secondary">
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending || Boolean(blocked)}
          aria-describedby={blocked ? "my-task-rule-save-blocked" : undefined}
          className="btn-primary"
        >
          {pending ? "Saving…" : rule ? "Save" : "Create rule"}
        </button>
      </div>
    </div>
  );
}
