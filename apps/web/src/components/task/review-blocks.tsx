"use client";

// Nov 24 batch 45: the task card's Review section (docs/design/task-card/png/03, 05b, 09): below the
// subtasks and above Files and comments. The blue "Team approver" block (the approval: decisions, the
// approver's file review, Hand off / Withdraw, feedback, history) and the amber "Outside reviewer" block
// (who, when it's due, whether the email went out, Send / Copy review link / Remind / Retry). In the
// parallel order a note says Done needs both. Each indicator appears once here; the step track at the top
// of the card jumps to these blocks.

import { useState, useSyncExternalStore } from "react";
import { Check, Copy, Eye, Info, Lock, Mail, PanelsTopLeft, RotateCcw, Send, TriangleAlert, Bell, ArrowRight } from "lucide-react";
import type { ApprovalTrack, TrackStep } from "@alhc/core/approval-track";
import { currentRoles } from "@alhc/core/approval-track";
import type { TaskDetail } from "@alhc/core/api/task-pane/model";
import type { Profile } from "@alhc/core/api/people/model";
import { displayName } from "@alhc/core/people";
import { reviewSendGate } from "@alhc/core/external-review";
import { useNotify, useServerAction } from "@/components/toast";
import { copyReviewLink, resendReviewCheck } from "@/lib/actions/reviews";
import { formatDueDate } from "@/lib/dates";
import { ApprovalTaskBanner } from "./task-approval-banner";
import { SendReviewDialog } from "./send-review-dialog";
import { LocalDateTime, OutsideAvatar, RoleTag } from "./approval-track";

// A clock that ticks every 30 seconds (null while rendering on the server), for "not confirmed" below.
function subscribeClock(callback: () => void) {
  const timer = window.setInterval(callback, 30_000);
  return () => window.clearInterval(timer);
}
const clockNow = () => Math.floor(Date.now() / 30_000) * 30_000;

// A send that started but never reported back within two minutes (the function was stopped midway).
const SENDING_STALE_MS = 2 * 60_000;

export function outsideBlockId(taskId: string) {
  return `outside-review-${taskId}`;
}

// "round 2 · sent Dec 9" / "round 1 · both reviewing since Dec 9" / "sent by Isaiah Dec 8".
function sectionSubtitle(task: TaskDetail, track: ApprovalTrack, nameOf: (id: string) => string): string {
  const team = track.steps.find((s) => s.role === "team");
  const outside = track.steps.find((s) => s.role === "outside");
  if (track.kind === "outside") {
    const sent = outside?.sentAt ? formatDueDate(outside.sentAt.slice(0, 10)) : null;
    const by = outside?.sentBy ? nameOf(outside.sentBy).split(/\s+/)[0] : null;
    return [by ? `sent by ${by}` : "sent", sent].filter(Boolean).join(" ");
  }
  const round = track.round;
  const sentAt = team?.sentAt ?? null;
  if (!round || !sentAt) return task.approval?.approverIds.length ? "not sent yet" : "setup not finished";
  const day = formatDueDate(sentAt.slice(0, 10));
  if (track.order === "parallel" && team?.state === "current" && outside?.state === "current") return `round ${round} · both reviewing since ${day}`;
  return `round ${round} · sent ${day}`;
}

export function TaskReviewSection({
  task,
  profiles,
  memberId,
  track,
  onOpenReviewTab,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
  track: ApprovalTrack;
  onOpenReviewTab: () => void;
}) {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const nameOf = (id: string) => (byId.get(id) ? displayName(byId.get(id)!) : "Someone");
  const outside = track.steps.find((s) => s.role === "outside") ?? null;
  const team = track.steps.find((s) => s.role === "team") ?? null;
  const parallel = track.order === "parallel" && Boolean(team && outside);
  const teamNames = (team?.personIds ?? []).map((id) => nameOf(id).split(/\s+/)[0]);
  const outsideName = outside?.outside?.name?.split(/\s+/)[0] ?? outside?.outside?.email ?? "the outside reviewer";
  return (
    <section className="mt-6" aria-labelledby={`review-heading-${task.id}`} data-review-section={track.order}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id={`review-heading-${task.id}`} className="text-sm font-semibold text-zinc-900">
          Review <span className="font-normal text-zinc-500">· {sectionSubtitle(task, track, nameOf)}</span>
        </h3>
        <button type="button" onClick={onOpenReviewTab} className="inline-flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline" data-open-review-tab="">
          Open Review tab
          <ArrowRight className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-2.5">
        {task.kind === "approval" ? (
          <ApprovalTaskBanner task={task} profiles={profiles} memberId={memberId} onOpenReviewTab={onOpenReviewTab} />
        ) : null}
        {outside ? (
          <OutsideReviewerBlock task={task} step={outside} memberId={memberId} order={track.order} onOpenReviewTab={onOpenReviewTab} nameOf={nameOf} />
        ) : null}
      </div>
      {parallel ? (
        <p className="mt-2.5 flex items-start gap-1.5 text-xs leading-[18px] text-zinc-600" data-parallel-note="">
          <Info className="mt-px size-3.5 shrink-0 text-zinc-400" aria-hidden />
          <span>
            Done lights up when both {teamNames.length ? teamNames.join(" and ") : "the team"} and {outsideName} approve. If either asks for changes,
            round {(track.round ?? 0) + 1} goes to both.
          </span>
        </p>
      ) : null}
      {currentRoles(track).length === 0 && track.steps.every((s) => s.state === "done") ? null : null}
    </section>
  );
}

type Badge = { text: string; className: string; icon: typeof Eye };

function outsideBadge(step: TrackStep, emailFailed: boolean): Badge {
  if (emailFailed && step.state === "current") return { text: "Email didn’t go out", className: "bg-red-100 text-red-800", icon: TriangleAlert };
  switch (step.state) {
    case "locked":
      return { text: "Up next, after the team approves", className: "bg-zinc-100 text-zinc-600", icon: Lock };
    case "done":
      return { text: step.decidedAt ? `Approved ${formatDueDate(step.decidedAt.slice(0, 10))}` : "Approved", className: "bg-green-100 text-green-700", icon: Check };
    case "changes":
      return { text: "Changes requested", className: "bg-amber-100 text-amber-800", icon: RotateCcw };
    case "current":
      return step.sentAt
        ? { text: `Reviewing now · sent ${formatDueDate(step.sentAt.slice(0, 10))}`, className: "bg-amber-500 text-white", icon: Eye }
        : { text: "Ready to send", className: "bg-amber-100 text-amber-900", icon: Send };
    default:
      return { text: step.status, className: "bg-zinc-100 text-zinc-600", icon: Lock };
  }
}

function OutsideReviewerBlock({
  task,
  step,
  memberId,
  order,
  onOpenReviewTab,
  nameOf,
}: {
  task: TaskDetail;
  step: TrackStep;
  memberId: string;
  order: ApprovalTrack["order"];
  onOpenReviewTab: () => void;
  nameOf: (id: string) => string;
}) {
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const [sending, setSending] = useState(false);
  // The send state the person just caused (until the pane's data catches up).
  const [justSent, setJustSent] = useState<{ status: "sending" | "sent" | "failed" | "mocked" | "suppressed"; reason?: string } | null>(null);
  const reviewer = step.outside!;
  const name = reviewer.name?.trim() || reviewer.email;
  const first = reviewer.name?.trim().split(/\s+/)[0] ?? reviewer.email.split("@")[0];
  const latest = task.externalReview?.latest ?? null;
  // The round this block is about: the one the track says belongs to the team round (or the only one).
  const round = step.sentAt && latest && latest.createdAt === step.sentAt ? latest : null;
  const open = round?.status === "pending";
  const gate = reviewSendGate(task, memberId);
  const now = useSyncExternalStore(subscribeClock, clockNow, () => null);
  const recorded = justSent?.status ?? round?.emailStatus ?? null;
  // "sending" for more than two minutes: it never reported back, so it may not have gone out.
  const unconfirmed =
    recorded === "sending" && now !== null && Boolean(round?.emailAttemptedAt) && now - Date.parse(round!.emailAttemptedAt!) > SENDING_STALE_MS;
  const emailStatus = recorded;
  const emailFailed = open && (emailStatus === "failed" || unconfirmed);
  const badge = outsideBadge(step, Boolean(emailFailed));
  const due = step.dueOn;

  let meta: string;
  if (step.state === "locked" || (!round && step.state !== "done")) {
    meta = `Reviews by email link, no login · approves each file or pins comments${due ? ` · due ${formatDueDate(due)}` : ""}`;
  } else if (round && open) {
    const files = round.fileCount ? `${round.fileCount} ${round.fileCount === 1 ? "file" : "files"}` : null;
    const seen = round.lastViewedAt ? `opened ${formatDueDate(round.lastViewedAt.slice(0, 10))}` : "not opened yet";
    meta = [`Round ${round.round}`, files, seen, due ? `due ${formatDueDate(due)}` : null].filter(Boolean).join(" · ");
  } else if (round) {
    const approved =
      round.approvedFiles !== null && round.approvedFiles !== undefined && round.fileCount
        ? `${round.approvedFiles} of ${round.fileCount} ${round.fileCount === 1 ? "file" : "files"} approved`
        : null;
    const pins = round.pinCount ? `${round.pinCount} pinned ${round.pinCount === 1 ? "comment" : "comments"}` : null;
    meta = [`Round ${round.round}`, approved, pins].filter(Boolean).join(" · ");
  } else {
    meta = step.status;
  }

  async function copyLink() {
    if (!round) return;
    const result = (await run(() => copyReviewLink(round.id))) as { error?: string; link?: string } | void;
    if (!result || result.error || !result.link) return;
    try {
      await navigator.clipboard.writeText(result.link);
      notify(`Review link copied. ${first}’s emailed link still works.`);
    } catch {
      notify(`Couldn’t copy. The link: ${result.link}`);
    }
  }

  async function resend(kind: "retry" | "remind") {
    if (!round) return;
    const result = (await run(() => resendReviewCheck(round.id), () => setJustSent(null))) as
      | { error?: string; emailed?: boolean; emailStatus?: "sent" | "failed" | "mocked" | "suppressed"; reason?: string; link?: string }
      | void;
    if (!result || result.error) return;
    const status = result.emailStatus ?? (result.emailed ? "sent" : "failed");
    setJustSent({ status, reason: result.reason });
    if (status === "sent") notify(kind === "retry" ? `Sent. ${first} has a new review link.` : `Reminder sent to ${first} with a fresh link.`);
    else if (result.link) {
      try {
        await navigator.clipboard.writeText(result.link);
        notify(`The email didn’t go out${result.reason ? ` (${result.reason})` : ""}. The review link is copied: pass it on yourself.`);
      } catch {
        notify(`The email didn’t go out. The review link: ${result.link}`);
      }
    } else notify(`The email didn’t go out${result.reason ? `: ${result.reason}` : ""}.`);
  }

  const canSendNow = step.state === "current" && !open && gate.allowed;
  const lockedReason = step.state === "locked" ? `${first} gets the review link after the team approves` : gate.reason;
  const delivery = round?.deliveryStatus ?? null;

  return (
    <section
      id={outsideBlockId(task.id)}
      tabIndex={-1}
      aria-label={`Outside reviewer: ${name}`}
      data-review-block="outside"
      data-outside-state={step.state}
      className="scroll-mt-4 rounded-[10px] border border-l-4 border-amber-200 border-l-amber-500 bg-gradient-to-t from-white to-[#fffbf0] px-3.5 pt-[11px] pb-3 outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <RoleTag role="outside" />
        <span className={`inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${badge.className}`} data-outside-badge="">
          <badge.icon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{badge.text}</span>
        </span>
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-medium text-zinc-800">
        <OutsideAvatar name={name} size="md" />
        <span className="truncate">{name}</span>
        <span className="min-w-0 truncate font-normal text-zinc-500">
          · <a href={`mailto:${reviewer.email}`} className="hover:underline">{reviewer.email}</a>
        </span>
      </p>
      <p className="mt-1.5 text-xs leading-[17px] text-zinc-600" data-outside-meta="">
        {meta}
      </p>

      {round && emailStatus ? (
        <p
          className={`mt-1 flex flex-wrap items-center gap-1 text-xs ${emailFailed || delivery === "bounced" || delivery === "complained" ? "text-red-700" : "text-zinc-500"}`}
          data-outside-email={emailStatus}
          role={emailFailed ? "alert" : undefined}
        >
          <Mail className="size-3.5 shrink-0" aria-hidden />
          {emailStatus === "sent" ? (
            delivery === "bounced" ? (
              <>The email bounced: {first}’s address didn’t accept it. Check the address, then send again.</>
            ) : delivery === "complained" ? (
              <>{first} marked the email as spam.</>
            ) : (
              <>
                Email sent{round.emailAttemptedAt ? <> <LocalDateTime iso={round.emailAttemptedAt} /></> : null}
                {delivery === "delivered" ? " · delivered" : delivery === "delayed" ? " · delivery delayed" : ""}
              </>
            )
          ) : emailStatus === "failed" ? (
            <>The email didn’t go out{(justSent?.reason ?? round.emailError) ? `: ${justSent?.reason ?? round.emailError}` : ""}.</>
          ) : emailStatus === "sending" ? (
            unconfirmed ? <>The email wasn’t confirmed: sending stopped partway. Retry to be sure {first} gets it.</> : <>Sending the email…</>
          ) : emailStatus === "mocked" ? (
            <>No email provider is set up here, so no email went out. Copy the review link and send it yourself.</>
          ) : (
            <>This address bounced before, so no email went out. Copy the review link and send it another way.</>
          )}
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-outside-actions="">
        {open ? (
          <>
            {emailFailed && gate.allowed ? (
              <button type="button" disabled={pending} onClick={() => resend("retry")} className="btn-primary h-8 bg-amber-600 px-2.5 text-xs hover:bg-amber-700" data-outside-retry="">
                <RotateCcw className="size-3.5" aria-hidden />
                Retry email
              </button>
            ) : null}
            <button type="button" onClick={onOpenReviewTab} className="btn-secondary h-8 px-2.5 text-xs">
              <PanelsTopLeft className="size-3.5" aria-hidden />
              Open in Review tab
            </button>
            {gate.allowed ? (
              <>
                <button type="button" disabled={pending} onClick={copyLink} className="btn-ghost h-8 px-2 text-xs text-zinc-700" data-outside-copy="">
                  <Copy className="size-3.5" aria-hidden />
                  Copy review link
                </button>
                {!emailFailed ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => resend("remind")}
                    data-tooltip={`Emails ${first} a fresh review link (the old one stops working)`}
                    className="btn-ghost h-8 px-2 text-xs text-zinc-700"
                  >
                    <Bell className="size-3.5" aria-hidden />
                    Remind
                  </button>
                ) : null}
              </>
            ) : null}
          </>
        ) : step.state === "done" || step.state === "changes" ? (
          <button type="button" onClick={onOpenReviewTab} className="btn-secondary h-8 px-2.5 text-xs">
            <PanelsTopLeft className="size-3.5" aria-hidden />
            Open in Review tab
          </button>
        ) : (
          <button
            type="button"
            disabled={!canSendNow}
            onClick={() => setSending(true)}
            data-tooltip={!canSendNow ? (lockedReason ?? undefined) : undefined}
            aria-describedby={!canSendNow && lockedReason ? `outside-why-${task.id}` : undefined}
            className="btn-secondary h-8 px-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            data-outside-send=""
          >
            <Send className="size-3.5" aria-hidden />
            Send to {first}
          </button>
        )}
        {(step.state === "changes" || (round && !open && step.state !== "done")) && gate.allowed && order === "sequential" && task.kind !== "approval" ? (
          <button type="button" onClick={() => setSending(true)} className="btn-ghost h-8 px-2 text-xs text-zinc-700">
            <Send className="size-3.5" aria-hidden />
            Send round {(round?.round ?? 0) + 1}
          </button>
        ) : null}
        {!canSendNow && lockedReason && !open && step.state !== "done" ? (
          <span id={`outside-why-${task.id}`} className="sr-only">
            {lockedReason}
          </span>
        ) : null}
      </div>
      {round?.createdBy && step.state !== "locked" ? (
        <p className="mt-1.5 text-2xs text-zinc-400">Sent by {nameOf(round.createdBy)}</p>
      ) : null}
      {sending ? <SendReviewDialog task={task} onClose={() => setSending(false)} /> : null}
    </section>
  );
}
