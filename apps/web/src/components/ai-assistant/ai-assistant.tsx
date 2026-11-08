"use client";

// AI builder round 3 (experimental, note 171), "AI everywhere": the global assistant. Mounted once by the
// app shell; opened from the top bar's "Ask AI" or Tab then A on any page — project List / Board / other
// views, the task pane, My tasks, the automation pages. Only for workspace admins of the Testing data
// pilot (the server answers; every request checks again and fails closed).
//
// It's a floating panel (the panel layer), not a right panel: the task pane must stay open beside it so
// the open task is the assistant's context. The page goes to the server as kinds and ids only
// (assistantPageFromPath); the server loads names, sections, fields, people, and automations itself.
//
// Flow: the request (typed, or dictated into the box with the mic, then reviewed) → the change set, each
// change with its before → after (automations as the rule builder's sentence), each one can be left out
// → Confirm writes them (nothing is written before) → Undo puts them back.
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, Check, Loader2, Sparkles, Undo2, X } from "lucide-react";
import {
  ASSISTANT_LIMITS,
  ASSISTANT_PAGE_LABELS,
  assistantPageFromPath,
  opDependency,
  type AssistantOp,
  type AssistantRuleBody,
} from "@alhc/core/ai-assistant";
import { AI_BUILDER_CALLS } from "@alhc/core/ai-builder";
import type { AssistantProposal, AssistantUndoResult } from "@alhc/core/api/ai-assistant/model";
import { LAYER } from "@/lib/layers";
import { applyAssistantChanges, cancelAssistantRun, loadAssistantAccess, undoAssistantChanges } from "@/lib/actions/ai-assistant";
import { MicButton } from "@/components/ai-builder/speech";
import { ruleSentence, type RuleContext } from "@/components/rules/rule-shared";
import { useTaskPane } from "@/components/shell/right-panel";
import { useTabChord } from "@/components/shortcuts/keyboard";
import { invalidateTaskPanes } from "@/components/task/task-pane-store";
import { closeAssistant, setAssistantAccess, toggleAssistant, useAssistantState } from "./assistant-store";

export function AiAssistant() {
  const { access, open } = useAssistantState();
  useEffect(() => {
    let live = true;
    loadAssistantAccess()
      .then((res) => {
        if (live) setAssistantAccess(res.data ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  useTabChord("a", () => toggleAssistant());
  if (!access?.ready || !open) return null;
  return <AssistantDock configured={access.configured} />;
}

type Phase =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "proposal"; proposal: AssistantProposal; selected: Set<number> }
  | { kind: "applying"; proposal: AssistantProposal; selected: Set<number> }
  | { kind: "applied"; proposal: AssistantProposal; count: number; undo: AssistantUndoResult | null; undoing: boolean };

const MODEL_NAMES: Record<string, string> = { "claude-haiku-5-5": "Haiku 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-opus-5-5": "Opus 5.5" };
const ROUTE_LABELS: Record<string, string> = {
  small_edit: "a small edit",
  rules_page: "automations",
  mentions_rules: "automations",
  long_request: "a longer request",
  multi_step: "several steps",
  escalated_rules: "automations (asked again of the larger model)",
  escalated_size: "many changes (asked again of the larger model)",
  escalated_invalid: "asked again of the larger model",
};

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function AssistantDock({ configured }: { configured: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { task } = useTaskPane();
  const page = useMemo(() => assistantPageFromPath(pathname, task ?? null), [pathname, task]);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const applyKey = useRef<string | null>(null);

  // Escape (inside the panel) closes it.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        closeAssistant();
      }
    };
    el.addEventListener("keydown", onKey);
    el.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  async function ask() {
    const instruction = text.trim();
    if (!instruction || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    if (phase.kind === "proposal") void cancelAssistantRun(phase.proposal.runId).catch(() => undefined);
    setPhase({ kind: "thinking" });
    try {
      const res = await fetch("/api/ai-assistant/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestKey: crypto.randomUUID(), page, instruction, localToday: localToday() }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<AssistantProposal> & { error?: string };
      if (!res.ok || !body.runId || !Array.isArray(body.ops)) {
        setError(body.error ?? "The AI couldn’t answer that. Try again.");
        setPhase({ kind: "idle" });
        return;
      }
      const proposal = body as AssistantProposal;
      applyKey.current = null;
      setPhase({ kind: "proposal", proposal, selected: new Set(proposal.ops.map((_, i) => i)) });
    } catch {
      setError("The AI couldn’t answer. Check your connection and try again.");
      setPhase({ kind: "idle" });
    } finally {
      inFlight.current = false;
    }
  }

  function toggle(index: number) {
    if (phase.kind !== "proposal") return;
    const next = new Set(phase.selected);
    const ops = phase.proposal.ops;
    if (next.has(index)) {
      next.delete(index);
      // A move into a new section goes with that section.
      ops.forEach((op, i) => {
        if (opDependency(op) === index) next.delete(i);
      });
    } else {
      next.add(index);
      const dep = opDependency(ops[index]);
      if (dep !== null) next.add(dep);
    }
    setPhase({ ...phase, selected: next });
  }

  async function confirm() {
    if (phase.kind !== "proposal" || phase.selected.size === 0) return;
    const { proposal, selected } = phase;
    applyKey.current ??= crypto.randomUUID();
    setError(null);
    setPhase({ kind: "applying", proposal, selected });
    try {
      const res = await applyAssistantChanges({
        runId: proposal.runId,
        applyKey: applyKey.current,
        selected: [...selected],
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (res.error) {
        setError(res.error);
        // A refused or stale change set can't be applied again: ask anew.
        setPhase({ kind: "idle" });
        return;
      }
      invalidateTaskPanes();
      router.refresh();
      setText("");
      setPhase({ kind: "applied", proposal, count: res.applied ?? selected.size, undo: null, undoing: false });
    } catch {
      setError("Couldn’t reach the server. Nothing was confirmed; try again.");
      setPhase({ kind: "proposal", proposal, selected });
    }
  }

  async function undo() {
    if (phase.kind !== "applied" || phase.undoing) return;
    setError(null);
    setPhase({ ...phase, undoing: true });
    try {
      const res = await undoAssistantChanges(phase.proposal.runId);
      if (res.error || !res.undo) {
        setError(res.error ?? "Undo didn’t finish. Try again.");
        setPhase({ ...phase, undoing: false });
        return;
      }
      invalidateTaskPanes();
      router.refresh();
      setPhase({ ...phase, undo: res.undo, undoing: false });
    } catch {
      setError("Couldn’t reach the server. Try Undo again.");
      setPhase({ ...phase, undoing: false });
    }
  }

  function dismiss() {
    if (phase.kind === "proposal") void cancelAssistantRun(phase.proposal.runId).catch(() => undefined);
    setPhase({ kind: "idle" });
  }

  const busy = phase.kind === "thinking" || phase.kind === "applying";
  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby="ai-assistant-title"
      data-ai-assistant
      className={`fixed right-4 bottom-4 ${LAYER.panel} flex max-h-[calc(100vh-5rem)] w-[min(27rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white text-sm shadow-2xl print:hidden`}
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2">
        <Sparkles className="size-4 text-violet-700" aria-hidden />
        <h2 id="ai-assistant-title" className="flex-1 font-semibold text-zinc-900">
          AI assistant
        </h2>
        <span className="chip text-2xs">Experimental · Testing data</span>
        <button type="button" className="btn-icon" aria-label="Close the AI assistant" data-tooltip="Close (Esc)" onClick={closeAssistant}>
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3">
        <p className="text-2xs text-zinc-500">
          Working on <strong className="font-medium text-zinc-700">{phase.kind !== "idle" && phase.kind !== "thinking" ? phase.proposal.contextLabel : ASSISTANT_PAGE_LABELS[page.kind]}</strong>.
          It shows every change first; nothing changes until you confirm.
        </p>
        {phase.kind === "proposal" || phase.kind === "applying" ? (
          <ProposalView proposal={phase.proposal} selected={phase.selected} disabled={phase.kind === "applying"} onToggle={toggle} />
        ) : null}
        {phase.kind === "applied" ? <AppliedView phase={phase} /> : null}
        {error ? (
          <p role="alert" className="rounded-md bg-red-50 px-2 py-1.5 text-sm text-red-800">
            {error}
          </p>
        ) : null}
        {!configured ? (
          <p role="status" className="text-sm text-amber-900">
            The AI isn’t configured on this deployment (no model key).
          </p>
        ) : null}
      </div>
      <div className="border-t border-zinc-200 px-3 py-2">
        {phase.kind === "proposal" || phase.kind === "applying" ? (
          <div className="mb-2 flex items-center gap-2">
            <button type="button" className="btn-secondary h-8 px-3" onClick={dismiss} disabled={phase.kind === "applying"}>
              Discard
            </button>
            <span className="flex-1" />
            <button type="button" className="btn-primary h-8 px-3" onClick={() => void confirm()} disabled={phase.kind === "applying" || phase.selected.size === 0}>
              {phase.kind === "applying" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
              {phase.kind === "applying" ? "Applying…" : `Confirm ${phase.selected.size} change${phase.selected.size === 1 ? "" : "s"}`}
            </button>
          </div>
        ) : null}
        {phase.kind === "applied" && phase.undo?.status !== "undone" && phase.undo?.status !== "already_undone" ? (
          <div className="mb-2 flex items-center gap-2">
            <span className="flex-1 text-sm text-green-800">
              Applied {phase.count} change{phase.count === 1 ? "" : "s"}.
            </span>
            <button type="button" className="btn-secondary h-8 px-3" onClick={() => void undo()} disabled={phase.undoing}>
              {phase.undoing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Undo2 className="size-4" aria-hidden />}
              Undo
            </button>
          </div>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <textarea
            aria-label="Ask the AI to change something"
            value={text}
            onChange={(e) => setText(e.currentTarget.value.slice(0, ASSISTANT_LIMITS.instructionMaxChars))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void ask();
              }
            }}
            rows={2}
            disabled={busy || !configured}
            placeholder={placeholderFor(page.kind)}
            className="field h-auto w-full py-2"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <MicButton text={text} onText={(next) => setText(next.slice(0, ASSISTANT_LIMITS.instructionMaxChars))} disabled={busy || !configured} />
            <span className="flex-1 truncate text-2xs text-zinc-500">
              {MODEL_NAMES[AI_BUILDER_CALLS.assistant_small.model]} for small edits, {MODEL_NAMES[AI_BUILDER_CALLS.assistant_large.model]} for automations
            </span>
            <button type="submit" className="btn-primary h-8 px-3" disabled={busy || !text.trim() || !configured}>
              {phase.kind === "thinking" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
              {phase.kind === "thinking" ? "Thinking…" : "Ask"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function placeholderFor(kind: string) {
  switch (kind) {
    case "rules":
    case "rule":
      return "When a task moves into Review, assign it to its creator…";
    case "task":
      return "Rename this, move it to In progress, due next Friday…";
    case "my_tasks":
      return "Push my overdue tasks to next Monday…";
    default:
      return "Add a Blocked section after In progress, then move…";
  }
}

function ProposalView({
  proposal,
  selected,
  disabled,
  onToggle,
}: {
  proposal: AssistantProposal;
  selected: Set<number>;
  disabled: boolean;
  onToggle: (index: number) => void;
}) {
  const ruleCtx: RuleContext = { ...proposal.ruleContext, forms: [], integrations: null, inboundEndpoints: [], members: proposal.ruleContext.people };
  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-800">{proposal.summary}</p>
      <ul className="space-y-1.5" aria-label="Changes to confirm">
        {proposal.ops.map((op, i) => (
          <li key={i} className="rounded-lg border border-zinc-200 px-2.5 py-2">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={selected.has(i)} disabled={disabled} onChange={() => onToggle(i)} aria-label={`Include: ${op.label}`} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-zinc-900">{op.label}</span>
                <OpDiff op={op} ruleCtx={ruleCtx} />
                {opDependency(op) !== null ? <span className="text-2xs text-zinc-500">Needs change {(opDependency(op) ?? 0) + 1}.</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {proposal.rejected.length || proposal.unsupported ? (
        <div className="rounded-md bg-amber-50 px-2.5 py-2 text-2xs text-amber-900">
          <p className="font-semibold">Left out</p>
          {proposal.unsupported ? <p className="mt-0.5">{proposal.unsupported}</p> : null}
          <ul className="mt-0.5 list-disc pl-4">
            {proposal.rejected.map((r, i) => (
              <li key={i}>{r.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-2xs text-zinc-500">
        {MODEL_NAMES[proposal.model] ?? proposal.model} · {ROUTE_LABELS[proposal.routeReason] ?? proposal.routeReason}
      </p>
    </div>
  );
}

const sentence = (rule: AssistantRuleBody, ctx: RuleContext) => ruleSentence(rule, ctx);

function OpDiff({ op, ruleCtx }: { op: AssistantOp; ruleCtx: RuleContext }) {
  if (op.op === "create_rule") {
    return (
      <span className="mt-0.5 block text-xs text-zinc-700">
        {sentence(op.rule, ruleCtx)} <span className="text-zinc-500">Starts off.</span>
      </span>
    );
  }
  if (op.op === "update_rule") {
    return (
      <span className="mt-0.5 block space-y-1 text-xs">
        <span className="block text-zinc-500 line-through decoration-zinc-300">{sentence(op.previous, ruleCtx)}</span>
        <span className="block text-zinc-800">{sentence(op.rule, ruleCtx)}</span>
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs">
      <span className="text-zinc-500 line-through decoration-zinc-300">{op.before}</span>
      <ArrowRight className="size-3 text-zinc-400" aria-label="becomes" />
      <span className="text-zinc-800">{op.after}</span>
    </span>
  );
}

function AppliedView({ phase }: { phase: Extract<Phase, { kind: "applied" }> }) {
  const undo = phase.undo;
  if (undo?.status === "undone" || undo?.status === "already_undone") {
    return <p className="text-sm text-zinc-700">Undone. Everything the assistant changed is back as it was.</p>;
  }
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-zinc-800">{phase.proposal.summary}</p>
      {undo?.status === "conflict" ? (
        <div role="alert" className="rounded-md bg-amber-50 px-2.5 py-2 text-2xs text-amber-900">
          <p className="font-semibold">Undo didn’t change anything: some of it changed since.</p>
          <ul className="mt-0.5 list-disc pl-4">
            {undo.conflicts.slice(0, 8).map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
