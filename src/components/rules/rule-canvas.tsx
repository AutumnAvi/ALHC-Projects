"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  CirclePause,
  Copy,
  FlaskConical,
  FolderClosed,
  GitBranch,
  Plus,
  Trash2,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { Avatar } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { StepParams, StepPrompt } from "@/components/param-slot";
import { PickerHighlightContext, SmartPicker } from "@/components/smart-picker";
import { missingParams, ruleProblems, saveBlockedReason, stepProblems, type StepScope } from "@/lib/rule-params";
import type { BuiltRule } from "@/lib/rule-templates";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { createRule, setRuleEnabled, updateRule, type RevealedSigningSecret } from "@/lib/actions";
import { runSteps } from "@/lib/rule-steps";
import {
  ACTIONS,
  CONDITIONS,
  MAX_CONDITION_GROUPS,
  joinGroups,
  splitGroups,
  MAX_BRANCH_ACTIONS,
  MAX_BRANCH_CONDITIONS,
  MAX_RULE_BRANCHES,
  TRIGGERS,
  branchProblem,
  joinBranches,
  runReason,
  splitBranches,
  type ActionType,
  type ConditionType,
  type RuleAction,
  type RuleBranch,
  type RuleCondition,
  type RuleDef,
  type RuleRun,
  type TriggerType,
} from "@/lib/rules";
import type { Json } from "@/lib/supabase/database.types";
import {
  ActionFields,
  ConditionFields,
  INLINE_ACTION_TYPES,
  INLINE_AND_BLOCK_ACTION_TYPES,
  RevealedSecrets,
  TriggerFields,
  conditionDefaultsFor,
  defaultsFor,
} from "./rule-editor";
import { vocabOptions } from "./rule-icons";
import { branchLabel, needsUpdate, ruleSentence, tagsHidden, type RuleContext } from "./rule-shared";
import { RuleTestPanel, type RuleTestDraft, type RuleTestTask } from "./rule-test-panel";
import { RunSteps } from "./run-steps";

const RUN_STATUS: Record<RuleRun["status"], string> = {
  succeeded: "bg-green-50 text-green-800",
  scheduled: "bg-accent-50 text-accent-700",
  skipped: "bg-zinc-100 text-zinc-600",
  failed: "bg-red-50 text-red-700",
};

const RUN_LABEL: Record<RuleRun["status"], string> = {
  succeeded: "Ran",
  scheduled: "Waiting",
  skipped: "Skipped",
  failed: "Failed",
};

const NEW_CONDITION: RuleCondition = { type: "is_incomplete" };

// Triggers the scheduler or a person starts (run_rule directly, not fire_rules), so "changes made by
// other rules" never apply to them.
const NOT_CHANGE_TRIGGERS: ReadonlySet<TriggerType> = new Set([
  "due_approaching", "task_overdue", "scheduled", "manual", "start_approaching", "start_reached",
]);

// Asana's rule builder (Asana parity, batch 4): a full-page canvas. The header has the rule's name, an
// Active toggle, Cancel, and Save, with Build and Activity tabs. The flow reads top to bottom: the scope
// (tasks in this project), the trigger, then "Check if" with its actions, optional "Else if" branches,
// and "Otherwise", with "+ Add branch". Branches are stored as branch keys on the rule's conditions and
// actions (run_rule runs the first branch whose conditions pass), so rules without branches are exactly
// what they were and keep running unchanged. Automations V2 (batch 4) adds the owner, the "changes
// made by other rules" switch, the paused notice with Resume, a Test panel (a dry run of the draft),
// and per-step run details on Activity.
export function RuleCanvas({
  projectId,
  projectName,
  rule,
  initial = null,
  runs,
  testTasks = [],
  ctx,
  batch4,
  canEdit,
  backHref,
}: {
  projectId: string;
  projectName: string;
  // Null = a new rule.
  rule: RuleDef | null;
  // A new rule from the templates gallery: filled in, with what's still to pick (highlighted).
  initial?: BuiltRule | null;
  runs: RuleRun[];
  // Tasks of the project to test the rule on (the Test panel).
  testTasks?: RuleTestTask[];
  ctx: RuleContext;
  // This release's database update (Else if / Otherwise branches).
  batch4: boolean;
  // Admin+ (rules are managed by project admins); everyone else reads.
  canEdit: boolean;
  backHref: string;
}) {
  const router = useRouter();
  const notify = useNotify();
  const titleId = useId();
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const [name, setName] = useState(rule?.name ?? initial?.name ?? "");
  // A template's rule starts off, so it can be checked (and tested) before it runs.
  const [enabled, setEnabled] = useState(rule ? rule.enabled : !initial);
  const [triggerType, setTriggerType] = useState<TriggerType>(rule?.triggerType ?? initial?.triggerType ?? "section_changed");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, Json>>(rule?.triggerConfig ?? initial?.triggerConfig ?? {});
  const [branches, setBranches] = useState<RuleBranch[]>(() =>
    rule ? splitBranches(rule) : initial ? splitBranches(initial) : [{ conditions: [], actions: [defaultsFor("add_comment")] }],
  );
  // Batch 4 (Automations V2's database only): null owner on a new rule = whoever creates it.
  const v2 = ctx.v2 === true;
  const [ownerId, setOwnerId] = useState<string | null>(rule?.ownerId ?? null);
  const [runOnRuleChanges, setRunOnRuleChanges] = useState(rule?.runOnRuleChanges ?? true);
  // Resume (from the paused notice) saved the rule back on; the page's refresh clears the pause.
  const [resumed, setResumed] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [tab, setTab] = useState<"build" | "activity">("build");
  const [dirty, setDirty] = useState(false);
  const [revealed, setRevealed] = useState<RevealedSigningSecret[] | null>(null);
  const dirtyRef = useRef(dirty);
  const testOpenRef = useRef(testOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const testButtonRef = useRef<HTMLButtonElement>(null);
  const testPanelId = useId();
  const ruleChangesHintId = useId();

  useEffect(() => {
    dirtyRef.current = dirty;
    testOpenRef.current = testOpen;
  }, [dirty, testOpen]);

  function closeTest() {
    setTestOpen(false);
    testButtonRef.current?.focus();
  }

  async function leave() {
    if (dirtyRef.current && !(await confirm({ title: "Discard your changes to this rule?", confirmLabel: "Discard", tone: "danger" }))) {
      return;
    }
    router.push(backHref);
  }
  // Escape closes the Test panel first, then leaves the canvas (pickers handle their own Escape).
  const leaveRef = useRef(leave);
  const closeTestRef = useRef(closeTest);
  useEffect(() => {
    leaveRef.current = leave;
    closeTestRef.current = closeTest;
  });

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      if (testOpenRef.current) closeTestRef.current();
      else leaveRef.current();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  function changeBranches(next: (current: RuleBranch[]) => RuleBranch[]) {
    setBranches(next);
    setDirty(true);
  }

  function setBranch(index: number, branch: RuleBranch) {
    changeBranches((current) => current.map((b, i) => (i === index ? branch : b)));
  }

  const last = branches[branches.length - 1];
  const hasOtherwise = branches.length > 1 && last.conditions.length === 0;

  function addElseIf() {
    changeBranches((current) => {
      const branch = { conditions: [NEW_CONDITION], actions: [defaultsFor("add_comment")] };
      const otherwise = current.length > 1 && current[current.length - 1].conditions.length === 0;
      return otherwise ? [...current.slice(0, -1), branch, current[current.length - 1]] : [...current, branch];
    });
  }

  // Automations V3 (batch E): copy a branch right after itself, and move branches up / down. The
  // Otherwise branch (last, no conditions) stays last and isn't copied.
  function duplicateBranch(index: number) {
    changeBranches((current) => {
      if (current.length >= MAX_RULE_BRANCHES) return current;
      const copy = structuredClone(current[index]);
      return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)];
    });
  }

  function moveBranch(index: number, delta: number) {
    changeBranches((current) => {
      const target = index + delta;
      const otherwiseAt = current.length > 1 && current[current.length - 1].conditions.length === 0 ? current.length - 1 : -1;
      if (target < 0 || target >= current.length || target === otherwiseAt || index === otherwiseAt) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addOtherwise() {
    changeBranches((current) => [...current, { conditions: [], actions: [defaultsFor("add_comment")] }]);
  }

  // Where a revealed signing secret's action sits (the flat index the server reports).
  function describeSecret(secret: RevealedSigningSecret) {
    let index = secret.action - 1;
    for (const [b, branch] of branches.entries()) {
      if (index < branch.actions.length) {
        const label = branches.length === 1 ? "" : `${branchLabel(b, branches.length, branch.conditions.length > 0)}: `;
        return `${label}Call webhook (action ${index + 1})`;
      }
      index -= branch.actions.length;
    }
    return `Call webhook (action ${secret.action})`;
  }

  // Every step's settings (rule-params.ts): Save waits until nothing required is missing.
  const problems = ruleProblems({ triggerType, triggerConfig, ...joinBranches(branches) }, "project", { v3: ctx.v3 });
  const blocked = saveBlockedReason(problems);

  function save() {
    if (blocked) {
      notify(blocked);
      return;
    }
    const problem = branchProblem(branches);
    if (problem) {
      notify(problem);
      return;
    }
    const { conditions, actions } = joinBranches(branches);
    run(async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const input = { name, triggerType, triggerConfig, conditions, actions, enabled, timeZone, ...(v2 ? { ownerId, runOnRuleChanges } : {}) };
      const result = rule ? await updateRule(rule.id, input) : await createRule(projectId, input);
      if (!result.error) {
        setDirty(false);
        dirtyRef.current = false;
        if (result.signingSecrets?.length) {
          // The reveal replaces the tabs and the Test panel; a hidden panel would swallow the next Escape.
          setTestOpen(false);
          setRevealed(result.signingSecrets);
        } else {
          notify(rule ? "Rule saved" : enabled ? "Rule created and on" : "Rule created (off)");
          router.push(backHref);
        }
      }
      return result;
    });
  }

  // The paused notice's Resume: with nothing else changed it turns the rule back on at once (the
  // database clears the pause and the failure count); with unsaved changes it flips the switch, and
  // Save resumes it along with the rest.
  const paused = Boolean(rule?.pausedAt) && !resumed;
  function resume() {
    if (!rule) return;
    if (dirty) {
      setEnabled(true);
      return;
    }
    run(async () => {
      const result = await setRuleEnabled(rule.id, true);
      if (!result.error) {
        setEnabled(true);
        setResumed(true);
        notify("Rule resumed");
      }
      return result;
    });
  }

  // What the Test panel runs: the builder's draft, saved or not.
  const draft: RuleTestDraft = {
    name,
    triggerType,
    triggerConfig,
    ...joinBranches(branches),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const testBlocked = !v2 ? "Needs this release’s database update" : !canEdit ? "Project admins and owners test rules" : null;
  const owner = ownerId ? ctx.people.find((p) => p.id === ownerId) : null;
  const ownerName = ownerId ? (owner?.name ?? "someone removed") : rule ? "the rule’s creator" : "you";
  const editor = rule?.lastEditedBy ? ctx.people.find((p) => p.id === rule.lastEditedBy) : null;

  return (
    <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="fixed inset-0 z-50 flex flex-col bg-white text-sm">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 sm:px-4">
        <button type="button" onClick={leave} aria-label="Back" data-tooltip="Back" className="btn-icon">
          <ArrowLeft className="size-4" />
        </button>
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-600">
          <Zap className="size-4" />
        </span>
        <h2 id={titleId} className="sr-only">
          {rule ? `Edit rule ${rule.name}` : "New rule"}
        </h2>
        <label htmlFor="rule-name" className="sr-only">
          Rule name
        </label>
        <input
          id="rule-name"
          data-autofocus
          value={name}
          maxLength={200}
          readOnly={!canEdit}
          placeholder="Untitled rule"
          onChange={(e) => {
            setName(e.currentTarget.value);
            setDirty(true);
          }}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-base font-semibold text-zinc-900 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none read-only:hover:border-transparent"
        />
        {v2 ? (
          <span
            data-tooltip="Gets a notice if the rule pauses itself; cross-project actions act with their access"
            className="flex shrink-0 items-center gap-1"
          >
            <span aria-hidden className="hidden text-xs text-zinc-500 lg:inline">
              Owner
            </span>
            <SmartPicker
              id="rule-owner"
              label={`Owner: ${ownerName}`}
              value={ownerId}
              options={(ctx.members ?? ctx.people).map((p) => ({ value: p.id, label: p.name, icon: <Avatar name={p.name} profileId={p.id} /> }))}
              onChange={(v) => {
                setOwnerId(v);
                setDirty(true);
              }}
              variant="ghost"
              searchable
              disabled={!canEdit}
              panelWidth={280}
              emptyText="Nobody matches"
              className="h-8 max-w-48 px-1.5"
              renderValue={(chosen) =>
                chosen[0] ? (
                  <>
                    <Avatar name={chosen[0].label} profileId={chosen[0].value} />
                    <span className="hidden truncate md:inline">{chosen[0].label}</span>
                  </>
                ) : (
                  <>
                    <UserRound className="size-4" aria-hidden />
                    <span className="hidden md:inline">{ownerId ? "Someone removed" : rule ? "Creator" : "You"}</span>
                  </>
                )
              }
            />
          </span>
        ) : null}
        <label className="flex shrink-0 items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={!canEdit}
            onChange={(e) => {
              setEnabled(e.currentTarget.checked);
              setDirty(true);
            }}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="relative inline-block h-5 w-9 rounded-full bg-zinc-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent-500 peer-checked:after:translate-x-4 peer-disabled:opacity-60 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500"
          />
          <span className="hidden sm:inline">{enabled ? "Active" : paused ? "Paused" : "Off"}</span>
          <span className="sr-only sm:hidden">Active</span>
        </label>
        {revealed ? null : (
          <button
            ref={testButtonRef}
            type="button"
            onClick={() => {
              if (!testBlocked) setTestOpen((open) => !open);
            }}
            aria-label="Test"
            aria-disabled={testBlocked ? true : undefined}
            aria-expanded={testBlocked ? undefined : testOpen}
            aria-controls={testOpen ? testPanelId : undefined}
            data-tooltip={testBlocked ?? (testOpen ? "Close the test panel" : "Try the rule on a task without changing anything")}
            className="btn-secondary h-8 px-2.5 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          >
            <FlaskConical className="size-4" aria-hidden />
            <span className="hidden sm:inline">Test</span>
          </button>
        )}
        <button type="button" onClick={leave} className="btn-secondary h-8 px-3">
          {canEdit ? "Cancel" : "Close"}
        </button>
        {canEdit && blocked ? (
          <span id="rule-save-blocked" role="status" className="hidden max-w-64 truncate text-xs text-amber-800 md:inline" title={problems.join("\n")}>
            {blocked}
          </span>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            onClick={save}
            disabled={pending || !name.trim() || Boolean(blocked)}
            aria-describedby={blocked ? "rule-save-blocked" : undefined}
            data-tooltip={blocked ?? (!name.trim() ? "Name the rule first" : undefined)}
            className="btn-primary h-8 px-3"
          >
            {pending ? "Saving…" : rule ? "Save" : "Create rule"}
          </button>
        ) : null}
      </header>

      <div role="tablist" aria-label="Rule" className="tab-strip shrink-0 gap-1 px-4">
        {(
          [
            { key: "build", label: "Build" },
            { key: "activity", label: `Activity${runs.length ? ` (${runs.length})` : ""}` },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className="inline-flex h-10 shrink-0 items-center border-b-2 border-transparent px-2 text-sm text-zinc-500 hover:text-zinc-900 aria-selected:border-accent-500 aria-selected:font-medium aria-selected:text-zinc-900"
          >
            {t.label}
          </button>
        ))}
      </div>

      {revealed ? (
        <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-50 px-4 py-8">
          <div className="mx-auto max-w-xl">
            <RevealedSecrets secrets={revealed} describe={describeSecret} onDone={() => router.push(backHref)} />
          </div>
        </div>
      ) : (
        // The Test panel sits beside the tab on wide screens and below it on narrow ones (where this
        // whole area scrolls as one).
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          {tab === "activity" ? (
            <Activity projectId={projectId} rule={rule} runs={runs} branches={branches} />
          ) : (
            <div className="min-w-0 flex-1 bg-zinc-50 lg:min-h-0 lg:overflow-y-auto">
              <fieldset disabled={!canEdit} className="m-0 mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 border-0 px-4 py-6">
                {!canEdit ? (
                  <p className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600">
                    View only: project admins and owners change rules.
                  </p>
                ) : null}
                {rule && paused ? (
                  <div role="note" className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900">
                    <CirclePause className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        Paused after {Math.max(rule.consecutiveFailures ?? 0, 5)} failed runs in a row
                        {rule.pausedAt ? (
                          <span className="font-normal text-amber-800">
                            {" · "}
                            <Timestamp iso={rule.pausedAt} />
                          </span>
                        ) : null}
                      </p>
                      {rule.pauseReason ? <p className="mt-0.5 break-words text-xs">Last error: {rule.pauseReason}</p> : null}
                      <p className="mt-0.5 text-xs text-amber-800">
                        {enabled
                          ? "Turned back on: it resumes once you save."
                          : canEdit
                            ? "Fix what made it fail (the Activity tab has each run’s steps), then resume it."
                            : "A project admin can resume it once what made it fail is fixed."}
                      </p>
                    </div>
                    {canEdit && !enabled ? (
                      <button type="button" onClick={resume} disabled={pending} className="btn-secondary h-7 px-2.5">
                        Resume
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <RuleSummary triggerType={triggerType} triggerConfig={triggerConfig} branches={branches} ctx={ctx} projectName={projectName} />
                {initial && initial.missing.length ? (
                  <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    From a template. Still to pick (highlighted below): {initial.missing.join(", ")}.
                  </p>
                ) : null}
                <PickerHighlightContext.Provider value={Boolean(initial)}>
                <section aria-label="Rule" className="rounded-xl border border-zinc-200 bg-white shadow-sm">
                  <SentenceRow word="When">
                    <div className="flex flex-wrap items-center gap-1">
                    <SmartPicker
                      id="rule-trigger"
                      label="Trigger"
                      value={triggerType}
                      options={vocabOptions(TRIGGERS, { disabled: needsUpdate(ctx), hidden: tagsHidden(ctx, [triggerType]) })}
                      onChange={(v) => {
                        setTriggerType(v as TriggerType);
                        setTriggerConfig({});
                        setDirty(true);
                      }}
                      variant="chip"
                      searchable
                      panelWidth={340}
                    />
                    <StepParams missing={missingKeys({ type: triggerType, ...triggerConfig }, { system: "project", kind: "trigger", v3: ctx.v3 })}>
                      <TriggerFields
                        prefix="rule"
                        triggerType={triggerType}
                        triggerConfig={triggerConfig}
                        ctx={ctx}
                        onChange={(config) => {
                          setTriggerConfig(config);
                          setDirty(true);
                        }}
                      />
                    </StepParams>
                    <StepPrompt problems={stepProblems({ type: triggerType, ...triggerConfig }, { system: "project", kind: "trigger", v3: ctx.v3 })} />
                    </div>
                  </SentenceRow>
                  {branches.map((branch, index) => (
                    <BranchRows
                      key={index}
                      index={index}
                      count={branches.length}
                      branch={branch}
                      ctx={ctx}
                      projectId={projectId}
                      canEdit={canEdit}
                      onChange={(next) => setBranch(index, next)}
                      onRemove={index === 0 ? undefined : () => changeBranches((current) => current.filter((_, i) => i !== index))}
                      onDuplicate={
                        batch4 && branches.length < MAX_RULE_BRANCHES && branch.conditions.length > 0 ? () => duplicateBranch(index) : undefined
                      }
                      onMove={branches.length > 1 && branch.conditions.length > 0 ? (delta) => moveBranch(index, delta) : undefined}
                      canMoveUp={index > 0}
                      canMoveDown={index < branches.length - (hasOtherwise ? 2 : 1)}
                    />
                  ))}
                  {canEdit ? (
                    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-4 py-2.5">
                      <button
                        type="button"
                        onClick={addElseIf}
                        disabled={!batch4 || branches.length >= MAX_RULE_BRANCHES || (branches.length === 1 && branches[0].conditions.length === 0)}
                        data-tooltip={
                          !batch4
                            ? "Branches arrive with this release’s database update"
                            : branches.length === 1 && branches[0].conditions.length === 0
                              ? "Add an If condition first"
                              : "Runs when the conditions above don’t match"
                        }
                        className="btn-ghost h-7 text-xs"
                      >
                        <GitBranch className="size-3.5" aria-hidden />
                        Otherwise if…
                      </button>
                      {!hasOtherwise && branches.some((b) => b.conditions.length > 0) ? (
                        <button
                          type="button"
                          onClick={addOtherwise}
                          disabled={!batch4 || branches.length >= MAX_RULE_BRANCHES}
                          data-tooltip={!batch4 ? "Branches arrive with this release’s database update" : "Runs when nothing above matches"}
                          className="btn-ghost h-7 text-xs"
                        >
                          <Plus className="size-3.5" aria-hidden />
                          Otherwise…
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {v2 && !NOT_CHANGE_TRIGGERS.has(triggerType) ? (
                    <SentenceRow word="Also">
                      {/* Off: fire_rules skips this rule for changes another rule makes (no chains through it). */}
                      <div className="pt-0.5">
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={runOnRuleChanges}
                            aria-describedby={ruleChangesHintId}
                            onChange={(e) => {
                              setRunOnRuleChanges(e.currentTarget.checked);
                              setDirty(true);
                            }}
                            className="mt-0.5 size-4 accent-accent-600"
                          />
                          <span>
                            <span className="sr-only">Also </span>
                            <span className="text-zinc-800">Run when another rule makes the change</span>
                          </span>
                        </label>
                        {/* Outside the label: it describes the checkbox rather than being part of its name. */}
                        <p id={ruleChangesHintId} className="ml-6 text-xs text-zinc-500">
                          Turn off to avoid chains: only people’s changes trigger it
                        </p>
                      </div>
                    </SentenceRow>
                  ) : null}
                </section>
                </PickerHighlightContext.Provider>
                <p className="text-center text-xs text-zinc-500">
                  Rules never trigger themselves, chains stop after three rules, and the Status field always follows the
                  section. Text can use placeholders like {"{{task.name}}"} (the {"{ }"} button lists them all).
                </p>
                {rule?.lastEditedAt ? (
                  <p className="text-center text-xs text-zinc-400">
                    Last edited{editor ? ` by ${editor.name}` : ""} · <Timestamp iso={rule.lastEditedAt} />
                  </p>
                ) : null}
              </fieldset>
            </div>
          )}
          {testOpen && !testBlocked ? (
            <RuleTestPanel
              id={testPanelId}
              projectId={projectId}
              ruleId={rule?.id ?? null}
              tasks={testTasks}
              draft={draft}
              problem={blocked ?? branchProblem(branches)}
              ctx={ctx}
              onClose={closeTest}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

// The live summary at the top: the whole rule as one English sentence, plus its scope.
function RuleSummary({
  triggerType,
  triggerConfig,
  branches,
  ctx,
  projectName,
}: {
  triggerType: TriggerType;
  triggerConfig: Record<string, Json>;
  branches: RuleBranch[];
  ctx: RuleContext;
  projectName: string;
}) {
  const sentence = ruleSentence({ triggerType, triggerConfig, ...joinBranches(branches) }, ctx);
  return (
    <div className="rounded-xl border border-accent-100 bg-accent-50/60 px-4 py-3">
      <p className="text-2xs font-semibold uppercase tracking-wide text-accent-700">Summary</p>
      <p className="mt-1 text-sm text-zinc-800" aria-live="polite">
        {sentence}
      </p>
      <p className="mt-1.5 flex items-center gap-1 text-xs text-zinc-500">
        <FolderClosed className="size-3.5" aria-hidden />
        Tasks in <span className="font-medium text-zinc-700">{projectName}</span> (subtasks don’t trigger rules)
      </p>
    </div>
  );
}

// One line of the sentence: the word ("When", "If", "Then") in a gutter, then its tokens.
function SentenceRow({
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
    <div className="flex items-start gap-3 border-t border-zinc-100 px-4 py-2.5 first:border-t-0">
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

function BranchRows({
  index,
  count,
  branch,
  ctx,
  projectId,
  canEdit,
  onChange,
  onRemove,
  onDuplicate,
  onMove,
  canMoveUp = false,
  canMoveDown = false,
}: {
  index: number;
  count: number;
  branch: RuleBranch;
  ctx: RuleContext;
  projectId: string;
  canEdit: boolean;
  onChange: (next: RuleBranch) => void;
  onRemove?: () => void;
  onDuplicate?: () => void;
  onMove?: (delta: number) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  const label = branchLabel(index, count, branch.conditions.length > 0);
  const otherwise = label === "Otherwise";
  const prefix = `branch-${index}`;
  const ifWord = index === 0 ? "If" : otherwise ? "Otherwise" : "Otherwise if";

  // OR groups: AND within a group, OR between groups (one group stores no group keys).
  const groups = splitGroups(branch.conditions);
  const conditionOptions = vocabOptions(CONDITIONS, {
    disabled: needsUpdate(ctx),
    hidden: tagsHidden(ctx, branch.conditions.map((c) => c.type)),
  });
  const conditionScope: StepScope = { system: "project", kind: "condition", v3: ctx.v3 };
  const actionScope: StepScope = { system: "project", kind: "action", v3: ctx.v3 };
  const actionOptions = vocabOptions(ACTIONS, { disabled: needsUpdate(ctx), hidden: tagsHidden(ctx, branch.actions.map((a) => a.type)) });

  function setGroups(next: RuleCondition[][]) {
    onChange({ ...branch, conditions: joinGroups(next) });
  }
  function setCondition(g: number, i: number, next: RuleCondition | null) {
    setGroups(groups.map((items, j) => (j !== g ? items : next ? items.map((c, k) => (k === i ? next : c)) : items.filter((_, k) => k !== i))));
  }
  function setAction(i: number, next: RuleAction | null) {
    onChange({
      ...branch,
      actions: next ? branch.actions.map((a, j) => (j === i ? next : a)) : branch.actions.filter((_, j) => j !== i),
    });
  }
  function moveAction(i: number, delta: number) {
    const target = i + delta;
    if (target < 0 || target >= branch.actions.length) return;
    const copy = [...branch.actions];
    [copy[i], copy[target]] = [copy[target], copy[i]];
    onChange({ ...branch, actions: copy });
  }

  const removeBranch =
    canEdit && (onRemove || onDuplicate || onMove) ? (
      <span className="flex items-center">
        {onMove ? (
          <>
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={!canMoveUp}
              aria-label={`Move this ${label} branch up`}
              data-tooltip="Move branch up (it's checked earlier)"
              className="btn-icon size-7"
            >
              <ArrowUp className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={!canMoveDown}
              aria-label={`Move this ${label} branch down`}
              data-tooltip="Move branch down"
              className="btn-icon size-7"
            >
              <ArrowDown className="size-4" />
            </button>
          </>
        ) : null}
        {onDuplicate ? (
          <button type="button" onClick={onDuplicate} aria-label={`Duplicate this ${label} branch`} data-tooltip="Duplicate branch" className="btn-icon size-7">
            <Copy className="size-4" />
          </button>
        ) : null}
        {onRemove ? (
          <button type="button" onClick={onRemove} aria-label={`Remove this ${label} branch`} data-tooltip="Remove branch" className="btn-icon size-7">
            <X className="size-4" />
          </button>
        ) : null}
      </span>
    ) : null;

  return (
    <div role="group" aria-label={index === 0 ? "If, then" : label} className={index > 0 ? "border-t-4 border-zinc-50" : ""}>
      <SentenceRow word={ifWord} muted={index === 0 && branch.conditions.length === 0} aside={removeBranch}>
        {otherwise ? (
          <p className="pt-1 text-xs text-zinc-500">nothing above matches</p>
        ) : (
          <>
            {branch.conditions.length === 0 ? (
              <p className="pt-1 text-xs text-zinc-500">Always (no conditions). Add one to run only for some tasks.</p>
            ) : null}
            {groups.map((group, g) => (
              <div key={g} role="group" aria-label={groups.length > 1 ? `Condition group ${g + 1}` : "Conditions"} className="flex flex-col gap-1.5">
                {g > 0 ? (
                  <div className="flex items-center gap-2 py-0.5" aria-hidden>
                    <span className="rounded-full bg-amber-50 px-2 py-px text-2xs font-semibold uppercase tracking-wide text-amber-800 ring-1 ring-amber-200">
                      or
                    </span>
                    <span className="h-px flex-1 bg-zinc-100" />
                  </div>
                ) : null}
                {group.map((condition, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1">
                    {i > 0 ? <span className="mr-0.5 text-xs font-semibold text-zinc-400">and</span> : null}
                    <StepParams missing={missingKeys(condition, conditionScope)}>
                      <ConditionFields
                        prefix={`${prefix}-g${g}-c${i}`}
                        condition={condition}
                        ctx={ctx}
                        onChange={(next) => setCondition(g, i, next)}
                      />
                    </StepParams>
                    <StepPrompt problems={stepProblems(condition, conditionScope)} />
                    {canEdit ? (
                      <button
                        type="button"
                        aria-label={`Remove condition ${i + 1}${groups.length > 1 ? ` of group ${g + 1}` : ""}`}
                        data-tooltip="Remove condition"
                        onClick={() => setCondition(g, i, null)}
                        className="btn-icon size-6"
                      >
                        <X className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                ))}
                {canEdit && group.length > 0 && branch.conditions.length < MAX_BRANCH_CONDITIONS ? (
                  <SmartPicker
                    label={groups.length > 1 ? `Add a condition to group ${g + 1}` : "Add condition"}
                    value={null}
                    options={conditionOptions}
                    onChange={(v) => setGroups(groups.map((items, j) => (j === g ? [...items, conditionDefaultsFor(v as ConditionType)] : items)))}
                    variant="ghost"
                    searchable
                    className="h-6 self-start px-1.5 text-xs"
                    renderValue={() => (
                      <>
                        <Plus className="size-3.5" aria-hidden />
                        And…
                      </>
                    )}
                  />
                ) : null}
              </div>
            ))}
            {canEdit && branch.conditions.length < MAX_BRANCH_CONDITIONS && groups.length < MAX_CONDITION_GROUPS ? (
              <SmartPicker
                label={groups.length ? "Add an Or group" : "Add condition"}
                value={null}
                options={conditionOptions}
                onChange={(v) => setGroups([...groups, [conditionDefaultsFor(v as ConditionType)]])}
                variant="ghost"
                searchable
                disabled={groups.length > 0 && ctx.v2 === false}
                className="h-6 self-start px-1.5 text-xs"
                renderValue={() => (
                  <>
                    <Plus className="size-3.5" aria-hidden />
                    {groups.length ? "Or…" : "Add condition"}
                  </>
                )}
              />
            ) : null}
          </>
        )}
      </SentenceRow>
      <SentenceRow word="Then">
        <ol className="flex flex-col gap-2">
          {branch.actions.map((action, i) => {
            const actionProblems = stepProblems(action, actionScope);
            return (
            <li
              key={i}
              data-step-incomplete={actionProblems.length > 0 || undefined}
              className="group/action rounded-lg border border-transparent px-1 py-0.5 hover:border-zinc-200 data-[step-incomplete]:border-amber-200 data-[step-incomplete]:bg-amber-50/40"
            >
              <StepParams missing={missingKeys(action, actionScope)}>
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-4 text-xs font-medium tabular-nums text-zinc-400">{i + 1}.</span>
                <SmartPicker
                  label={`Action ${i + 1}`}
                  value={action.type}
                  options={actionOptions}
                  onChange={(v) => setAction(i, defaultsFor(v as ActionType))}
                  variant="chip"
                  searchable
                  panelWidth={340}
                />
                <InlineActionFields projectId={projectId} prefix={`${prefix}-a${i}`} action={action} ctx={ctx} onChange={(next) => setAction(i, next)} />
                <StepPrompt problems={actionProblems} />
                <span className="flex-1" />
                {canEdit ? (
                  <span className="flex items-center opacity-60 group-hover/action:opacity-100 group-focus-within/action:opacity-100">
                    <button
                      type="button"
                      aria-label={`Move action ${i + 1} up`}
                      data-tooltip="Move up"
                      disabled={i === 0}
                      onClick={() => moveAction(i, -1)}
                      className="btn-icon size-6"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move action ${i + 1} down`}
                      data-tooltip="Move down"
                      disabled={i === branch.actions.length - 1}
                      onClick={() => moveAction(i, 1)}
                      className="btn-icon size-6"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove action ${i + 1}`}
                      data-tooltip="Remove action"
                      disabled={branch.actions.length === 1}
                      onClick={() => setAction(i, null)}
                      className="btn-icon size-6"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                ) : null}
              </div>
              <BlockActionFields projectId={projectId} prefix={`${prefix}-a${i}`} action={action} ctx={ctx} onChange={(next) => setAction(i, next)} />
              </StepParams>
            </li>
            );
          })}
        </ol>
        {canEdit && branch.actions.length < MAX_BRANCH_ACTIONS ? (
          <SmartPicker
            label="Add action"
            value={null}
            options={actionOptions}
            onChange={(v) => onChange({ ...branch, actions: [...branch.actions, defaultsFor(v as ActionType)] })}
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
    </div>
  );
}

// The keys a step is still missing (its editors are highlighted).
function missingKeys(step: { type: string } & Record<string, Json>, scope: StepScope) {
  return missingParams(step, scope).map((p) => p.key);
}

function InlineActionFields(props: Parameters<typeof ActionFields>[0]) {
  return INLINE_ACTION_TYPES.has(props.action.type) ? <ActionFields {...props} part="inline" /> : null;
}

function BlockActionFields(props: Parameters<typeof ActionFields>[0]) {
  if (INLINE_ACTION_TYPES.has(props.action.type) && !INLINE_AND_BLOCK_ACTION_TYPES.has(props.action.type)) return null;
  return (
    <div className="ml-5 mt-1.5 max-w-xl">
      <ActionFields {...props} part="block" />
    </div>
  );
}

// The Activity tab: this rule's latest runs (the run log), with the branch each one took. A row opens
// to the run's steps (what each action did, or the error that stopped it); "Failed only" narrows it.
function Activity({
  projectId,
  rule,
  runs,
  branches,
}: {
  projectId: string;
  rule: RuleDef | null;
  runs: RuleRun[];
  branches: RuleBranch[];
}) {
  const [failedOnly, setFailedOnly] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const failedCount = runs.filter((r) => r.status === "failed").length;
  const shown = failedOnly ? runs.filter((r) => r.status === "failed") : runs;

  function toggle(runId: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  return (
    <div className="min-w-0 flex-1 px-4 py-6 lg:min-h-0 lg:overflow-y-auto">
      <div className="mx-auto max-w-2xl">
        {!rule ? (
          <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-8 text-center text-sm text-zinc-500">
            Create the rule to see when it runs.
          </p>
        ) : runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-8 text-center text-sm text-zinc-500">
            This rule hasn’t run yet. Runs show here once its trigger fires on a task.
          </p>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <div role="group" aria-label="Show" className="inline-flex h-7 items-center rounded-md bg-zinc-100 p-0.5">
                {[
                  { value: false, label: "All" },
                  { value: true, label: `Failed only${failedCount ? ` (${failedCount})` : ""}` },
                ].map((option) => (
                  <button
                    key={String(option.value)}
                    type="button"
                    aria-pressed={failedOnly === option.value}
                    onClick={() => setFailedOnly(option.value)}
                    className="h-6 rounded px-2 text-sm text-zinc-600 hover:text-zinc-900 aria-pressed:bg-white aria-pressed:font-medium aria-pressed:text-zinc-900 aria-pressed:shadow-xs"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-8 text-center text-sm text-zinc-500">
                No failed runs among the latest {runs.length}.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
                {shown.map((r) => {
                  const reason = runReason(r.detail);
                  const detail = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? r.detail : {};
                  const branch = typeof detail.branch === "number" ? detail.branch : null;
                  const branchName =
                    branch !== null && branches[branch]
                      ? branchLabel(branch, branches.length, branches[branch].conditions.length > 0)
                      : branch !== null
                        ? `Branch ${branch + 1}`
                        : null;
                  const expanded = open.has(r.id);
                  const stepsId = `run-${r.id}-steps`;
                  const logged = runSteps(r.detail);
                  return (
                    <li key={r.id}>
                      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => toggle(r.id)}
                          aria-expanded={expanded}
                          aria-controls={expanded ? stepsId : undefined}
                          aria-label={`Steps of this run (${RUN_LABEL[r.status]})`}
                          data-tooltip={expanded ? "Hide steps" : "Show steps"}
                          className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-zinc-100"
                        >
                          <ChevronRight className={`size-3.5 text-zinc-400 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden />
                          <span className={`rounded-full px-2 py-0.5 text-2xs font-medium ${RUN_STATUS[r.status]}`}>{RUN_LABEL[r.status]}</span>
                        </button>
                        {r.taskId ? (
                          <Link href={`/projects/${projectId}/list?task=${r.taskId}`} className="min-w-0 truncate text-sm text-zinc-800 hover:underline">
                            {r.taskTitle}
                          </Link>
                        ) : (
                          <span className="text-sm text-zinc-500">A task you can’t open</span>
                        )}
                        {branchName ? (
                          <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
                            <GitBranch className="size-3" aria-hidden />
                            {branchName}
                          </span>
                        ) : null}
                        {reason ? (
                          <span title={reason} className="min-w-0 truncate text-xs text-zinc-500">
                            · {reason}
                          </span>
                        ) : null}
                        <span className="ml-auto text-xs text-zinc-400">
                          <Timestamp iso={r.createdAt} />
                        </span>
                      </div>
                      {expanded ? (
                        <div id={stepsId} className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-3">
                          {r.status === "skipped" ? (
                            <p className="text-xs text-zinc-600">Skipped{reason ? `: ${reason}` : ""}. Nothing ran.</p>
                          ) : (
                            <RunSteps steps={logged.steps} error={logged.error} />
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        <p className="mt-3 text-xs text-zinc-500">The latest 50 runs. Runs that found no matching branch aren’t logged.</p>
      </div>
    </div>
  );
}
