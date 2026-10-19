"use client";

import Link from "next/link";
import { useOptimistic, useState } from "react";
import { GitBranch, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { useCan } from "@/components/project/project-access";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { deleteRule, installRulePreset, setRuleEnabled } from "@/lib/actions";
import { runReason, type RuleDef, type RulePreset, type RuleRun } from "@/lib/rules";
import type { Json } from "@/lib/supabase/database.types";
import {
  FieldSelect,
  PersonSelect,
  SectionSelect,
  describeBranches,
  describeTrigger,
  inputClass,
  labelClass,
  ruleFields,
  type RuleContext,
} from "./rule-shared";
import { EmptyState } from "@/components/ui";

const RUN_STATUS: Record<RuleRun["status"], string> = {
  succeeded: "bg-green-100 text-green-800",
  scheduled: "bg-blue-100 text-blue-800",
  skipped: "bg-zinc-100 text-zinc-600",
  failed: "bg-red-100 text-red-800",
};

// "Task moves into Review" → "task moves into Review" (names, "AM" / "PM" keep their case).
function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

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
  const canEdit = useCan("admin");
  const [optimisticRules, setOptimistic] = useOptimistic(rules, (current, patch: { id: string; enabled: boolean }) =>
    current.map((r) => (r.id === patch.id ? { ...r, enabled: patch.enabled } : r)),
  );
  const ruleNames = new Map(rules.map((r) => [r.id, r.name] as const));
  const base = `/projects/${projectId}`;

  return (
    <div className="mx-auto max-w-3xl px-gutter py-5">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-sm text-zinc-600">
          Rules react to changes in this project: when something happens, check conditions (with Else if branches),
          then run actions in order. Rules never trigger themselves, chains stop after five rules, and Status fields
          always follow the section.
        </p>
        {canEdit ? (
          <Link href={`${base}/rules/new`} className="btn-primary h-8 px-3">
            <Plus className="size-4" aria-hidden />
            Add rule
          </Link>
        ) : null}
      </div>

      <h2 className="mt-6 text-sm font-semibold text-zinc-900">Rules</h2>
      {optimisticRules.length === 0 ? (
        <div className="mt-3">
          <EmptyState icon={Workflow} title="No rules yet" size="inline">
            Start from a template below or build one on the rule canvas.
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200" aria-label="Rules">
          {optimisticRules.map((rule) => {
            const flow = describeBranches(rule, context);
            return (
              <li key={rule.id} className="flex items-start gap-3 px-4 py-3">
                <label className="mt-0.5 flex items-center" data-tooltip={rule.enabled ? "Turn off" : "Turn on"}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`${rule.name} on`}
                    checked={rule.enabled}
                    disabled={pending || !canEdit}
                    onChange={(e) => {
                      const enabled = e.currentTarget.checked;
                      run(() => setRuleEnabled(rule.id, enabled), () => setOptimistic({ id: rule.id, enabled }));
                    }}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden
                    className="relative inline-block h-5 w-9 rounded-full bg-zinc-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent-500 peer-checked:after:translate-x-4 peer-disabled:opacity-60 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500"
                  />
                </label>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-900">
                    <Link href={`${base}/rules/${rule.id}`} className="hover:underline">
                      {rule.name}
                    </Link>
                    {rule.presetKey ? (
                      <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-2xs font-normal text-zinc-600">template</span>
                    ) : null}
                    {flow.length > 1 ? (
                      <span className="ml-2 inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-2xs font-normal text-zinc-600">
                        <GitBranch className="size-3" aria-hidden />
                        {flow.length} branches
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-sm text-zinc-600">
                    <span className="font-medium text-zinc-700">When</span> {lowerFirst(describeTrigger(rule, context))}
                    {flow.length === 1 ? (
                      <>
                        {flow[0].conditions ? (
                          <>
                            , <span className="font-medium text-zinc-700">if</span> {flow[0].conditions}
                          </>
                        ) : null}
                        , <span className="font-medium text-zinc-700">then</span> {flow[0].actions}.
                      </>
                    ) : (
                      ":"
                    )}
                  </p>
                  {flow.length > 1 ? (
                    <ul className="mt-1 space-y-0.5 text-sm text-zinc-600">
                      {flow.map((branch, i) => (
                        <li key={i}>
                          <span className="font-medium text-zinc-700">{branch.label}</span>
                          {branch.conditions ? ` ${branch.conditions}` : ""}, <span className="font-medium text-zinc-700">then</span>{" "}
                          {branch.actions}.
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <Link
                  href={`${base}/rules/${rule.id}`}
                  aria-label={`${canEdit ? "Edit" : "Open"} ${rule.name}`}
                  data-tooltip={canEdit ? "Edit rule" : "Open rule"}
                  className="btn-icon"
                >
                  <Pencil className="size-4" />
                </Link>
                {canEdit ? (
                  <button
                    type="button"
                    aria-label={`Delete ${rule.name}`}
                    data-tooltip="Delete rule"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Delete the rule “${rule.name}”?`)) run(() => deleteRule(rule.id));
                    }}
                    className="btn-icon hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="size-4" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <section aria-labelledby="rule-templates" className="mt-8" id="templates">
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
                  <span className={`rounded px-1.5 py-0.5 text-2xs font-medium ${RUN_STATUS[r.status]}`}>{r.status}</span>
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
                  <SectionSelect id={id} label={input.label} value={inputs[input.key]} ctx={ctx} onChange={set} variant="control" />
                ) : input.kind === "field" ? (
                  <FieldSelect id={id} label={input.label} value={inputs[input.key]} fields={ruleFields(ctx)} onChange={set} variant="control" />
                ) : input.kind === "person" ? (
                  <PersonSelect id={id} label={input.label} value={inputs[input.key]} ctx={ctx} onChange={set} variant="control" />
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
              className="rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600 disabled:opacity-50"
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
