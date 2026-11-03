"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, XCircle, Zap } from "lucide-react";
import { useRichToast, useToastDock } from "@/components/toast";
import { onLocalMutationEnd, openMutationStarts, subscribeOpenMutations } from "@/lib/optimistic-session";
import {
  LONG_MS,
  entryStatus,
  entryTarget,
  entryTitle,
  indicatorLabel,
  indicatorVisible,
  nextTick,
  noteFinishedRuns,
  noteWriteEnded,
  runningState,
  subscribeRunning,
  type RunningEntry,
} from "@/lib/rule-running";
import { onRuleFeedbackRequest, requestRuleFeedback } from "@/lib/rule-feedback-bus";
import { openRealtimeChannel } from "@/lib/realtime";
import { useShell } from "@/components/shell/shell-context";
import {
  STOP_EXPLAIN,
  STOP_HEADING,
  automationHref,
  feedbackNotes,
  feedbackSince,
  feedbackTaskHref,
  finishedRunsFromNotes,
  ranText,
  stopText,
  type FeedbackResponse,
  type RanNote,
  type StopNote,
} from "@/lib/rule-feedback";

// How long after the last write the check runs (several quick writes are asked about once). Nov 3 notes
// (batch 18, 139): shorter, so the note shows right after the change.
const SETTLE_MS = 300;
// A Realtime insert of one of the person's runs asks again (covers any path that made the change).
const REALTIME_LOOKBACK_MS = 5000;

// Nov 1 notes, batch 10 (77): live automation feedback, mounted once by the app shell. After each change
// the person makes (useServerAction → requestRuleFeedback), it reads their own runs since the last check
// (/api/rule-feedback) and shows a small, semi-transparent note per automation that ran ("Automation X ran
// on 3 tasks") and an amber warning when loop protection, a limit, or an error stopped one — with the
// automation's name, the task, and links to both.
// Nov 3 notes (batch 18, 138 / 139): every local write asks (optimistic-session.ts ends each one with a
// request), date changes ask too, and a Realtime insert of the person's own rule_runs row nudges a check —
// so bulk edits ("Automation X moved 3 tasks") and date changes that fire an automation always show it.
export function RuleFeedbackLayer() {
  const show = useRichToast();
  const memberId = useShell().member.id;
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  const state = useRef<{ cursor: string | null; seen: Set<string>; startedAt: number | null; timer: number | null; busy: boolean }>({
    cursor: null,
    seen: new Set(),
    startedAt: null,
    timer: null,
    busy: false,
  });

  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const s = state.current;
    async function check() {
      s.timer = null;
      if (s.busy || s.startedAt === null) return;
      const startedAt = s.startedAt;
      s.startedAt = null;
      s.busy = true;
      try {
        const params = new URLSearchParams();
        const at = feedbackSince(s.cursor, startedAt, Date.now());
        if (at.since) params.set("since", at.since);
        if (at.within) params.set("within", String(at.within));
        const response = await fetch(`/api/rule-feedback?${params}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as FeedbackResponse;
        s.cursor = data.cursor;
        const fresh = data.runs.filter((r) => !s.seen.has(r.id));
        for (const r of fresh) s.seen.add(r.id);
        if (s.seen.size > 2000) s.seen = new Set([...s.seen].slice(-1000));
        const notes = feedbackNotes(fresh);
        // Nov 3 notes (batch 19, 141): the automations a write started join the running indicator's list.
        noteFinishedRuns(finishedRunsFromNotes(notes));
        for (const note of notes) {
          if (note.kind === "ran") {
            show({ variant: "quiet", message: ranText(note), body: <RanBody note={note} />, durationMs: 5000 });
          } else {
            show({
              variant: "warning",
              message: stopText(note),
              body: <StopBody note={note} back={pathRef.current} />,
              durationMs: 15000,
            });
          }
        }
      } catch {
        // Feedback is a nicety: a failed check says nothing.
      } finally {
        s.busy = false;
        // A write that finished while this check ran gets its own.
        if (s.startedAt !== null && s.timer === null) s.timer = window.setTimeout(check, SETTLE_MS);
      }
    }
    const off = onRuleFeedbackRequest((startedAt) => {
      s.startedAt = s.startedAt === null ? startedAt : Math.min(s.startedAt, startedAt);
      if (s.timer !== null) window.clearTimeout(s.timer);
      s.timer = window.setTimeout(check, SETTLE_MS);
    });
    return () => {
      off();
      if (s.timer !== null) window.clearTimeout(s.timer);
    };
  }, [show]);

  // Realtime: the person's own runs (rule_runs RLS: Viewers+ of the automation's project).
  useEffect(() => {
    if (!memberId) return;
    return openRealtimeChannel(`rule-runs-${memberId}`, [{ table: "rule_runs", filter: `actor_id=eq.${memberId}` }], () =>
      requestRuleFeedback(Date.now() - REALTIME_LOOKBACK_MS),
    );
  }, [memberId]);

  return <RunningIndicator />;
}

// Nov 3 notes (batch 19, 141): bottom left, in the toast column (toasts stack above it). Shows once an
// automation (or a change that may start some) has been running for a moment, with how many are running;
// a click lists each one with its target task: "Running…" until it's done, then "Ran".
function RunningIndicator() {
  const dock = useToastDock();
  const panelId = useId();
  const { entries, lingerUntil } = useSyncExternalStore(subscribeRunning, runningState, runningState);
  // The open writes' start times, as a string so the snapshot is stable.
  const openKey = useSyncExternalStore(
    subscribeOpenMutations,
    () => openMutationStarts().join(","),
    () => "",
  );
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);

  useEffect(() => onLocalMutationEnd((startedAt) => noteWriteEnded(startedAt)), []);

  // Writes still saving show as "Your change · Saving…" (unless a manual run covers them).
  const automationRunning = entries.some((e) => e.kind === "automation" && e.status === "running");
  const writes: RunningEntry[] = automationRunning
    ? []
    : openKey
        .split(",")
        .filter(Boolean)
        .map((at, i) => ({
          key: `write-${at}-${i}`,
          kind: "write",
          ruleId: null,
          ruleName: null,
          projectId: null,
          tasks: [],
          taskCount: 0,
          status: "running",
          startedAt: Number(at),
          endedAt: null,
          detail: null,
        }));
  const all = [...writes, ...entries];

  // Re-render when something crosses LONG_MS or the linger runs out (and every second while running).
  useEffect(() => {
    const wait = nextTick(all, lingerUntil, Date.now());
    const running = all.some((e) => e.status === "running");
    if (wait === null && !running) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(50, Math.min(wait ?? 1000, 1000)));
    return () => window.clearTimeout(timer);
  });

  // An open list stays until it's closed (the button or Escape), so it never vanishes under the pointer.
  const visible = indicatorVisible(all, lingerUntil, now) || open;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!dock || !visible) return null;
  const longRunning = all.filter((e) => e.status === "running" && now - e.startedAt >= LONG_MS);
  const running = longRunning.length > 0;
  const shown = all.filter((e) => e.status !== "running" || now - e.startedAt >= LONG_MS);
  const label = indicatorLabel(running ? longRunning : shown);
  const failed = !running && shown.some((e) => e.status === "failed");

  return createPortal(
    <div className="pointer-events-auto w-fit max-w-full" data-running-indicator>
      {open ? (
        <div id={panelId} role="region" aria-label="Automations" className="mb-1.5 w-80 max-w-full rounded-lg border border-zinc-200 bg-white p-2 text-xs text-zinc-700 shadow-lg">
          <p className="px-1 pb-1 font-medium text-zinc-900">Automations</p>
          {shown.length === 0 ? (
            <p className="px-1 py-1 text-zinc-500">Nothing running.</p>
          ) : (
            <ul className="max-h-64 space-y-0.5 overflow-auto">
              {shown.map((entry) => (
                <RunningRow key={entry.key} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs shadow-md backdrop-blur-sm ${
          failed ? "border border-amber-300 bg-amber-50 text-amber-950" : "bg-zinc-900/80 text-white hover:bg-zinc-900"
        }`}
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Zap className={`size-3.5 shrink-0 ${failed ? "text-amber-600" : "text-amber-300"}`} aria-hidden />
        )}
        <span role="status">{label}</span>
        {running && longRunning.length > 1 ? (
          <span className="rounded-full bg-white/20 px-1.5 text-2xs font-medium" aria-hidden>
            {longRunning.length}
          </span>
        ) : null}
        <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
    </div>,
    dock,
  );
}

function RunningRow({ entry }: { entry: RunningEntry }) {
  const target = entryTarget(entry);
  const task = entry.tasks.length === 1 && entry.taskCount <= 1 ? entry.tasks[0] : null;
  const status = entryStatus(entry);
  return (
    <li className="flex items-start gap-2 rounded px-1 py-1" data-running-status={entry.status}>
      {entry.status === "running" ? (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-zinc-400" aria-hidden />
      ) : entry.status === "failed" ? (
        <XCircle className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />
      ) : (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-green-600" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate">
          {entry.kind === "automation" && entry.ruleId && entry.projectId ? (
            <Link href={automationHref(entry.projectId, entry.ruleId)} className="font-medium hover:underline">
              {entryTitle(entry)}
            </Link>
          ) : (
            <span className="font-medium">{entryTitle(entry)}</span>
          )}
          {target ? (
            <>
              {" "}
              {task && task.title && entry.projectId ? (
                <Link href={feedbackTaskHref(entry.projectId, task.id)} className="text-zinc-500 hover:underline">
                  {target}
                </Link>
              ) : (
                <span className="text-zinc-500">{target}</span>
              )}
            </>
          ) : null}
        </p>
        {entry.kind === "write" && entry.status === "running" ? (
          <p className="text-2xs text-zinc-500">Automations it starts run with it.</p>
        ) : entry.detail ? (
          <p className="truncate text-2xs text-zinc-500" title={entry.detail}>
            {entry.detail}
          </p>
        ) : null}
      </div>
      <span className={`shrink-0 text-2xs ${entry.status === "failed" ? "text-amber-700" : "text-zinc-500"}`}>{status}</span>
    </li>
  );
}

function RanBody({ note }: { note: RanNote }) {
  return (
    <p className="flex items-center gap-1.5">
      <Zap className="size-3.5 shrink-0 text-amber-300" aria-hidden />
      <span className="min-w-0">{ranText(note)}</span>
    </p>
  );
}

function StopBody({ note, back }: { note: StopNote; back: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{STOP_HEADING[note.stop]}</p>
        <p className="mt-0.5">
          <Link href={automationHref(note.projectId, note.ruleId, back)} className="font-medium underline underline-offset-2 hover:text-amber-800">
            {note.ruleName}
          </Link>
          {note.taskId && note.taskTitle ? (
            <>
              {" on "}
              <Link href={feedbackTaskHref(note.projectId, note.taskId)} className="underline underline-offset-2 hover:text-amber-800">
                {note.taskTitle}
              </Link>
            </>
          ) : null}
        </p>
        <p className="mt-1 text-xs text-amber-900">
          {STOP_EXPLAIN[note.stop]}
          {note.detail ? ` ${note.detail}` : ""}
        </p>
      </div>
    </div>
  );
}
