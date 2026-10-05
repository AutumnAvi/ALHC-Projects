"use client";

import Link from "next/link";
import { useOptimistic, useState } from "react";
import { Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { deleteRule, installRulePreset, setRuleEnabled } from "@/lib/actions";
import { runReason, type RuleDef, type RulePreset, type RuleRun } from "@/lib/rules";
import type { Json } from "@/lib/supabase/database.types";
import { RuleEditor } from "./rule-editor";
import {
  FieldSelect,
  PersonSelect,
  SectionSelect,
  describeAction,
  describeCondition,
  describeTrigger,
  inputClass,
  labelClass,
  ruleFields,
  type RuleContext,
} from "./rule-shared";

const RUN_STATUS: Record<RuleRun["status"], string> = {
  succeeded: "bg-green-100 text-green-800",
  scheduled: "bg-blue-100 text-blue-800",
  skipped: "bg-zinc-100 text-zinc-600",
  failed: "bg-red-100 text-red-800",
};

export function RulesView({
  projectId,
  rules,
  runs,
  presets,
  context,
}: {
  projectId: string;
  rules: RuleDef[];
  runs: RuleRun[];
  presets: RulePreset[];
  context: RuleContext;
}) {
  const [pending, run] = useServerAction();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [optimisticRules, setOptimistic] = useOptimistic(rules, (current, patch: { id: string; enabled: boolean }) =>
    current.map((r) => (r.id === patch.id ? { ...r, enabled: patch.enabled } : r)),
  );
  const ruleNames = new Map(rules.map((r) => [r.id, r.name] as const));

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <p className="text-sm text-zinc-600">
        Rules react to changes in this project: when something happens, check conditions, then run actions in order.
        Rules never trigger themselves, chains stop after five rules, and Status fields always follow the section.
      </p>

      <div className="mt-6 flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold text-zinc-900">Rules</h2>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
        >
          <Plus className="size-4" aria-hidden />
          New rule
        </button>
      </div>

      {editing === "new" ? (
        <div className="mt-3">
          <RuleEditor projectId={projectId} rule={null} ctx={context} onDone={() => setEditing(null)} />
        </div>
      ) : null}

      {optimisticRules.length === 0 && editing !== "new" ? (
        <div className="mt-3 rounded-md border border-dashed border-zinc-300 px-4 py-8 text-center">
          <Workflow className="mx-auto size-6 text-zinc-300" aria-hidden />
          <p className="mt-2 text-sm text-zinc-500">No rules yet. Start from a template below or build one.</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-3" aria-label="Rules">
          {optimisticRules.map((rule) =>
            editing === rule.id ? (
              <li key={rule.id}>
                <RuleEditor projectId={projectId} rule={rule} ctx={context} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={rule.id} className="rounded-lg border border-zinc-200 p-4">
                <div className="flex items-start gap-3">
                  <label className="mt-0.5 flex items-center" title={rule.enabled ? "Turn off" : "Turn on"}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`${rule.name} enabled`}
                      checked={rule.enabled}
                      disabled={pending}
                      onChange={(e) => {
                        const enabled = e.currentTarget.checked;
                        run(() => setRuleEnabled(rule.id, enabled), () => setOptimistic({ id: rule.id, enabled }));
                      }}
                      className="peer sr-only"
                    />
                    <span
                      aria-hidden
                      className="relative inline-block h-5 w-9 rounded-full bg-zinc-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent-600 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500"
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900">
                      {rule.name}
                      {rule.presetKey ? (
                        <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-normal text-zinc-600">
                          template
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-sm text-zinc-600">
                      <span className="font-medium text-zinc-700">When</span> {describeTrigger(rule, context).toLowerCase()}
                      {rule.conditions.length ? (
                        <>
                          , <span className="font-medium text-zinc-700">if</span>{" "}
                          {rule.conditions.map((c) => describeCondition(c, context)).join(" and ")}
                        </>
                      ) : null}
                      , <span className="font-medium text-zinc-700">then</span>{" "}
                      {rule.actions.map((a) => describeAction(a, context)).join(", then ")}.
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Edit ${rule.name}`}
                    onClick={() => setEditing(rule.id)}
                    className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${rule.name}`}
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Delete the rule “${rule.name}”?`)) run(() => deleteRule(rule.id));
                    }}
                    className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      <section aria-labelledby="rule-templates" className="mt-8">
        <h2 id="rule-templates" className="text-sm font-semibold text-zinc-900">
          Templates
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Templates install as ordinary rules in this project. Fill in the blanks; nothing is preset to a specific team.
        </p>
        <ul className="mt-3 space-y-3">
          {presets.map((preset) => (
            <PresetCard key={preset.key} projectId={projectId} preset={preset} ctx={context} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="rule-runs" className="mt-8">
        <h2 id="rule-runs" className="text-sm font-semibold text-zinc-900">
          Recent runs
        </h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">Nothing has run yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-100 rounded-lg border border-zinc-200 text-sm">
            {runs.map((r) => {
              const reason = runReason(r.detail);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${RUN_STATUS[r.status]}`}>{r.status}</span>
                  <span className="font-medium text-zinc-800">{ruleNames.get(r.ruleId) ?? "Deleted rule"}</span>
                  {r.taskId ? (
                    <Link href={`/projects/${projectId}/list?task=${r.taskId}`} className="min-w-0 truncate text-zinc-600 hover:underline">
                      {r.taskTitle}
                    </Link>
                  ) : null}
                  {reason ? <span className="text-xs text-zinc-500">· {reason}</span> : null}
                  <span className="ml-auto text-xs text-zinc-400">
                    <Timestamp iso={r.createdAt} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function PresetCard({ projectId, preset, ctx }: { projectId: string; preset: RulePreset; ctx: RuleContext }) {
  const [pending, run] = useServerAction();
  const [open, setOpen] = useState(false);
  const [enable, setEnable] = useState(false);
  const [inputs, setInputs] = useState<Record<string, Json>>(() =>
    Object.fromEntries(preset.inputs.filter((i) => i.default !== undefined).map((i) => [i.key, i.default as Json])),
  );
  const missing = preset.inputs.some((i) => inputs[i.key] === undefined || inputs[i.key] === "");
  const prefix = `preset-${preset.key}`;

  return (
    <li className="rounded-lg border border-zinc-200 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-900">
            {preset.name}
            {preset.ruleCount > 1 ? <span className="ml-2 text-xs font-normal text-zinc-500">{preset.ruleCount} rules</span> : null}
          </p>
          <p className="mt-1 text-sm text-zinc-600">{preset.description}</p>
        </div>
        {!open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md border border-zinc-200 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            Use template
          </button>
        ) : null}
      </div>
      {open ? (
        <form
          className="mt-3 space-y-3 border-t border-zinc-100 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const result = await installRulePreset(projectId, preset.key, inputs, enable);
              if (!result.error) setOpen(false);
              return result;
            });
          }}
        >
          {preset.inputs.map((input) => {
            const id = `${prefix}-${input.key}`;
            const set = (value: Json) => setInputs((current) => ({ ...current, [input.key]: value }));
            return (
              <div key={input.key} className="flex flex-col gap-1">
                <label htmlFor={id} className={labelClass}>
                  {input.label}
                </label>
                {input.kind === "section" ? (
                  <SectionSelect id={id} label={input.label} value={inputs[input.key]} ctx={ctx} onChange={set} />
                ) : input.kind === "field" ? (
                  <FieldSelect id={id} label={input.label} value={inputs[input.key]} fields={ruleFields(ctx)} onChange={set} />
                ) : input.kind === "person" ? (
                  <PersonSelect id={id} label={input.label} value={inputs[input.key]} ctx={ctx} onChange={set} />
                ) : input.kind === "number" ? (
                  <input
                    id={id}
                    type="number"
                    min={0}
                    value={typeof inputs[input.key] === "number" ? (inputs[input.key] as number) : ""}
                    onChange={(e) => set(e.currentTarget.value === "" ? "" : Number(e.currentTarget.value))}
                    className={`${inputClass} w-28`}
                  />
                ) : (
                  <input
                    id={id}
                    value={typeof inputs[input.key] === "string" ? (inputs[input.key] as string) : ""}
                    maxLength={1000}
                    onChange={(e) => set(e.currentTarget.value)}
                    className={`${inputClass} w-full`}
                  />
                )}
              </div>
            );
          })}
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.currentTarget.checked)} />
            Turn on right away
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={pending || missing}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              Install
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
