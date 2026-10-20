"use client";

import { useEffect, useId, useState } from "react";
import { CheckCircle2, CircleDot, FlaskConical, Loader2, X } from "lucide-react";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import { testRule } from "@/lib/actions";
import { conditionGroup, groupsPass, type RuleAction, type RuleCondition, type TriggerType } from "@/lib/rules";
import { testHeadline, type RuleTestResult } from "@/lib/rule-steps";
import type { Json } from "@/lib/supabase/database.types";
import { describeCondition, describeTrigger, type RuleContext } from "./rule-shared";
import { RunSteps } from "./run-steps";

// What the canvas hands the Test panel: the rule as it stands in the builder, saved or not.
export type RuleTestDraft = {
  name: string;
  triggerType: TriggerType;
  triggerConfig: Record<string, Json>;
  conditions: RuleCondition[];
  actions: RuleAction[];
  timeZone: string;
};

export type RuleTestTask = { id: string; title: string; completed: boolean };

type Tested = {
  result: RuleTestResult;
  // The draft as it was tested (the summary line, and whether the builder changed since).
  draft: RuleTestDraft;
  key: string;
};

// The canvas's Test panel (Automations V2, batch 4): pick a task, run the current draft on it, and see
// which branch's conditions pass and what each step would do. test_rule runs the real engine and always
// rolls it back, so nothing is written and no email, Slack message, or webhook is queued.
export function RuleTestPanel({
  id,
  projectId,
  ruleId,
  tasks,
  draft,
  problem,
  ctx,
  onClose,
}: {
  id: string;
  projectId: string;
  // Null = a rule that isn't saved yet.
  ruleId: string | null;
  tasks: RuleTestTask[];
  draft: RuleTestDraft;
  // What would stop the draft from saving (branchProblem), said before testing it.
  problem: string | null;
  ctx: RuleContext;
  onClose: () => void;
}) {
  const headingId = useId();
  const pickerId = `${id}-task`;
  const [taskId, setTaskId] = useState<string | null>(tasks[0]?.id ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<Tested | null>(null);
  const draftKey = JSON.stringify(draft);

  useEffect(() => {
    document.getElementById(pickerId)?.focus();
  }, [pickerId]);

  const options: SmartOption[] = tasks.map((t) => ({
    value: t.id,
    label: t.completed ? `${t.title} (completed)` : t.title,
    icon: t.completed ? <CheckCircle2 className="size-4 text-green-600" /> : <CircleDot className="size-4" />,
  }));

  async function runTest() {
    if (!taskId || loading) return;
    if (problem) {
      setError(problem);
      setTested(null);
      return;
    }
    const snapshot = draft;
    const key = draftKey;
    setLoading(true);
    setError(null);
    try {
      const response = await testRule(projectId, ruleId, taskId, snapshot);
      if (response.error || !response.result) {
        setError(response.error ?? "The test didn’t come back with a result");
        setTested(null);
      } else {
        setTested({ result: response.result, draft: snapshot, key });
      }
    } catch {
      setError("The test couldn’t run. Try again in a moment.");
      setTested(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <aside
      id={id}
      aria-labelledby={headingId}
      className="flex shrink-0 flex-col border-t border-zinc-200 bg-white lg:min-h-0 lg:w-96 lg:overflow-y-auto lg:border-l lg:border-t-0 xl:w-[28rem]"
    >
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3">
        <FlaskConical className="size-4 text-zinc-500" aria-hidden />
        <h3 id={headingId} className="flex-1 text-sm font-semibold text-zinc-900">
          Test this rule
        </h3>
        <button type="button" onClick={onClose} aria-label="Close the test panel" data-tooltip="Close" className="btn-icon">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">
        <p className="text-xs text-zinc-500">
          Runs the rule as it is in the builder (saved or not) on a task and shows what would happen. Nothing is
          changed or sent.
        </p>
        {tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-500">
            This project has no tasks to test on yet
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <label htmlFor={pickerId} className="text-xs font-medium text-zinc-600">
              Task to test on
            </label>
            <SmartPicker
              id={pickerId}
              label="Task to test on"
              value={taskId}
              options={options}
              onChange={setTaskId}
              placeholder="Choose a task"
              emptyText="No task matches"
              searchable
              panelWidth={340}
              className="w-full"
            />
            <button type="button" onClick={runTest} disabled={!taskId || loading} className="btn-primary h-8 self-start px-3">
              {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FlaskConical className="size-4" aria-hidden />}
              {loading ? "Testing…" : tested ? "Run test again" : "Run test"}
            </button>
          </div>
        )}

        <div aria-live="polite" aria-busy={loading} className="flex flex-col gap-4">
          {error ? (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {error}
            </p>
          ) : null}
          {tested && !error ? <TestOutcome tested={tested} stale={tested.key !== draftKey} ctx={ctx} /> : null}
        </div>
      </div>
    </aside>
  );
}

// "If", "Otherwise if 2", "Otherwise" (the canvas's words for its branches).
function branchName(index: number, count: number, hasConditions: boolean, elseIfs: number) {
  if (index === 0) return "If";
  if (index === count - 1 && !hasConditions) return "Otherwise";
  return elseIfs > 1 ? `Otherwise if ${index}` : "Otherwise if";
}

function TestOutcome({ tested, stale, ctx }: { tested: Tested; stale: boolean; ctx: RuleContext }) {
  const { result, draft } = tested;
  const count = result.branches.length;
  const elseIfs = result.branches.filter((b, i) => i > 0 && (i < count - 1 || b.conditions.length > 0)).length;
  const names = result.branches.map((b, i) => branchName(i, count, b.conditions.length > 0, elseIfs));
  const chosen = result.chosenBranch;
  const failed = result.invalid || Boolean(result.error);
  const tone = failed
    ? "border-red-200 bg-red-50 text-red-900"
    : chosen === null
      ? "border-zinc-200 bg-zinc-50 text-zinc-800"
      : "border-green-200 bg-green-50 text-green-900";

  return (
    <>
      {stale ? (
        <p className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
          The rule changed since this test. Run it again to see the new result.
        </p>
      ) : null}
      <div className={`rounded-lg border px-3 py-2.5 ${tone}`}>
        <p className="text-sm font-semibold">{testHeadline(result)}</p>
        <p className="mt-0.5 text-xs opacity-80">
          Simulating: {describeTrigger(draft, ctx)} on “{result.taskTitle}”
        </p>
        {result.error ? <p className="mt-1.5 break-words text-xs font-medium text-red-700">{result.error}</p> : null}
      </div>

      {count ? (
        <section aria-label="Conditions" className="flex flex-col gap-2">
          <h4 className="text-2xs font-semibold uppercase tracking-wide text-zinc-500">Conditions</h4>
          {result.branches.map((branch, i) => {
            const passes = groupsPass(branch.conditions, (c) => conditionGroup(c.condition), (c) => c.ok);
            const status = chosen === i ? "Runs" : chosen !== null && chosen < i ? "Not checked" : passes ? "Matches" : "Doesn’t match";
            // OR groups read top to bottom, "or" between them (a stable sort keeps each group's order).
            const ordered = [...branch.conditions].sort((a, b) => conditionGroup(a.condition) - conditionGroup(b.condition));
            return (
              <div
                key={branch.branch}
                className={`rounded-lg border px-3 py-2 ${chosen === i ? "border-accent-200 bg-accent-50/50" : "border-zinc-200"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-600">{names[i]}</span>
                  <span
                    className={`ml-auto rounded-full px-1.5 py-px text-2xs font-medium ${
                      chosen === i ? "bg-accent-100 text-accent-800" : "bg-zinc-100 text-zinc-600"
                    }`}
                  >
                    {status}
                  </span>
                </div>
                {branch.conditions.length === 0 ? (
                  <p className="mt-1 text-xs text-zinc-500">{i === 0 ? "No conditions: always runs" : "Runs when nothing above matches"}</p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {ordered.map((c, j) => {
                      const orBefore = j > 0 && conditionGroup(c.condition) !== conditionGroup(ordered[j - 1].condition);
                      return (
                        <li key={j} className="flex flex-col gap-0.5">
                          {orBefore ? <span className="text-2xs font-semibold uppercase text-amber-700">or</span> : null}
                          <span className="flex items-start gap-1.5 text-xs">
                            <span aria-hidden className={`font-semibold ${c.ok ? "text-green-600" : "text-red-600"}`}>
                              {c.ok ? "✓" : "✗"}
                            </span>
                            <span className="sr-only">{c.ok ? "Passes:" : "Fails:"}</span>
                            <span className={c.ok ? "text-zinc-700" : "text-zinc-500"}>{describeCondition(c.condition, ctx)}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
          <p className="text-xs text-zinc-600">
            Runs: <span className="font-medium text-zinc-900">{chosen !== null && names[chosen] ? names[chosen] : "None"}</span>
          </p>
        </section>
      ) : null}

      {chosen !== null ? (
        <section aria-label="Steps" className="flex flex-col gap-2">
          <h4 className="text-2xs font-semibold uppercase tracking-wide text-zinc-500">Steps</h4>
          <RunSteps steps={result.steps} error={result.invalid ? null : result.error} emptyText="No steps would run." dryRun />
        </section>
      ) : null}

      <p className="border-t border-zinc-100 pt-3 text-xs text-zinc-500">
        Nothing was changed. Emails, Slack messages, and webhooks weren’t sent.
      </p>
    </>
  );
}
