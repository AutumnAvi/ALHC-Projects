"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { AlertTriangle, Zap } from "lucide-react";
import { useRichToast } from "@/components/toast";
import { onRuleFeedbackRequest } from "@/lib/rule-feedback-bus";
import {
  STOP_EXPLAIN,
  STOP_HEADING,
  automationHref,
  feedbackNotes,
  feedbackSince,
  feedbackTaskHref,
  ranText,
  stopText,
  type FeedbackResponse,
  type RanNote,
  type StopNote,
} from "@/lib/rule-feedback";

// How long after the last write the check runs (several quick writes are asked about once).
const SETTLE_MS = 700;

// Nov 1 notes, batch 10 (77): live automation feedback, mounted once by the app shell. After each change
// the person makes (useServerAction → requestRuleFeedback), it reads their own runs since the last check
// (/api/rule-feedback) and shows a small, semi-transparent note per automation that ran ("Automation X ran
// on 3 tasks") and an amber warning when loop protection, a limit, or an error stopped one — with the
// automation's name, the task, and links to both.
export function RuleFeedbackLayer() {
  const show = useRichToast();
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
        for (const note of feedbackNotes(fresh)) {
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

  return null;
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
