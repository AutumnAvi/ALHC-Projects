"use client";

// AI builder round 3 (experimental, note 171), "AI everywhere": the global assistant. Mounted once by the
// app shell; only for workspace admins of the Testing data pilot (the server answers; every request checks
// again and fails closed). Round 4 (notes 172–176):
//   * a floating bubble (note 176) replaces the top bar's "Ask AI": click it (or Tab then A) to open the
//     panel next to it; drag it anywhere — it snaps to the nearest edge, stays on screen, can be moved
//     with the arrow keys, and is remembered per person in this browser;
//   * the bubble and panel sit on their own layer, above modals (the rule canvas, the full-screen task)
//     and below menus, alerts, and toasts (lib/layers.ts), so "Edit with AI" works on an automation's page;
//   * how-to questions get a plain answer (answer mode); Commenters and Viewers only ever get answers;
//   * every new or edited automation can be expanded in place (the whole automation, read-only, in the
//     builder's layout), and new ones turned on right after Confirm (Turn on & Finish);
//   * the box stays enabled while the AI thinks (dictation that lands meanwhile is kept), and Escape in a
//     box with text never closes the panel (dictation tools use Escape to cancel).
//
// The panel isn't a right panel: the task pane must stay open beside it so the open task is the
// assistant's context. The page goes to the server as kinds and ids only; the server loads the rest.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, Check, LocateFixed, Loader2, Maximize2, MessageCircleQuestion, Sparkles, Undo2, X } from "lucide-react";
import {
  ASSISTANT_LIMITS,
  ASSISTANT_PAGE_LABELS,
  assistantPageFromPath,
  opDependency,
  type AssistantOp,
  type AssistantRuleBody,
} from "@alhc/core/ai-assistant";
import { ANSWER_ONLY_NOTE } from "@alhc/core/ai-capabilities";
import { AI_BUILDER_CALLS } from "@alhc/core/ai-builder";
import type { AssistantApplyResult, AssistantProposal, AssistantUndoResult } from "@alhc/core/api/ai-assistant/model";
import { LAYER } from "@/lib/layers";
import {
  bubbleXY,
  BUBBLE_SIZE,
  defaultBubblePos,
  describeBubble,
  dragPoint,
  isDrag,
  keyMove,
  panelPlacement,
  parseBubblePos,
  serializeBubblePos,
  snapBubble,
  storageKey,
  type BubblePos,
  type Point,
  type Viewport,
} from "@/lib/assistant-bubble";
import { applyAssistantChanges, cancelAssistantRun, loadAssistantAccess, turnOnAssistantRules, undoAssistantChanges } from "@/lib/actions/ai-assistant";
import { MicButton } from "@/components/ai-builder/speech";
import { RuleReadOnly } from "@/components/rules/rule-readonly";
import { ruleSentence, type RuleContext } from "@/components/rules/rule-shared";
import { useTaskPane } from "@/components/shell/right-panel";
import { useShellMemberId } from "@/components/shell/shell-context";
import { ASSISTANT_ALLOWED, useTabChord } from "@/components/shortcuts/keyboard";
import { assistantKeyHandler } from "./assistant-keys";
import { invalidateTaskPanes } from "@/components/task/task-pane-store";
import {
  UNSAVED_CANVAS,
  blockedByCanvas,
  clearAssistantPage,
  closeAssistant,
  setAssistantAccess,
  toggleAssistant,
  useAssistantState,
} from "./assistant-store";

// ---- Mount ----------------------------------------------------------------------------------------

// The window's size (null on the server), re-read on resize — the bubble re-clamps itself on screen.
let viewportCache: Viewport | null = null;
const subscribeResize = (l: () => void) => {
  window.addEventListener("resize", l);
  return () => window.removeEventListener("resize", l);
};
function viewportSnapshot(): Viewport {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!viewportCache || viewportCache.width !== w || viewportCache.height !== h) viewportCache = { width: w, height: h };
  return viewportCache;
}
function useViewport(): Viewport | null {
  return useSyncExternalStore(subscribeResize, viewportSnapshot, () => null);
}

// Where this person left the bubble in this browser (localStorage; null = the default spot).
const bubbleListeners = new Set<() => void>();
let bubbleCache: { key: string; raw: string | null; pos: BubblePos | null } | null = null;
const subscribeBubble = (l: () => void) => {
  bubbleListeners.add(l);
  window.addEventListener("storage", l);
  return () => {
    bubbleListeners.delete(l);
    window.removeEventListener("storage", l);
  };
};
function storedBubble(key: string): BubblePos | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    raw = null;
  }
  if (!bubbleCache || bubbleCache.key !== key || bubbleCache.raw !== raw) bubbleCache = { key, raw, pos: parseBubblePos(raw) };
  return bubbleCache.pos;
}
function saveBubble(key: string, next: BubblePos | null) {
  try {
    if (next) window.localStorage.setItem(key, serializeBubblePos(next));
    else window.localStorage.removeItem(key);
  } catch {
    // Private mode: it just isn't remembered.
  }
  for (const l of bubbleListeners) l();
}

export function AiAssistant() {
  const { access, open } = useAssistantState();
  const memberId = useShellMemberId();
  const viewport = useViewport();
  const key = storageKey(memberId);
  const pos = useSyncExternalStore(subscribeBubble, () => storedBubble(key), () => null);
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
  const place = useCallback((next: BubblePos | null) => saveBubble(key, next), [key]);
  // Tab then A also over the rule canvas and the full-screen task (data-assistant-allowed).
  useTabChord("a", () => toggleAssistant(), { allowOver: ASSISTANT_ALLOWED });
  if (!access?.ready || !viewport) return null;
  const at = pos ?? defaultBubblePos(viewport);
  return (
    <>
      <AssistantBubble pos={at} viewport={viewport} open={open} onMove={place} />
      {open ? <AssistantDock configured={access.configured} placement={panelPlacement(at, viewport)} onResetPosition={pos ? () => place(null) : undefined} /> : null}
    </>
  );
}

// ---- The bubble -----------------------------------------------------------------------------------

export function AssistantBubble({ pos, viewport, open, onMove }: { pos: BubblePos; viewport: Viewport; open: boolean; onMove: (pos: BubblePos) => void }) {
  const [drag, setDrag] = useState<Point | null>(null);
  const [said, setSaid] = useState("");
  const press = useRef<{ start: Point; grab: Point; id: number; dragging: boolean } | null>(null);
  const moved = useRef(false);
  const xy = drag ?? bubbleXY(pos, viewport);

  return (
    <>
      <button
        type="button"
        data-ai-bubble
        aria-label="AI assistant"
        aria-expanded={open}
        aria-describedby="ai-bubble-hint"
        data-tooltip={open ? undefined : "AI assistant (Tab then A) · drag to move"}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          moved.current = false;
          press.current = { start: { x: e.clientX, y: e.clientY }, grab: { x: e.clientX - xy.x, y: e.clientY - xy.y }, id: e.pointerId, dragging: false };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (!p || p.id !== e.pointerId) return;
          if (!p.dragging) {
            if (!isDrag(p.start, { x: e.clientX, y: e.clientY })) return;
            p.dragging = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }
          setDrag(dragPoint({ x: e.clientX, y: e.clientY }, p.grab, viewport));
        }}
        onPointerUp={(e) => {
          const p = press.current;
          press.current = null;
          if (!p?.dragging) return;
          moved.current = true;
          const next = snapBubble(dragPoint({ x: e.clientX, y: e.clientY }, p.grab, viewport), viewport);
          setDrag(null);
          onMove(next);
          setSaid(describeBubble(next));
        }}
        onPointerCancel={() => {
          press.current = null;
          setDrag(null);
        }}
        onClick={() => {
          // A drag isn't a click.
          if (moved.current) {
            moved.current = false;
            return;
          }
          toggleAssistant();
        }}
        onKeyDown={(e) => {
          const next = keyMove(pos, e, viewport);
          if (!next) return;
          e.preventDefault();
          onMove(next);
          setSaid(describeBubble(next));
        }}
        style={{ left: xy.x, top: xy.y, width: BUBBLE_SIZE, height: BUBBLE_SIZE, touchAction: "none" }}
        className={`fixed ${LAYER.assistant} flex items-center justify-center rounded-full bg-violet-700 text-white shadow-lg ring-2 ring-white transition-[background-color,box-shadow] hover:bg-violet-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-300 aria-expanded:bg-violet-900 print:hidden ${drag ? "cursor-grabbing shadow-2xl" : "cursor-pointer"}`}
      >
        {open ? <X className="size-5" aria-hidden /> : <Sparkles className="size-5" aria-hidden />}
      </button>
      <span id="ai-bubble-hint" className="sr-only">
        Opens the AI assistant (Tab then A). To move it, drag it, or use the arrow keys; Home puts it back.
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {said}
      </span>
    </>
  );
}

// ---- The panel ------------------------------------------------------------------------------------

type Phase =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "answer"; proposal: AssistantProposal }
  | { kind: "proposal"; proposal: AssistantProposal; selected: Set<number>; turnOn: Set<number> }
  | { kind: "applying"; proposal: AssistantProposal; selected: Set<number>; turnOn: Set<number> }
  | {
      kind: "applied";
      proposal: AssistantProposal;
      count: number;
      created: AssistantApplyResult["createdRules"];
      turnOn: Set<string>;
      turningOn: boolean;
      undo: AssistantUndoResult | null;
      undoing: boolean;
    };

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
  answer_question: "a question",
  answer_only_role: "answers only (your role here)",
};

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Placement = ReturnType<typeof panelPlacement>;

export function AssistantDock({ configured, placement, onResetPosition }: { configured: boolean; placement?: Placement; onResetPosition?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { task } = useTaskPane();
  const { page: pageOverride, hint, openSeq, canvas } = useAssistantState();
  const fromPath = useMemo(() => assistantPageFromPath(pathname, task ?? null), [pathname, task]);
  const page = pageOverride ?? fromPath;
  // "Edit with AI" opens with its starting words in the box (and again on each later open, while empty).
  const [text, setText] = useState(() => hint ?? "");
  const [seenOpen, setSeenOpen] = useState(openSeq);
  if (seenOpen !== openSeq) {
    setSeenOpen(openSeq);
    if (hint && !text.trim()) setText(hint);
  }
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<AssistantOp | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const asked = useRef<string | null>(null);
  const applyKey = useRef<string | null>(null);

  // "Edit with AI" set the page; moving to another page goes back to the page's own context.
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname !== firstPath.current) {
      firstPath.current = pathname;
      clearAssistantPage();
    }
  }, [pathname]);

  // Escape (inside the panel) closes it — see assistantKeyHandler.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const onKey = assistantKeyHandler(closeAssistant);
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  // Every open focuses the box, the caret after any starting words.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    requestAnimationFrame(() => {
      const len = el.value.length;
      el.setSelectionRange?.(len, len);
    });
  }, [openSeq, hint]);

  async function ask() {
    const instruction = text.trim();
    if (!instruction || inFlight.current) return;
    inFlight.current = true;
    asked.current = text;
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
      if (proposal.mode === "answer") {
        setPhase({ kind: "answer", proposal });
        clearIfUnchanged();
        return;
      }
      setPhase({ kind: "proposal", proposal, selected: new Set(proposal.ops.map((_, i) => i)), turnOn: new Set() });
    } catch {
      setError("The AI couldn’t answer. Check your connection and try again.");
      setPhase({ kind: "idle" });
    } finally {
      inFlight.current = false;
    }
  }

  // The box is cleared only when nobody typed or dictated into it since the request went out.
  function clearIfUnchanged() {
    setText((current) => (current === asked.current ? "" : current));
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

  function toggleTurnOn(index: number) {
    if (phase.kind !== "proposal") return;
    const next = new Set(phase.turnOn);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setPhase({ ...phase, turnOn: next });
  }

  const canvasBlocked =
    (phase.kind === "proposal" || phase.kind === "applying") &&
    blockedByCanvas(
      phase.proposal.ops.filter((_, i) => phase.selected.has(i)),
      canvas,
    );

  async function confirm() {
    if (phase.kind !== "proposal" || phase.selected.size === 0 || canvasBlocked) return;
    const { proposal, selected, turnOn } = phase;
    applyKey.current ??= crypto.randomUUID();
    setError(null);
    setPhase({ kind: "applying", proposal, selected, turnOn });
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
      clearIfUnchanged();
      const created = res.createdRules ?? [];
      setPhase({
        kind: "applied",
        proposal,
        count: res.applied ?? selected.size,
        created,
        turnOn: new Set(created.filter((c) => turnOn.has(c.index)).map((c) => c.ruleId)),
        turningOn: false,
        undo: null,
        undoing: false,
      });
    } catch {
      setError("Couldn’t reach the server. Nothing was confirmed; try again.");
      setPhase({ kind: "proposal", proposal, selected, turnOn });
    }
  }

  // Turn on & Finish (note 173): turns on the automations this run made that are ticked, then closes.
  async function turnOnAndFinish() {
    if (phase.kind !== "applied" || phase.turningOn || phase.turnOn.size === 0) return;
    setError(null);
    setPhase({ ...phase, turningOn: true });
    try {
      const res = await turnOnAssistantRules(phase.proposal.runId, [...phase.turnOn]);
      if (res.error) {
        setError(res.error);
        setPhase({ ...phase, turningOn: false });
        return;
      }
      router.refresh();
      closeAssistant();
    } catch {
      setError("Couldn’t reach the server. Nothing was turned on; try again.");
      setPhase({ ...phase, turningOn: false });
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
  const working = phase.kind !== "idle" && phase.kind !== "thinking" ? phase.proposal.contextLabel : ASSISTANT_PAGE_LABELS[page.kind];
  const style: CSSProperties | undefined = placement
    ? { left: placement.left, width: placement.width, maxHeight: placement.maxHeight, ...("top" in placement ? { top: placement.top } : { bottom: placement.bottom }) }
    : undefined;
  const ruleCtx = phase.kind !== "idle" && phase.kind !== "thinking" ? ruleCtxOf(phase.proposal) : null;
  const undone = phase.kind === "applied" && (phase.undo?.status === "undone" || phase.undo?.status === "already_undone");
  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby="ai-assistant-title"
      data-ai-assistant
      data-assistant-allowed
      style={style}
      className={`fixed ${placement ? "" : "right-4 bottom-4 max-h-[calc(100vh-5rem)] w-[min(27rem,calc(100vw-2rem))]"} ${LAYER.assistant} flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white text-sm shadow-2xl print:hidden`}
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2">
        <Sparkles className="size-4 text-violet-700" aria-hidden />
        <h2 id="ai-assistant-title" className="flex-1 font-semibold text-zinc-900">
          AI assistant
        </h2>
        <span className="chip text-2xs">Experimental · Testing data</span>
        {onResetPosition ? (
          <button type="button" className="btn-icon" aria-label="Reset the bubble’s position" data-tooltip="Put the bubble back where it started" onClick={onResetPosition}>
            <LocateFixed className="size-4" />
          </button>
        ) : null}
        <button type="button" className="btn-icon" aria-label="Close the AI assistant" data-tooltip="Close (Esc)" onClick={closeAssistant}>
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3">
        <p className="text-2xs text-zinc-500">
          Working on <strong className="font-medium text-zinc-700">{working}</strong>. It shows every change first; nothing changes until you confirm. Ask “how do I…?” for help with the app.
        </p>
        {phase.kind === "answer" ? <AnswerView proposal={phase.proposal} /> : null}
        {(phase.kind === "proposal" || phase.kind === "applying") && ruleCtx ? (
          <ProposalView
            proposal={phase.proposal}
            selected={phase.selected}
            turnOn={phase.turnOn}
            disabled={phase.kind === "applying"}
            onToggle={toggle}
            onToggleTurnOn={toggleTurnOn}
            onExpand={setExpanded}
            ruleCtx={ruleCtx}
          />
        ) : null}
        {phase.kind === "applied" ? (
          <AppliedView
            phase={phase}
            onToggleTurnOn={(ruleId) => {
              const next = new Set(phase.turnOn);
              if (next.has(ruleId)) next.delete(ruleId);
              else next.add(ruleId);
              setPhase({ ...phase, turnOn: next });
            }}
          />
        ) : null}
        {canvasBlocked ? (
          <p role="alert" className="rounded-md bg-amber-50 px-2 py-1.5 text-sm text-amber-900">
            {UNSAVED_CANVAS}
          </p>
        ) : null}
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
            <button
              type="button"
              className="btn-primary h-8 px-3"
              onClick={() => void confirm()}
              disabled={phase.kind === "applying" || phase.selected.size === 0 || canvasBlocked}
            >
              {phase.kind === "applying" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
              {phase.kind === "applying" ? "Applying…" : `Confirm ${phase.selected.size} change${phase.selected.size === 1 ? "" : "s"}`}
            </button>
          </div>
        ) : null}
        {phase.kind === "applied" && !undone ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-sm text-green-800">
              Applied {phase.count} change{phase.count === 1 ? "" : "s"}.
            </span>
            <button type="button" className="btn-secondary h-8 px-3" onClick={() => void undo()} disabled={phase.undoing || phase.turningOn}>
              {phase.undoing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Undo2 className="size-4" aria-hidden />}
              Undo
            </button>
            <button type="button" className="btn-secondary h-8 px-3" onClick={closeAssistant} disabled={phase.turningOn}>
              Finish
            </button>
            {phase.created.length ? (
              <button type="button" className="btn-primary h-8 px-3" onClick={() => void turnOnAndFinish()} disabled={phase.turningOn || phase.turnOn.size === 0}>
                {phase.turningOn ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
                Turn on &amp; Finish
              </button>
            ) : null}
          </div>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          {/* Never disabled while the AI works: dictation or a paste that lands meanwhile is kept (note 175). */}
          <textarea
            ref={box}
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
            disabled={!configured}
            aria-busy={busy || undefined}
            placeholder={placeholderFor(page.kind)}
            className="field h-auto w-full py-2"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <MicButton text={text} onText={(next) => setText(next.slice(0, ASSISTANT_LIMITS.instructionMaxChars))} disabled={!configured} />
            <span className="flex-1 truncate text-2xs text-zinc-500">
              {MODEL_NAMES[AI_BUILDER_CALLS.assistant_small.model]} for small edits and questions, {MODEL_NAMES[AI_BUILDER_CALLS.assistant_large.model]} for automations
            </span>
            <button type="submit" className="btn-primary h-8 px-3" disabled={busy || !text.trim() || !configured}>
              {phase.kind === "thinking" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
              {phase.kind === "thinking" ? "Thinking…" : "Ask"}
            </button>
          </div>
        </form>
      </div>
      {expanded && ruleCtx ? <RuleExpandModal op={expanded} ruleCtx={ruleCtx} createdId={createdIdOf(phase, expanded)} onClose={() => setExpanded(null)} /> : null}
    </div>
  );
}

function ruleCtxOf(proposal: AssistantProposal): RuleContext {
  return { ...proposal.ruleContext, forms: [], integrations: null, inboundEndpoints: [], members: proposal.ruleContext.people };
}

function createdIdOf(phase: Phase, op: AssistantOp): string | null {
  if (phase.kind !== "applied" || op.op !== "create_rule") return null;
  const index = phase.proposal.ops.indexOf(op);
  return phase.created.find((c) => c.index === index)?.ruleId ?? null;
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
      return "Add a Blocked section, remove the Priority field… or ask how to do something";
  }
}

function AnswerView({ proposal }: { proposal: AssistantProposal }) {
  return (
    <div className="space-y-2" data-assistant-answer>
      {proposal.answerOnly ? <p className="rounded-md bg-zinc-100 px-2.5 py-1.5 text-2xs text-zinc-700">{ANSWER_ONLY_NOTE}</p> : null}
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-violet-700" aria-hidden />
        <p className="whitespace-pre-line text-sm text-zinc-800">{proposal.answer}</p>
      </div>
      <p className="text-2xs text-zinc-500">
        {proposal.model ? `${MODEL_NAMES[proposal.model] ?? proposal.model} · ` : ""}
        {ROUTE_LABELS[proposal.routeReason] ?? proposal.routeReason} · nothing was changed
      </p>
    </div>
  );
}

function ProposalView({
  proposal,
  selected,
  turnOn,
  disabled,
  onToggle,
  onToggleTurnOn,
  onExpand,
  ruleCtx,
}: {
  proposal: AssistantProposal;
  selected: Set<number>;
  turnOn: Set<number>;
  disabled: boolean;
  onToggle: (index: number) => void;
  onToggleTurnOn: (index: number) => void;
  onExpand: (op: AssistantOp) => void;
  ruleCtx: RuleContext;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-800">{proposal.summary}</p>
      <ul className="space-y-1.5" aria-label="Changes to confirm">
        {proposal.ops.map((op, i) => (
          <li key={i} className="rounded-lg border border-zinc-200 px-2.5 py-2">
            <div className="flex items-start gap-2">
              <input
                id={`ai-op-${i}`}
                type="checkbox"
                className="mt-0.5"
                checked={selected.has(i)}
                disabled={disabled}
                onChange={() => onToggle(i)}
                aria-label={`Include: ${op.label}`}
              />
              <span className="min-w-0 flex-1">
                <label htmlFor={`ai-op-${i}`} className="block font-medium text-zinc-900">
                  {op.label}
                </label>
                <OpDiff op={op} ruleCtx={ruleCtx} />
                {opDependency(op) !== null ? <span className="text-2xs text-zinc-500">Needs change {(opDependency(op) ?? 0) + 1}.</span> : null}
                {op.op === "create_rule" && selected.has(i) ? (
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-zinc-700">
                    <input type="checkbox" checked={turnOn.has(i)} disabled={disabled} onChange={() => onToggleTurnOn(i)} />
                    Turn on after creating
                  </label>
                ) : null}
              </span>
              {op.op === "create_rule" || op.op === "update_rule" ? (
                <button type="button" className="btn-icon shrink-0" aria-label={`Expand: ${op.label}`} data-tooltip="See the whole automation" onClick={() => onExpand(op)}>
                  <Maximize2 className="size-4" />
                </button>
              ) : null}
            </div>
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

function AppliedView({ phase, onToggleTurnOn }: { phase: Extract<Phase, { kind: "applied" }>; onToggleTurnOn: (ruleId: string) => void }) {
  const undo = phase.undo;
  if (undo?.status === "undone" || undo?.status === "already_undone") {
    return <p className="text-sm text-zinc-700">Undone. Everything the assistant changed is back as it was.</p>;
  }
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-zinc-800">{phase.proposal.summary}</p>
      {phase.created.length ? (
        <fieldset className="rounded-md border border-zinc-200 px-2.5 py-2">
          <legend className="px-1 text-2xs font-semibold text-zinc-600">New automations (off)</legend>
          <ul className="space-y-1">
            {phase.created.map((c) => (
              <li key={c.ruleId} className="flex items-center gap-2 text-sm">
                <input id={`ai-on-${c.ruleId}`} type="checkbox" checked={phase.turnOn.has(c.ruleId)} disabled={phase.turningOn} onChange={() => onToggleTurnOn(c.ruleId)} />
                <label htmlFor={`ai-on-${c.ruleId}`} className="min-w-0 flex-1 truncate">
                  Turn on “{c.name}”
                </label>
                <Link href={`/projects/${c.projectId}/rules/${c.ruleId}`} className="shrink-0 text-xs font-medium text-accent-700 hover:underline">
                  Open in builder
                </Link>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
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

// Expand (note 173): the whole automation, read-only, in the builder's layout, over the page — no
// navigation. Its own layer above the assistant; Escape closes only it.
function RuleExpandModal({ op, ruleCtx, createdId, onClose }: { op: AssistantOp; ruleCtx: RuleContext; createdId: string | null; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>("button")?.focus();
    const el = root.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    el?.addEventListener("keydown", onKey);
    return () => {
      el?.removeEventListener("keydown", onKey);
      back?.focus?.();
    };
  }, []);
  if (op.op !== "create_rule" && op.op !== "update_rule") return null;
  const ruleId = op.op === "update_rule" ? op.ruleId : createdId;
  const also = [
    op.op === "create_rule" ? (createdId ? "Created, off until you turn it on" : "Starts off; tick “Turn on after creating” or use Turn on & Finish") : "Keeps its on / off state",
    "Changes made by other automations can trigger it",
    "Runs only on tasks in this project (subtasks don’t trigger automations)",
  ];
  return createPortal(
    <div ref={root} className={`fixed inset-0 ${LAYER.assistantModal} flex items-center justify-center bg-zinc-900/30 p-4 print:hidden`} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Automation ${op.rule.name}`}
        data-assistant-allowed
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm shadow-xl"
      >
        <div className="mb-3 flex items-start gap-2">
          <h2 className="flex-1 text-base font-semibold text-zinc-900">{op.rule.name}</h2>
          {ruleId ? (
            <Link href={`/projects/${op.projectId}/rules/${ruleId}`} className="btn-secondary h-8 px-3" onClick={onClose}>
              Open in builder
            </Link>
          ) : null}
          <button type="button" className="btn-icon" aria-label="Close" data-tooltip="Close (Esc)" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <RuleReadOnly rule={{ ...op.rule, name: op.rule.name }} ctx={ruleCtx} also={also} />
        {op.op === "update_rule" ? (
          <p className="mt-3 text-xs text-zinc-500">
            <span className="font-medium text-zinc-600">Now:</span> {ruleSentence(op.previous, ruleCtx)}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
