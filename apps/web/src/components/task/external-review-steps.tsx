"use client";

import { useId, useState } from "react";
import { Check, Send } from "lucide-react";
import type { TaskDetail } from "@alhc/core/api/task-pane/model";
import { reviewSendGate, reviewerLabel, twoStepSteps, TWO_STEP_NOTE } from "@alhc/core/external-review";
import { MAX_REVIEW_MESSAGE } from "@alhc/core/review-checks";
import { SendReviewDialog } from "./send-review-dialog";

// Nov 10 batch 36: on the internal approver's review page (/approve/<task>) of a task that also has an
// external reviewer — 1. you approve → 2. you send it to <reviewer> → 3. they review — and, once the
// internal approval is done, "Send to <reviewer>", which opens the same Send review check screen.
export function ExternalReviewSteps({ task, memberId }: { task: TaskDetail; memberId: string }) {
  const [sending, setSending] = useState(false);
  // Note 182: an optional message for the external reviewer, written here and carried into the Send
  // review check screen (still editable there) and the email they get.
  const [message, setMessage] = useState("");
  const messageId = useId();
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
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor={messageId} className="text-xs font-medium text-zinc-700">
            Message to {reviewer?.name ?? reviewerLabel(reviewer)} <span className="font-normal text-zinc-500">(optional)</span>
          </label>
          <textarea
            id={messageId}
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, MAX_REVIEW_MESSAGE))}
            rows={3}
            maxLength={MAX_REVIEW_MESSAGE}
            placeholder="Add a note for the external reviewer. It goes in their email."
            className="field h-auto py-2"
            data-external-message=""
          />
          <div>
            <button type="button" className="btn-primary" onClick={() => setSending(true)} data-send-external="">
              <Send className="size-4" aria-hidden />
              Send to {reviewer?.name ?? reviewerLabel(reviewer)}
            </button>
          </div>
        </div>
      ) : null}
      {sending ? (
        <SendReviewDialog
          task={task}
          initialMessage={message}
          onClose={() => setSending(false)}
          onSent={() => setMessage("")}
        />
      ) : null}
    </section>
  );
}
