"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  FolderClosed,
  GitBranch,
  Plus,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { SmartPicker } from "@/components/smart-picker";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { createRule, updateRule, type RevealedSigningSecret } from "@/lib/actions";
import {
  ACTIONS,
  CONDITIONS,
  MAX_BRANCH_ACTIONS,
  MAX_BRANCH_CONDITIONS,
  MAX_RULE_BRANCHES,
  TEXT_TOKENS,
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
import { ActionFields, ConditionFields, RevealedSecrets, TriggerFields, defaultsFor } from "./rule-editor";
import { vocabOptions } from "./rule-icons";
import { branchLabel, ruleSentence, type RuleContext } from "./rule-shared";

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

// Asana's rule builder (Asana parity, batch 4): a full-page canvas. The header has the rule's name, an
// Active toggle, Cancel, and Save, with Build and Activity tabs. The flow reads top to bottom: the scope
// (tasks in this project), the trigger, then "Check if" with its actions, optional "Else if" branches,
// and "Otherwise", with "+ Add branch". Branches are stored as branch keys on the rule's conditions and
// actions (run_rule runs the first branch whose conditions pass), so rules without branches are exactly
// what they were and keep running unchanged.
export function RuleCanvas({
  projectId,
  projectName,
  rule,
  runs,
  ctx,
  batch4,
  canEdit,
  backHref,
}: {
  projectId: string;
  projectName: string;
  // Null = a new rule.
  rule: RuleDef | null;
  runs: RuleRun[];
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
  const [name, setName] = useState(rule?.name ?? "");
  const [enabled, setEnabled] = useState(rule ? rule.enabled : true);
  const [triggerType, setTriggerType] = useState<TriggerType>(rule?.triggerType ?? "section_changed");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, Json>>(rule?.triggerConfig ?? {});
  const [branches, setBranches] = useState<RuleBranch[]>(() =>
    rule ? splitBranches(rule) : [{ conditions: [], actions: [defaultsFor("add_comment")] }],
  );
  const [tab, setTab] = useState<"build" | "activity">("build");
  const [dirty, setDirty] = useState(false);
  const [revealed, setRevealed] = useState<RevealedSigningSecret[] | null>(null);
  const dirtyRef = useRef(dirty);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  function leave() {
    if (dirtyRef.current && !window.confirm("Discard your changes to this rule?")) return;
    router.push(backHref);
  }
  const leaveRef = useRef(leave);
  useEffect(() => {
    leaveRef.current = leave;
  });

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      leaveRef.current();
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

  function save() {
    const problem = branchProblem(branches);
    if (problem) {
      notify(problem);
      return;
    }
    const { conditions, actions } = joinBranches(branches);
    run(async () => {
      const input = { name, triggerType, triggerConfig, conditions, actions, enabled };
      const result = rule ? await updateRule(rule.id, input) : await createRule(projectId, input);
      if (!result.error) {
        setDirty(false);
        dirtyRef.current = false;
        if (result.signingSecrets?.length) setRevealed(result.signingSecrets);
        else {
          notify(rule ? "Rule saved" : enabled ? "Rule created and on" : "Rule created (off)");
          router.push(backHref);
        }
      }
      return result;
    });
  }

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
          <span className="hidden sm:inline">{enabled ? "Active" : "Off"}</span>
          <span className="sr-only sm:hidden">Active</span>
        </label>
        <button type="button" onClick={leave} className="btn-secondary h-8 px-3">
          {canEdit ? "Cancel" : "Close"}
        </button>
        {canEdit ? (
          <button type="button" onClick={save} disabled={pending || !name.trim()} className="btn-primary h-8 px-3">
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
      ) : tab === "activity" ? (
        <Activity projectId={projectId} rule={rule} runs={runs} branches={branches} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-50">
          <fieldset disabled={!canEdit} className="m-0 mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 border-0 px-4 py-6">
            {!canEdit ? (
              <p className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600">
                View only: project admins and owners change rules.
              </p>
            ) : null}
            <RuleSummary triggerType={triggerType} triggerConfig={triggerConfig} branches={branches} ctx={ctx} projectName={projectName} />
            <section aria-label="Rule" className="rounded-xl border border-zinc-200 bg-white shadow-sm">
              <SentenceRow word="When">
                <SmartPicker
                  id="rule-trigger"
                  label="Trigger"
                  value={triggerType}
                  options={vocabOptions(TRIGGERS)}
                  onChange={(v) => {
                    setTriggerType(v as TriggerType);
                    setTriggerConfig({});
                    setDirty(true);
                  }}
                  variant="chip"
                  searchable
                  panelWidth={340}
                />
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
            </section>
            <p className="text-center text-xs text-zinc-500">
              Rules never trigger themselves, chains stop after a few rules, and the Status field always follows the
              section. Text can use {TEXT_TOKENS}.
            </p>
          </fieldset>
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
}: {
  index: number;
  count: number;
  branch: RuleBranch;
  ctx: RuleContext;
  projectId: string;
  canEdit: boolean;
  onChange: (next: RuleBranch) => void;
  onRemove?: () => void;
}) {
  const label = branchLabel(index, count, branch.conditions.length > 0);
  const otherwise = label === "Otherwise";
  const prefix = `branch-${index}`;
  const ifWord = index === 0 ? "If" : otherwise ? "Otherwise" : "Otherwise if";

  function setCondition(i: number, next: RuleCondition | null) {
    onChange({
      ...branch,
      conditions: next ? branch.conditions.map((c, j) => (j === i ? next : c)) : branch.conditions.filter((_, j) => j !== i),
    });
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

  const removeBranch = onRemove ? (
    <button type="button" onClick={onRemove} aria-label={`Remove this ${label} branch`} data-tooltip="Remove branch" className="btn-icon">
      <X className="size-4" />
    </button>
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
            {branch.conditions.map((condition, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1">
                {i > 0 ? <span className="mr-0.5 text-xs font-semibold text-zinc-400">and</span> : null}
                <ConditionFields prefix={`${prefix}-c${i}`} condition={condition} ctx={ctx} onChange={(next) => setCondition(i, next)} />
                {canEdit ? (
                  <button
                    type="button"
                    aria-label={`Remove condition ${i + 1}`}
                    data-tooltip="Remove condition"
                    onClick={() => setCondition(i, null)}
                    className="btn-icon size-6"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
            {canEdit && branch.conditions.length < MAX_BRANCH_CONDITIONS ? (
              <SmartPicker
                label="Add condition"
                value={null}
                options={vocabOptions(CONDITIONS)}
                onChange={(v) => onChange({ ...branch, conditions: [...branch.conditions, { type: v as ConditionType }] })}
                variant="ghost"
                searchable
                className="h-6 self-start px-1.5 text-xs"
                renderValue={() => (
                  <>
                    <Plus className="size-3.5" aria-hidden />
                    {branch.conditions.length ? "And…" : "Add condition"}
                  </>
                )}
              />
            ) : null}
          </>
        )}
      </SentenceRow>
      <SentenceRow word="Then">
        <ol className="flex flex-col gap-2">
          {branch.actions.map((action, i) => (
            <li key={i} className="group/action rounded-lg border border-transparent px-1 py-0.5 hover:border-zinc-200">
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-4 text-xs font-medium tabular-nums text-zinc-400">{i + 1}.</span>
                <SmartPicker
                  label={`Action ${i + 1}`}
                  value={action.type}
                  options={vocabOptions(ACTIONS)}
                  onChange={(v) => setAction(i, defaultsFor(v as ActionType))}
                  variant="chip"
                  searchable
                  panelWidth={340}
                />
                <InlineActionFields projectId={projectId} prefix={`${prefix}-a${i}`} action={action} ctx={ctx} onChange={(next) => setAction(i, next)} />
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
            </li>
          ))}
        </ol>
        {canEdit && branch.actions.length < MAX_BRANCH_ACTIONS ? (
          <SmartPicker
            label="Add action"
            value={null}
            options={vocabOptions(ACTIONS)}
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

// Actions whose settings fit on the sentence line (a section, a field and value, a person, hours).
const INLINE_ACTIONS = new Set<string>(["move_section", "set_field", "set_assignee", "add_followers", "request_approval", "delay"]);

function InlineActionFields(props: Parameters<typeof ActionFields>[0]) {
  return INLINE_ACTIONS.has(props.action.type) ? <ActionFields {...props} part="inline" /> : null;
}

function BlockActionFields(props: Parameters<typeof ActionFields>[0]) {
  if (INLINE_ACTIONS.has(props.action.type) && props.action.type !== "request_approval") return null;
  return (
    <div className="ml-5 mt-1.5 max-w-xl">
      <ActionFields {...props} part="block" />
    </div>
  );
}

// The Activity tab: this rule's latest runs (the run log), with the branch each one took.
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
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
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
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
            {runs.map((r) => {
              const reason = runReason(r.detail);
              const detail = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? r.detail : {};
              const branch = typeof detail.branch === "number" ? detail.branch : null;
              const branchName =
                branch !== null && branches[branch]
                  ? branchLabel(branch, branches.length, branches[branch].conditions.length > 0)
                  : branch !== null
                    ? `Branch ${branch + 1}`
                    : null;
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-2xs font-medium ${RUN_STATUS[r.status]}`}>{RUN_LABEL[r.status]}</span>
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
                  {reason ? <span className="text-xs text-zinc-500">· {reason}</span> : null}
                  <span className="ml-auto text-xs text-zinc-400">
                    <Timestamp iso={r.createdAt} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-xs text-zinc-500">The latest 50 runs. Runs that found no matching branch aren’t logged.</p>
      </div>
    </div>
  );
}
