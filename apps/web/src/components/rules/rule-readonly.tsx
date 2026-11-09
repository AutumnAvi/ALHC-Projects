"use client";

// AI builder round 4 (note 173): an automation read-only, in the rule canvas's own layout — the summary
// sentence, then WHEN (the trigger), and per branch IF (its conditions, Or groups as "or") and THEN (every
// action in order), then ALSO (its options). The canvas's sentence rows and the same describe* wording
// (rule-shared.tsx), so an automation reads the same in the canvas, the Rules list, and the assistant.
import type { ReactNode } from "react";
import { splitBranches, splitGroups, type RuleAction, type RuleCondition, type TriggerType } from "@alhc/core/rules";
import type { Json } from "@alhc/core/supabase/database.types";
import { branchLabel, describeAction, describeCondition, describeTrigger, ruleSentence, type RuleContext } from "./rule-shared";

// One line of the sentence: the word ("When", "If", "Then") in a gutter, then its tokens. Shared with the
// rule canvas.
export function SentenceRow({
  word,
  children,
  aside,
  muted = false,
}: {
  word: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 border-t border-zinc-100 px-4 py-2.5 transition-colors first:border-t-0 hover:bg-zinc-50/70 focus-within:bg-zinc-50/70">
      <span
        className={`mt-1 w-20 shrink-0 text-xs font-semibold uppercase tracking-wide ${muted ? "text-zinc-400" : "text-zinc-500"}`}
      >
        {word}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm text-zinc-700">{children}</div>
      {aside}
    </div>
  );
}

export type ReadOnlyRule = {
  name: string;
  triggerType: TriggerType;
  triggerConfig: Record<string, Json>;
  conditions: RuleCondition[];
  actions: RuleAction[];
};

const STEP = "rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800";

export function RuleReadOnly({ rule, ctx, also = [] }: { rule: ReadOnlyRule; ctx: RuleContext; also?: string[] }) {
  const branches = splitBranches(rule);
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-accent-100 bg-accent-50/60 px-4 py-3">
        <p className="text-2xs font-semibold uppercase tracking-wide text-accent-700">Summary</p>
        <p className="mt-1 text-sm text-zinc-800">{ruleSentence(rule, ctx)}</p>
      </div>
      <section aria-label={`Automation ${rule.name}`} className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        <SentenceRow word="When">
          <span className={STEP}>{describeTrigger(rule, ctx)}</span>
        </SentenceRow>
        {branches.map((branch, index) => {
          const groups = splitGroups(branch.conditions);
          const label = branches.length === 1 ? "If" : branchLabel(index, branches.length, branch.conditions.length > 0);
          return (
            <div key={index} data-branch={index}>
              {branch.conditions.length ? (
                <SentenceRow word={label}>
                  {groups.map((group, g) => (
                    <div key={g} className="flex flex-wrap items-center gap-1">
                      {g > 0 ? <span className="text-xs font-semibold uppercase text-zinc-500">or</span> : null}
                      {group.map((c, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 ? <span className="text-xs text-zinc-500">and</span> : null}
                          <span className={STEP}>{describeCondition(c, ctx)}</span>
                        </span>
                      ))}
                    </div>
                  ))}
                </SentenceRow>
              ) : branches.length > 1 ? (
                <SentenceRow word={label} muted>
                  <span className="text-xs text-zinc-500">Every task the other branches didn’t take</span>
                </SentenceRow>
              ) : null}
              <SentenceRow word="Then">
                <ol className="flex flex-col gap-1" aria-label={`${label} actions`}>
                  {branch.actions.map((a, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="mt-1 w-4 shrink-0 text-right text-2xs text-zinc-400">{i + 1}</span>
                      <span className={STEP}>{describeAction(a, ctx)}</span>
                    </li>
                  ))}
                  {branch.actions.length === 0 ? <li className="text-xs text-zinc-500">No actions</li> : null}
                </ol>
              </SentenceRow>
            </div>
          );
        })}
        {also.length ? (
          <SentenceRow word="Also" muted>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-zinc-600">
              {also.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </SentenceRow>
        ) : null}
      </section>
    </div>
  );
}
