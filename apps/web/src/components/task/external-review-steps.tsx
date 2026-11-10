"use client";

import { useState } from "react";
import { Check, Send } from "lucide-react";
import type { TaskDetail } from "@alhc/core/api/task-pane/model";
import { reviewSendGate, reviewerLabel, twoStepSteps, TWO_STEP_NOTE } from "@alhc/core/external-review";
import { SendReviewDialog } from "./send-review-dialog";

// Nov 10 batch 36: on the internal approver's review page (/approve/<task>) of a task that also has an
// external reviewer — 1. you approve → 2. you send it to <reviewer> → 3. they review — and, once the
// internal approval is done, "Send to <reviewer>", which opens the same Send review check screen.
export function ExternalReviewSteps({ task, memberId }: { task: TaskDetail; memberId: string }) {
  const [sending, setSending] = useState(false);
  const reviewer = task.externalReview?.reviewer ?? null;
  const you = task.approval?.approverIds.includes(memberId) ?? false;
  const steps = twoStepSteps(task.approval, task.externalReview, you);
  const gate = reviewSendGate(task, memberId);
  return (
    <section className="rounded-lg border border-zinc-200 bg-white px-4 py-3" data-external-review-steps="">
      <h2 className="text-xs font-medium text-zinc-500">Approval, then external review</h2>
      <p className="mt-1 text-xs text-zinc-600">{TWO_STEP_NOTE}</p>
      <ol className="mt-2 flex flex-col gap-1.5 text-sm">
        {steps.map((step, i) => (
          <li key={i} className="flex items-center gap-2" data-step-state={step.state}>
            <span
              className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold ${
                step.state === "done"
                  ? "bg-green-600 text-white"
                  : step.state === "current"
                    ? "bg-accent-600 text-white"
                    : "bg-zinc-100 text-zinc-500"
              }`}
              aria-hidden
            >
              {step.state === "done" ? <Check className="size-3" /> : i + 1}
            </span>
            <span className={step.state === "waiting" ? "text-zinc-500" : "text-zinc-800"}>{step.label}</span>
            <span className="sr-only">{step.state === "done" ? "(done)" : step.state === "current" ? "(now)" : "(later)"}</span>
          </li>
        ))}
      </ol>
      {gate.allowed && steps[1].state === "current" ? (
        <button type="button" className="btn-primary mt-3" onClick={() => setSending(true)} data-send-external="">
          <Send className="size-4" aria-hidden />
          Send to {reviewer?.name ?? reviewerLabel(reviewer)}
        </button>
      ) : null}
      {sending ? <SendReviewDialog task={task} onClose={() => setSending(false)} /> : null}
    </section>
  );
}
