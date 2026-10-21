"use client";

import { Check, Clock, Minus, Send, X, type LucideIcon } from "lucide-react";
import { ACTIONS, labelOf } from "@/lib/rules";
import { stepOutcomeLabel, stepTone, type RuleStep, type StepTone } from "@/lib/rule-steps";
import type { Json } from "@/lib/supabase/database.types";
import { RuleIcon } from "./rule-icons";

// A rule's steps as a vertical timeline (Automations V2, batch 4): the run history's expanded rows and
// the Test panel's dry run draw the same list. Each step has its action, what happened (colored by
// tone), the engine's one-line result or error, and the values it used.

const TONE: Record<StepTone, { icon: LucideIcon; dot: string; badge: string }> = {
  ok: { icon: Check, dot: "bg-green-50 text-green-700 ring-green-200", badge: "bg-green-50 text-green-800" },
  unchanged: { icon: Minus, dot: "bg-zinc-100 text-zinc-500 ring-zinc-200", badge: "bg-zinc-100 text-zinc-600" },
  wait: { icon: Clock, dot: "bg-amber-50 text-amber-700 ring-amber-200", badge: "bg-amber-50 text-amber-800" },
  send: { icon: Send, dot: "bg-accent-50 text-accent-700 ring-accent-200", badge: "bg-accent-50 text-accent-700" },
  error: { icon: X, dot: "bg-red-50 text-red-700 ring-red-200", badge: "bg-red-50 text-red-700" },
};

// "business_days" → "Business days".
function inputKey(key: string) {
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function inputValue(value: Json): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(inputValue).join(", ");
  return JSON.stringify(value);
}

export function RunSteps({
  steps,
  error,
  emptyText = "No steps were logged for this run.",
  dryRun = false,
  actionLabel = (type: string) => labelOf(ACTIONS, type),
}: {
  steps: RuleStep[];
  // The run's own error (a failed run), shown unless its failing step already says it.
  error: string | null;
  emptyText?: string;
  // The Test panel's steps (nothing ran for real), which changes how a failure is explained.
  dryRun?: boolean;
  // How a step's action is named (portfolio rules have their own vocabulary).
  actionLabel?: (type: string) => string;
}) {
  const failedStep = steps.find((s) => stepTone(s.outcome) === "error");
  const runError = error && !steps.some((s) => s.error === error) ? error : null;
  if (steps.length === 0 && !runError) return <p className="text-xs text-zinc-500">{emptyText}</p>;
  return (
    <div className="flex flex-col gap-2">
      {steps.length ? (
        <div className="relative">
          {/* The line the step markers sit on. */}
          <span aria-hidden className="absolute bottom-2 left-[11px] top-2 w-px bg-zinc-200" />
          <ol aria-label="Steps" className="relative flex flex-col gap-3">
            {steps.map((step, i) => {
              const tone = stepTone(step.outcome);
              const look = TONE[tone];
              const Icon = look.icon;
              const inputs = Object.entries(step.input ?? {}).filter(([, v]) => v !== "" && v !== null);
              return (
                <li key={`${step.step}-${i}`} className="relative flex gap-2.5">
                  <span aria-hidden className={`relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ring-1 ${look.dot}`}>
                    <Icon className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="text-2xs font-medium tabular-nums text-zinc-400">{step.step}.</span>
                      <RuleIcon value={step.type} className="size-3.5 text-zinc-400" />
                      <span className="text-sm font-medium text-zinc-800">{actionLabel(step.type)}</span>
                      <span className={`rounded-full px-1.5 py-px text-2xs font-medium ${look.badge}`}>{stepOutcomeLabel(step.outcome)}</span>
                      {step.afterWait ? <span className="chip text-2xs">after the wait</span> : null}
                    </div>
                    {step.error ? (
                      <p className="mt-0.5 break-words text-xs text-red-700">{step.error}</p>
                    ) : step.result ? (
                      <p className="mt-0.5 break-words text-xs text-zinc-600">{step.result}</p>
                    ) : null}
                    {inputs.length ? (
                      <dl className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-zinc-500">
                        {inputs.map(([key, value]) => (
                          <div key={key} className="min-w-0 break-words">
                            <dt className="inline text-zinc-400">{inputKey(key)}: </dt>
                            <dd className="inline">{inputValue(value)}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
      {runError ? <p className="break-words rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{runError}</p> : null}
      {/* run_rule undoes a failed run as a whole (the steps before the failure too) and skips the rest. */}
      {failedStep || runError ? (
        <p className="text-xs text-zinc-500">
          {dryRun
            ? "In a real run, a failed step undoes the steps before it and skips the rest."
            : "A step failed, so the whole run was undone: none of its changes were kept."}
        </p>
      ) : null}
    </div>
  );
}
