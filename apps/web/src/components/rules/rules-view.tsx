"use client";

import Link from "next/link";
import { Fragment, useEffect, useId, useOptimistic, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronRight, Copy, GitBranch, History, Pencil, Play, Plus, Search, Trash2, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { SmartPicker } from "@/components/smart-picker";
import { useConfirm } from "@/components/confirm";
import { useProjectPermissions } from "@/components/project/project-access";
import { Segmented } from "@/components/project/view-chrome";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { deleteRule, duplicateRule, setRuleEnabled, setRulePausedUntil } from "@/lib/actions/automations";
import { RulePauseControls, isPausedNow } from "./rule-pause";
import { runSteps } from "@alhc/core/rule-steps";
import { RUN_TONE_CLASS, filterRuns, runFilterLabel, runOutcome, runOutcomeText, type RunFilter } from "@alhc/core/run-outcome";
import { HISTORY_LIMIT, rulesPageHref, type RulesPageView } from "@/lib/rules-page";
import { runReason, type RuleDef, type RuleRun, type RuleRunStats } from "@alhc/core/rules";
import { describeBranches, describeTrigger, type RuleContext } from "./rule-shared";
import { EmptyState } from "@/components/ui";
import { RuleTemplatesGallery } from "./rule-templates-gallery";
import { RunSteps } from "./run-steps";

type RuleFilter = "all" | "on" | "off" | "paused" | "failing";

const RULE_FILTERS: readonly { value: RuleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
  { value: "paused", label: "Paused" },
  { value: "failing", label: "Failing" },
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
  if (filter === "paused") return Boolean(rule.pausedAt) || isPausedNow(rule.pausedUntil);
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
  context,
  view = "automations",
  historyRuleId = null,
  focusRunId = null,
}: {
  projectId: string;
  rules: RuleDef[];
  runs: RuleRun[];
  // Nov 3 notes (batch 18, 137): which tab of the Automations page (?view=templates | history), and the
  // automation History is narrowed to (?rule=<id>).
  view?: RulesPageView;
  historyRuleId?: string | null;
  // Nov 11 notes (190): the run History opens at (expanded, scrolled to, highlighted): ?run=<id>.
  focusRunId?: string | null;
  // Each rule's health (last run, failures in the last 7 days), by rule id.
  stats?: Record<string, RuleRunStats>;
  context: RuleContext;
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const notify = useNotify();
  // Owners and Editors build automations (Nov 10); everyone else reads.
  const canEdit = useProjectPermissions().canBuild;
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
  const router = useRouter();
  const historyRule = historyRuleId ? (rules.find((r) => r.id === historyRuleId) ?? null) : null;
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
  // Nov 4 notes, batch 24 (157): "Needs attention" = failed, skipped, or partly ran.
  const shownRuns = filterRuns(runs, runFilter);
  const runFilters = (["all", "attention"] as const).map((value) => ({
    value,
    label: runFilterLabel(value, value === "all" ? 0 : filterRuns(runs, "attention").length),
  }));

  const setEnabled = (rule: RuleDef, enabled: boolean) =>
    run(() => setRuleEnabled(rule.id, enabled), () => setOptimistic({ id: rule.id, enabled }));

  return (
    <div className="mx-auto max-w-3xl px-gutter py-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold text-zinc-900">Automations</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Automations react to changes in this project: when something happens, they check the conditions, then run the
            actions in order. An automation never sets itself off, and one that fails five runs in a row turns itself off.
          </p>
        </div>
        {canEdit ? (
          <Link href={`${base}/rules/new`} className="btn-primary h-8 px-3">
            <Plus className="size-4" aria-hidden />
            Add automation
          </Link>
        ) : null}
      </div>

      <nav aria-label="Automations page" className="tab-strip mt-5 flex gap-4 border-b border-zinc-200">
        {(
          [
            ["automations", `Automations${optimisticRules.length ? ` (${optimisticRules.length})` : ""}`],
            ["templates", "Templates"],
            ["history", "History"],
          ] as const
        ).map(([key, label]) => (
          <Link
            key={key}
            href={rulesPageHref(projectId, key)}
            aria-current={view === key ? "page" : undefined}
            className={`-mb-px border-b-2 px-0.5 pb-2 text-sm ${
              view === key ? "border-accent-500 font-medium text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {view === "automations" ? (
      <>
      <h2 className="sr-only">Automations</h2>
      {optimisticRules.length === 0 ? (
        <div className="mt-3">
          <EmptyState icon={Workflow} title="No automations yet" size="inline">
            {canEdit ? (
              <>
                Start from one on the{" "}
                <Link href={rulesPageHref(projectId, "templates")} className="font-medium text-accent-700 hover:underline">
                  Templates
                </Link>{" "}
                tab, or add an automation and build it as a sentence: when…, if…, then….
              </>
            ) : (
              "Automations move, assign, and notify on their own when something happens in this project. Its Owners and Editors add them."
            )}
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="relative">
              <span className="sr-only">Search automations</span>
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Search automations"
                className="control w-56 pl-7"
              />
            </label>
            <span className="flex-1" />
            <Segmented label="Show automations" options={RULE_FILTERS} value={filter} onChange={setFilter} />
          </div>
          {shown.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">
              No automation matches.{" "}
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
                className="font-medium text-accent-700 hover:underline"
              >
                Show all automations
              </button>
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200" aria-label="Automations">
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
                    {/* Nov 1 notes (batch 11): below Admin the switch is hidden; the state reads as text. */}
                    {canEdit ? (
                      <label className="mt-0.5 flex items-center" data-tooltip={rule.enabled ? "Turn off" : "Turn on"}>
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label={`${rule.name} on`}
                          checked={rule.enabled}
                          disabled={pending}
                          onChange={(e) => setEnabled(rule, e.currentTarget.checked)}
                          className="peer sr-only"
                        />
                        <span
                          aria-hidden
                          className="relative inline-block h-5 w-9 rounded-full bg-zinc-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent-500 peer-checked:after:translate-x-4 peer-disabled:opacity-60 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500"
                        />
                      </label>
                    ) : (
                      <span className={`chip mt-0.5 shrink-0 ${rule.enabled ? "text-green-700" : ""}`}>{rule.enabled ? "On" : "Off"}</span>
                    )}
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
                          <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-2xs font-normal text-zinc-600">Template</span>
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
                        data-tooltip="Turn the automation back on"
                        disabled={pending}
                        onClick={() => setEnabled(rule, true)}
                        className="btn-secondary h-7 px-2 text-xs"
                      >
                        <Play className="size-3.5" aria-hidden />
                        Resume
                      </button>
                    ) : null}
                    {canEdit && rule.enabled ? (
                      <RulePauseControls
                        name={rule.name}
                        pausedUntil={rule.pausedUntil}
                        disabled={pending}
                        unavailable={context.v3 === false ? "Needs this release’s database update" : null}
                        onChange={(until) => run(() => setRulePausedUntil(rule.id, until))}
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
                            const result = await duplicateRule(rule.id);
                            if (!result.error) notify(`Created “Copy of ${rule.name}” (off until you turn it on)`);
                            return result;
                          })
                        }
                        className="btn-icon"
                      >
                        <Copy className="size-4" />
                      </button>
                    ) : null}
                    <Link
                      href={rulesPageHref(projectId, "history", rule.id)}
                      aria-label={`History of ${rule.name}`}
                      data-tooltip="Run history"
                      className="btn-icon"
                    >
                      <History className="size-4" />
                    </Link>
                    <Link
                      href={`${base}/rules/${rule.id}`}
                      aria-label={`${canEdit ? "Edit" : "Open"} ${rule.name}`}
                      data-tooltip={canEdit ? "Edit automation" : "Open automation"}
                      className="btn-icon"
                    >
                      <Pencil className="size-4" />
                    </Link>
                    {canEdit ? (
                      <button
                        type="button"
                        aria-label={`Delete ${rule.name}`}
                        data-tooltip="Delete automation"
                        disabled={pending}
                        onClick={async () => {
                          if (await confirm({ title: `Delete the automation “${rule.name}”?`, confirmLabel: "Delete", tone: "danger" })) {
                            run(() => deleteRule(rule.id));
                          }
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

      </>
      ) : null}

      {view === "templates" ? (
        <>
      {/* Nov 1 notes (batch 11): templates only add automations, so they're shown only to those who can. */}
      {canEdit ? (
        <RuleTemplatesGallery projectId={projectId} ctx={context} canEdit={canEdit} />
      ) : (
        <p className="mt-4 text-sm text-zinc-500">Templates add automations to this project. Ask one of its Owners or Editors to add one.</p>
      )}

        </>
      ) : null}

      {view === "history" ? (
      <section aria-labelledby="rule-runs" className="mt-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="rule-runs" className="text-sm font-semibold text-zinc-900">
            {historyRule ? `Runs of “${historyRule.name}”` : "Recent runs of every automation"}
          </h2>
          {historyRule ? (
            <Link href={rulesPageHref(projectId, "history")} className="text-xs font-medium text-accent-700 hover:underline">
              Show every automation
            </Link>
          ) : null}
          <span className="flex-1" />
          {optimisticRules.length > 1 ? (
            <SmartPicker
              label="Automation"
              value={historyRuleId ?? ""}
              options={[{ value: "", label: "Every automation" }, ...optimisticRules.map((r) => ({ value: r.id, label: r.name }))]}
              onChange={(value) => router.push(rulesPageHref(projectId, "history", value || null))}
              searchable
              panelWidth={300}
              className="w-56"
            />
          ) : null}
          {runs.length ? <Segmented label="Show runs" options={runFilters} value={runFilter} onChange={setRunFilter} /> : null}
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          The newest {HISTORY_LIMIT} runs: what ran, on which task, and each step. Open a run to see its steps.
        </p>
        {focusRunId && !runs.some((r) => r.id === focusRunId) ? (
          <p className="mt-2 text-sm text-zinc-500" data-focus-run-missing="">
            That run isn’t among the newest {HISTORY_LIMIT} runs shown here any more.
          </p>
        ) : null}
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">Nothing has run yet.</p>
        ) : shownRuns.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">Nothing needs attention among the latest {runs.length}.</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-100 rounded-lg border border-zinc-200 text-sm">
            {shownRuns.map((r) => (
              <RunRow key={r.id} run={r} ruleName={ruleNames.get(r.ruleId) ?? null} projectId={projectId} focused={r.id === focusRunId} />
            ))}
          </ul>
        )}
      </section>
      ) : null}
    </div>
  );
}

// One logged run; runs with steps (or an error) open to show each step.
function RunRow({
  run: r,
  ruleName,
  projectId,
  focused = false,
}: {
  run: RuleRun;
  ruleName: string | null;
  projectId: string;
  focused?: boolean;
}) {
  const [open, setOpen] = useState(focused);
  const panelId = useId();
  const rowRef = useRef<HTMLLIElement>(null);
  // Nov 11 notes (190): a toast's "View this run" lands here, opened and in view.
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const outcome = runOutcome(r.status, r.detail);
  const reason = runReason(r.detail) ?? outcome.reason;
  const { steps, error } = runSteps(r.detail);
  const expandable = steps.length > 0 || error !== null;
  const name = ruleName ?? "Deleted automation";

  return (
    <li
      ref={rowRef}
      className={`px-3 py-2 ${focused ? "bg-accent-50 ring-1 ring-inset ring-accent-200" : ""}`}
      data-run-id={r.id}
      data-run-focused={focused ? "" : undefined}
      aria-current={focused ? "true" : undefined}
    >
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
        <span data-run-outcome={outcome.tone} className={`rounded px-1.5 py-0.5 text-2xs font-medium ${RUN_TONE_CLASS[outcome.tone]}`}>
          {runOutcomeText(outcome)}
        </span>
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
