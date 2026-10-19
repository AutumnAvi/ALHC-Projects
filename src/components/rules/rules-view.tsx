"use client";

import Link from "next/link";
import { Fragment, useId, useOptimistic, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronRight, GitBranch, Pencil, Play, Plus, Search, Trash2, Workflow } from "lucide-react";
import { useCan } from "@/components/project/project-access";
import { Segmented } from "@/components/project/view-chrome";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { deleteRule, installRulePreset, setRuleEnabled } from "@/lib/actions";
import { runSteps } from "@/lib/rule-steps";
import { runReason, type RuleDef, type RulePreset, type RuleRun, type RuleRunStats } from "@/lib/rules";
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
import { RuleTemplatesGallery } from "./rule-templates-gallery";
import { RunSteps } from "./run-steps";

const RUN_STATUS: Record<RuleRun["status"], string> = {
  succeeded: "bg-green-100 text-green-800",
  scheduled: "bg-blue-100 text-blue-800",
  skipped: "bg-zinc-100 text-zinc-600",
  failed: "bg-red-100 text-red-800",
};

type RuleFilter = "all" | "on" | "off" | "paused" | "failing";

const RULE_FILTERS: readonly { value: RuleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
  { value: "paused", label: "Paused" },
  { value: "failing", label: "Failing" },
];

type RunFilter = "all" | "failed";

const RUN_FILTERS: readonly { value: RunFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed only" },
];

// "Task moves into Review" → "task moves into Review" (names, "AM" / "PM" keep their case).
function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// Failing = a failed run in the last 7 days, or failures in a row that haven't been cleared yet.
function isFailing(rule: RuleDef, stat: RuleRunStats | undefined) {
  return (stat?.failures7d ?? 0) > 0 || (rule.consecutiveFailures ?? 0) > 0;
}

function matchesFilter(rule: RuleDef, filter: RuleFilter, stat: RuleRunStats | undefined) {
  if (filter === "on") return rule.enabled;
  if (filter === "off") return !rule.enabled;
  if (filter === "paused") return Boolean(rule.pausedAt);
  if (filter === "failing") return isFailing(rule, stat);
  return true;
}

const subscribeNever = () => () => {};

// A future time ("Next run Tue, Oct 21, 9:00 AM"): <Timestamp> words past times only. Drawn on the
// client, in the viewer's zone.
function LocalTime({ iso }: { iso: string }) {
  const ready = useSyncExternalStore(subscribeNever, () => true, () => false);
  return (
    <time dateTime={iso}>
      {ready
        ? new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : ""}
    </time>
  );
}

export function RulesView({
  projectId,
  rules,
  runs,
  stats,
  presets,
  context,
}: {
  projectId: string;
  rules: RuleDef[];
  runs: RuleRun[];
  // Each rule's health (last run, failures in the last 7 days), by rule id.
  stats?: Record<string, RuleRunStats>;
  presets: RulePreset[];
  context: RuleContext;
}) {
  const [pending, run] = useServerAction();
  const canEdit = useCan("admin");
  // Turning a rule on also clears an auto-pause (the database's guard does the same).
  const [optimisticRules, setOptimistic] = useOptimistic(rules, (current, patch: { id: string; enabled: boolean }) =>
    current.map((r) =>
      r.id === patch.id
        ? { ...r, enabled: patch.enabled, ...(patch.enabled ? { pausedAt: null, pauseReason: null, consecutiveFailures: 0 } : {}) }
        : r,
    ),
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RuleFilter>("all");
  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const ruleNames = new Map(rules.map((r) => [r.id, r.name] as const));
  const people = new Map(context.people.map((p) => [p.id, p.name] as const));
  // Without the run stats (a database before Automations V2), the newest of the recent runs.
  const latestRun = new Map<string, string>();
  for (const r of runs) if (!latestRun.has(r.ruleId)) latestRun.set(r.ruleId, r.createdAt);
  const base = `/projects/${projectId}`;

  const needle = query.trim().toLowerCase();
  const rows = optimisticRules.map((rule) => {
    const trigger = describeTrigger(rule, context);
    const flow = describeBranches(rule, context);
    const text = [rule.name, trigger, ...flow.flatMap((b) => [b.label, b.conditions, b.actions])].join(" ").toLowerCase();
    return { rule, trigger, flow, text, stat: stats?.[rule.id] };
  });
  const shown = rows.filter((row) => matchesFilter(row.rule, filter, row.stat) && (!needle || row.text.includes(needle)));
  const shownRuns = runFilter === "failed" ? runs.filter((r) => r.status === "failed") : runs;

  const setEnabled = (rule: RuleDef, enabled: boolean) =>
    run(() => setRuleEnabled(rule.id, enabled), () => setOptimistic({ id: rule.id, enabled }));

  return (
    <div className="mx-auto max-w-3xl px-gutter py-5">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-sm text-zinc-600">
          Rules react to changes in this project: when something happens, check the conditions (with Or groups and
          Otherwise branches), then run the actions in order. Rules never trigger themselves, chains stop after three
          rules, a rule that keeps failing pauses itself, and Status fields always follow the section.
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
            Start from a template below, or add a rule and build it as a sentence: when…, if…, then….
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="relative">
              <span className="sr-only">Search rules</span>
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Search rules"
                className="control w-56 pl-7"
              />
            </label>
            <span className="flex-1" />
            <Segmented label="Show rules" options={RULE_FILTERS} value={filter} onChange={setFilter} />
          </div>
          {shown.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">
              No rule matches.{" "}
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
                className="font-medium text-accent-700 hover:underline"
              >
                Show all rules
              </button>
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200" aria-label="Rules">
              {shown.map(({ rule, trigger, flow, stat }) => {
                const owner = rule.ownerId ? (people.get(rule.ownerId) ?? "someone removed") : null;
                // undefined = not known here (no stats and not among the recent runs); null = never ran.
                const lastRunAt = stat ? stat.lastRunAt : latestRun.get(rule.id);
                const failures = stat?.failures7d ?? 0;
                const nextRunAt = rule.triggerType === "scheduled" && rule.enabled ? rule.nextRunAt : null;
                const pauseTip = `Paused after five failed runs in a row${rule.pauseReason ? `: ${rule.pauseReason}` : ""}`;
                // The rule's health: who it acts for, when it last ran, failures, and a schedule's next run.
                const health: ReactNode[] = [];
                if (owner) health.push(<>Owner: {owner}</>);
                if (lastRunAt) {
                  health.push(
                    <>
                      Last run <Timestamp iso={lastRunAt} />
                    </>,
                  );
                } else if (lastRunAt === null) health.push("Hasn’t run yet");
                if (failures > 0) {
                  health.push(
                    <span className="text-red-700">
                      {failures} {failures === 1 ? "failure" : "failures"} in the last 7 days
                    </span>,
                  );
                }
                if (nextRunAt) {
                  health.push(
                    <>
                      Next run <LocalTime iso={nextRunAt} />
                    </>,
                  );
                }
                return (
                  <li key={rule.id} className="flex items-start gap-3 px-4 py-3">
                    <label className="mt-0.5 flex items-center" data-tooltip={rule.enabled ? "Turn off" : "Turn on"}>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`${rule.name} on`}
                        checked={rule.enabled}
                        disabled={pending || !canEdit}
                        onChange={(e) => setEnabled(rule, e.currentTarget.checked)}
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
                        {rule.pausedAt ? (
                          <span
                            data-tooltip={pauseTip}
                            className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-medium text-amber-800"
                          >
                            Paused
                            <span className="sr-only">: {pauseTip}</span>
                          </span>
                        ) : null}
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
                        <span className="font-medium text-zinc-700">When</span> {lowerFirst(trigger)}
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
                      {health.length ? (
                        <p className="mt-1 text-xs text-zinc-500">
                          {health.map((part, i) => (
                            <Fragment key={i}>
                              {i > 0 ? " · " : null}
                              {part}
                            </Fragment>
                          ))}
                        </p>
                      ) : null}
                    </div>
                    {rule.pausedAt && canEdit ? (
                      <button
                        type="button"
                        aria-label={`Resume ${rule.name}`}
                        data-tooltip="Turn the rule back on"
                        disabled={pending}
                        onClick={() => setEnabled(rule, true)}
                        className="btn-secondary h-7 px-2 text-xs"
                      >
                        <Play className="size-3.5" aria-hidden />
                        Resume
                      </button>
                    ) : null}
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
        </>
      )}

      <RuleTemplatesGallery projectId={projectId} ctx={context} canEdit={canEdit} />

      {presets.length ? (
        <details className="group mt-6">
          <summary className="cursor-pointer text-sm font-semibold text-zinc-900 marker:text-zinc-400">
            More templates (fill in the blanks)
          </summary>
          <p className="mt-1 text-xs text-zinc-500">
            These install as ordinary rules in this project. Fill in the blanks; nothing is preset to a specific team.
          </p>
          <ul className="mt-3 space-y-3">
            {presets.map((preset) => (
              <PresetCard key={preset.key} projectId={projectId} preset={preset} ctx={context} />
            ))}
          </ul>
        </details>
      ) : null}

      <section aria-labelledby="rule-runs" className="mt-8">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="rule-runs" className="text-sm font-semibold text-zinc-900">
            Recent runs
          </h2>
          <span className="flex-1" />
          {runs.length ? <Segmented label="Show runs" options={RUN_FILTERS} value={runFilter} onChange={setRunFilter} /> : null}
        </div>
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">Nothing has run yet.</p>
        ) : shownRuns.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No failed runs among the latest {runs.length}.</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-100 rounded-lg border border-zinc-200 text-sm">
            {shownRuns.map((r) => (
              <RunRow key={r.id} run={r} ruleName={ruleNames.get(r.ruleId) ?? null} projectId={projectId} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// One logged run; runs with steps (or an error) open to show each step.
function RunRow({ run: r, ruleName, projectId }: { run: RuleRun; ruleName: string | null; projectId: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const reason = runReason(r.detail);
  const { steps, error } = runSteps(r.detail);
  const expandable = steps.length > 0 || error !== null;
  const name = ruleName ?? "Deleted rule";

  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-label={`${open ? "Hide" : "Show"} the steps of this run of “${name}”`}
            data-tooltip={open ? "Hide steps" : "Show steps"}
            onClick={() => setOpen((o) => !o)}
            className="btn-icon size-6"
          >
            <ChevronRight className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
          </button>
        ) : (
          <span className="size-6 shrink-0" aria-hidden />
        )}
        <span className={`rounded px-1.5 py-0.5 text-2xs font-medium ${RUN_STATUS[r.status]}`}>{r.status}</span>
        <span className="font-medium text-zinc-800">{name}</span>
        {r.taskId ? (
          <Link href={`/projects/${projectId}/list?task=${r.taskId}`} className="min-w-0 truncate text-zinc-600 hover:underline">
            {r.taskTitle}
          </Link>
        ) : null}
        {reason ? <span className="text-xs text-zinc-500">· {reason}</span> : null}
        <span className="ml-auto text-xs text-zinc-400">
          <Timestamp iso={r.createdAt} />
        </span>
      </div>
      {open && expandable ? (
        <div id={panelId} className="mt-2 pl-8">
          <RunSteps steps={steps} error={error} />
        </div>
      ) : null}
    </li>
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
