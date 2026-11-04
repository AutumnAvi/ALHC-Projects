"use client";

import { useId, useOptimistic, useRef, useState, type ReactNode } from "react";
import { applyApprovalChange } from "@/lib/approval-optimistic";
import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronRight,
  Clock,
  Eye,
  History,
  MessageSquareText,
  Paperclip,
  Pause,
  Send,
  ThumbsUp,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { Dialog } from "@/components/dialog";
import { APPROVAL_STATUS_LABELS } from "@/lib/task-kinds";
import { feedbackSnippet, feedbackSubtaskText, roundFeedback, shortFileName, type FeedbackTone } from "@/lib/approval-feedback";
import { Avatar, displayName } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { Popover } from "@/components/popover";
import { SmartPicker } from "@/components/smart-picker";
import { useApprovalActionListener } from "./approval-action";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import {
  acknowledgeApproval,
  decideApproval,
  handOffApproval,
  setTaskApprovers,
  withdrawApproval,
} from "@/lib/actions";
import { cantDecideMessage, cantSendMessage } from "@/lib/approval-complete";
import type { ApprovalRound, Profile, TaskApproval, TaskApprovalInfo, TaskDetail } from "@/lib/data";
import { formatDueDate, useToday } from "@/lib/dates";
import { taskPermissions } from "@/lib/permissions";
import { hasRole } from "@/lib/roles";
import { SingleDatePicker } from "./date-picker";
import { PeopleList } from "./person-picker";
import { PANE_FIELDS, PANE_LABEL } from "./pane-styles";
import { SendForApprovalDialog, joinNames } from "./send-for-approval-dialog";
import { ApprovalSetupDialog } from "./approval-setup-dialog";
import { ApproverReviewDialog } from "./approver-review";
import { approverReviewFiles } from "@/lib/approver-review";
import { FeedbackSubtaskButton } from "./feedback-subtask";
import { canAddSubtask } from "./task-subtasks";

// Oct 27 notes (batch 6, items 45 / 45b): the approval panel of an approval task's pane (since Nov 4
// notes, batch 27, 161: a compact row with the field rows, Details in a dialog, feedback as pills).
// The assignee does the work and sends it with "Ready for approval"; the task's approvers (separate
// from the assignee) Approve / Request changes / Reject. Request changes and Reject send it back to the
// assignee, paused until they mark the feedback (or rejection) received. Only Approve without "More
// steps" completes the task. Editors+ choose the approvers, how they decide, and the approval due date
// (while a request is pending only project Owners / Admins change who approves: "Reassign"; an approver
// can hand their decision off instead). The database decides who may do what; this only draws it.

export type Decision = "approved" | "changes_requested" | "rejected";

// Request changes must say what to change; a note is strongly encouraged for Approve and Reject.
export function decisionNoteRule(decision: Decision): "required" | "recommended" {
  return decision === "changes_requested" ? "required" : "recommended";
}

export function canSubmitDecision(decision: Decision, note: string): boolean {
  return decisionNoteRule(decision) === "recommended" || note.trim().length > 0;
}

// The send button's words: "Approve without a note" until a note is written (a nudge to add one).
export function decisionSubmitLabel(decision: Decision, note: string): string {
  const base = decision === "approved" ? "Approve" : decision === "rejected" ? "Reject" : "Request changes";
  return decisionNoteRule(decision) === "recommended" && !note.trim() ? `${base} without a note` : base;
}

export const APPROVAL_MODE_LABELS = { any: "Any one can approve", all: "Everyone must approve" } as const;

const ROUND_STATUS_LABELS: Record<ApprovalRound["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

// One approver's part in a round, in plain words.
export function requestOutcome(request: Pick<TaskApproval, "status" | "cancelReason">, handoffName?: string | null): string {
  switch (request.status) {
    case "pending":
      return "Waiting";
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Requested changes";
    case "rejected":
      return "Rejected";
    default:
      switch (request.cancelReason) {
        case "handed_off":
          return handoffName ? `Handed off to ${handoffName}` : "Handed off";
        case "withdrawn":
          return "Withdrawn";
        case "reassigned":
          return "Removed as an approver";
        case "round_closed":
          return "No decision needed";
        case "kind_changed":
          return "Cancelled (no longer an approval task)";
        default:
          return "Cancelled";
      }
  }
}

// What an approved round did: "The task was completed." / "Moved to Review. More steps to go." / …
export function approvedOutcome(round: Pick<ApprovalRound, "afterApproval" | "moveSectionName">): string {
  if (round.afterApproval === "complete") return "Approving it completed the task.";
  if (round.afterApproval === "move_section") {
    return `${round.moveSectionName ? `Moved to ${round.moveSectionName}` : "Moved to the chosen section"}. More steps to go.`;
  }
  return "More steps to go.";
}

// Who acts for the task's side (send, withdraw, mark feedback received): the assignee (Commenter+) or an
// Editor (approval_can_act).
export function canActOnApproval(task: Pick<TaskDetail, "viewerRole" | "assigneeId">, memberId: string): boolean {
  const perms = taskPermissions(task);
  return perms.canEdit || (perms.canComment && task.assigneeId === memberId);
}

type Settings = Pick<TaskApprovalInfo, "approverIds" | "mode" | "dueOn">;

// Nov 4 notes (batch 27, 161): the status pill's colors and the approval icon's.
const APPROVAL_PILL: Record<string, string> = {
  not_sent: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
  changes_requested: "bg-amber-50 text-amber-900 ring-amber-300",
  rejected: "bg-red-50 text-red-800 ring-red-200",
  approved: "bg-green-50 text-green-800 ring-green-200",
};
const APPROVAL_ICON: Record<string, string> = {
  not_sent: "text-zinc-500",
  pending: "text-amber-600",
  changes_requested: "text-amber-600",
  rejected: "text-red-600",
  approved: "text-green-600",
};

// "Changes requested · Round 3" (the summary's pill).
export function approvalPillText(status: TaskApprovalInfo["status"], round: number | null): string {
  const label = APPROVAL_STATUS_LABELS[status];
  return round !== null && status !== "not_sent" ? `${label} · Round ${round}` : label;
}

export function ApprovalTaskBanner({
  task,
  profiles,
  memberId,
  initialDetailsOpen = false,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
  // The Details dialog open from the start (the unit tests read it this way).
  initialDetailsOpen?: boolean;
}) {
  const info = task.approval;
  if (!info) {
    return (
      <section aria-label="Approval" className="mt-3 rounded-md border border-zinc-200 bg-zinc-50/70 px-3 py-2.5">
        <p className="flex items-center gap-2 text-sm text-zinc-700">
          <ThumbsUp className="size-4 shrink-0 text-zinc-500" aria-hidden />
          Approvals need this release’s database update.
        </p>
      </section>
    );
  }
  return <ApprovalPanel task={task} info={info} profiles={profiles} memberId={memberId} initialDetailsOpen={initialDetailsOpen} />;
}

// Nov 4 notes (batch 27, 161): one compact row with the field rows — the status pill with its round, the
// approvers' faces, the approval due date, and the one thing the viewer can do next. Clicking the summary
// opens Details (approvers and Change, who decides, approval due, what's being approved, Withdraw /
// Hand off, round history). The feedback itself shows as pills next to the files (ApprovalFeedback). An
// approver's in-progress decision (the note step, or the file review) opens under the row / full screen.
function ApprovalPanel({
  task,
  info: serverInfo,
  profiles,
  memberId,
  initialDetailsOpen,
}: {
  task: TaskDetail;
  info: TaskApprovalInfo;
  profiles: Profile[];
  memberId: string;
  initialDetailsOpen: boolean;
}) {
  const [pending, run] = useServerAction();
  // Nov 2 notes (batch 16, 126): every approval action changes the card at once (approval-optimistic.ts);
  // the server's answer replaces it.
  const [info, applyInfo] = useOptimistic(serverInfo, applyApprovalChange);
  const nowIso = () => new Date().toISOString();
  const notify = useNotify();
  const confirm = useConfirm();
  const today = useToday();
  const headlineId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [sending, setSending] = useState(false);
  // Nov 1 notes, batch 9a: the guided setup (choose approvers, then what happens after approval).
  const [settingUp, setSettingUp] = useState(false);
  // The decision the approver started (Approve / Request changes / Reject): its note step shows under the row.
  const [decision, setDecision] = useState<{ choice: Decision; nonce: number } | null>(null);
  // Nov 2 notes (batch 15, 114): the approver's per-file review, full screen in the app.
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(initialDetailsOpen);
  const [settings, patchSettings] = useOptimistic<Settings, Partial<Settings>>(
    { approverIds: info.approverIds, mode: info.mode, dueOn: info.dueOn },
    (current, patch) => ({ ...current, ...patch }),
  );

  const perms = taskPermissions(task);
  const completed = Boolean(task.completedAt);
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const nameOf = (id: string | null | undefined, you = false) => {
    if (id && id === memberId) return you ? "You" : "you";
    const p = id ? profilesById.get(id) : undefined;
    return p ? displayName(p) : "Someone";
  };
  const assigneeName = task.assigneeId ? nameOf(task.assigneeId) : "the assignee";

  const status = info.status;
  const paused = info.paused;
  const latest = info.rounds[0] ?? null;
  const roundOpen = status === "pending" && latest?.status === "pending";
  const canAct = canActOnApproval(task, memberId);
  const canWithdraw = roundOpen && (canAct || latest?.sentBy === memberId);
  // Approvers: Editors+; while a request is pending, project Owners / Admins only ("Reassign").
  const canChangeApprovers = perms.canEdit && (!roundOpen || perms.canManage);
  // How they decide can settle a pending round ("Any one" after someone approved), so the same rule.
  const canChangeMode = canChangeApprovers;
  const canChangeDue = perms.canEdit;
  const myRequest = roundOpen
    ? (latest?.requests.find((r) => r.approverId === memberId && r.status === "pending") ?? null)
    : null;
  const canDecide = Boolean(myRequest) && perms.canComment;
  // Nov 2 notes (batch 15, 114): a round with files is decided file by file (Approve / feedback on each,
  // Submit once every file is reviewed), like the requester review page; Reject stays in the row.
  const reviewFiles = canDecide && latest ? approverReviewFiles(latest, task.attachments) : [];
  const reviewsFiles = reviewFiles.length > 0;
  // Approve from a row that can't be decided here: still asked but below Commenter now (e.g. lowered to
  // Viewer; decide_approval refuses), or no longer asked.
  const decideRefusal = cantDecideMessage(Boolean(myRequest));
  // Ready for approval from someone who can't send it: the assignee below Commenter (approval_can_act) is
  // told it's their role, never "Only you or an Editor…".
  const sendRefusal = cantSendMessage(task.assigneeId === memberId, assigneeName);
  const eligible = profiles.filter((p) => hasRole(task.memberRoles[p.id], "commenter") || settings.approverIds.includes(p.id));
  const approvers = settings.approverIds.map((id) => ({ id, profile: profilesById.get(id) ?? null }));
  const approverNames = approvers.map((a) => nameOf(a.id));
  const canSend =
    canAct &&
    !completed &&
    (status === "not_sent" || ((status === "changes_requested" || status === "rejected") && !paused) || status === "approved");

  // A row's (or the pane header's) "Ready for approval" / "Approve" lands here (approval-action.ts).
  useApprovalActionListener(task.id, (action) => {
    sectionRef.current?.scrollIntoView?.({ block: "nearest" });
    if (action === "setup") {
      if (canChangeApprovers && !roundOpen) setSettingUp(true);
      return;
    }
    if (action === "decide") {
      if (canDecide && reviewsFiles) setReviewExpanded(true);
      else if (canDecide) setDecision((current) => ({ choice: "approved", nonce: (current?.nonce ?? 0) + 1 }));
      else notify(decideRefusal);
      return;
    }
    if (canSend && settings.approverIds.length > 0) {
      setSending(true);
    } else if (paused) {
      notify(`Mark the ${status === "rejected" ? "rejection" : "feedback"} received first, then send it again`);
    } else if (settings.approverIds.length === 0) {
      if (canChangeApprovers && !completed) setSettingUp(true);
      else notify("Nobody approves this yet. Ask an Editor to choose the approvers.");
    } else if (roundOpen) {
      notify("It’s already waiting for approval");
    } else if (!canAct) {
      notify(sendRefusal);
    }
  });

  function save(patch: Partial<Settings>) {
    const next = { ...settings, ...patch };
    run(() => setTaskApprovers(task.id, next), () => patchSettings(patch));
  }

  function toggleApprover(id: string) {
    const has = settings.approverIds.includes(id);
    const next = has ? settings.approverIds.filter((a) => a !== id) : [...settings.approverIds, id];
    if (roundOpen && next.length === 0) {
      notify("A pending approval needs at least one approver. Withdraw it instead.");
      return;
    }
    if (next.length > 10) {
      notify("A task can have up to 10 approvers");
      return;
    }
    save({ approverIds: next });
  }

  // The headline in plain words (the summary's tooltip, read by screen readers, and the top of Details).
  let headline: string;
  const decider = latest?.decidedBy ?? null;
  if (status === "not_sent") {
    if (completed) headline = "The task is complete. It wasn’t sent for approval.";
    else if (settings.approverIds.length === 0) headline = "Choose who approves this, then send it with Ready for approval.";
    else if (latest?.status === "withdrawn") headline = "The request was withdrawn. Send it again with Ready for approval when it’s ready.";
    else headline = `Not sent yet. When it’s ready, Ready for approval sends it to ${joinNames(approverNames)}.`;
  } else if (status === "pending") {
    const waiting = (latest?.requests ?? []).filter((r) => r.status === "pending").map((r) => nameOf(r.approverId));
    const names = waiting.length ? waiting : approverNames;
    const joined =
      latest?.mode === "all" || names.length < 2
        ? joinNames(names)
        : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
    headline = `Waiting on ${joined} to approve.`;
  } else if (status === "changes_requested" || status === "rejected") {
    const verb = status === "rejected" ? "rejected this" : "requested changes";
    const what = status === "rejected" ? "rejection" : "feedback";
    const who = nameOf(decider, true);
    headline = paused
      ? `${who} ${verb}. Paused until ${task.assigneeId === memberId ? "you mark" : `${assigneeName} marks`} the ${what} received.`
      : `${who} ${verb}. Back with ${task.assigneeId === memberId ? "you" : assigneeName}: send it again with Ready for approval.`;
  } else {
    const approvedBy = (latest?.requests ?? []).filter((r) => r.status === "approved").map((r) => nameOf(r.approverId));
    headline = `Approved by ${approvedBy.length ? joinNames(approvedBy) : nameOf(decider)}. ${latest ? approvedOutcome(latest) : ""}`.trim();
  }

  const dueOverdue = Boolean(roundOpen && settings.dueOn && today && settings.dueOn < today);
  const decide = (choice: Decision) => setDecision({ choice, nonce: Date.now() });
  const feedbackCount = roundFeedback(latest, task.attachments).filter((f) => f.tone !== "approved").length;
  const small = "h-7 px-2 text-xs";
  const pillTone = APPROVAL_PILL[status];

  // Choosing approvers (Editors+; Owners / Admins while a round is pending), in Details.
  const approverPicker = canChangeApprovers ? (
    <Popover
      label={roundOpen ? "Reassign approvers" : "Choose approvers"}
      panelClassName="w-72 p-0"
      buttonClassName="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-zinc-300 px-2 text-xs text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 aria-expanded:border-zinc-400"
      button={
        <>
          <Users className="size-3.5" aria-hidden />
          {roundOpen ? "Reassign" : approvers.length ? "Change" : "Add approver"}
        </>
      }
    >
      {() => (
        <PeopleList
          label="Approvers"
          people={eligible}
          selected={settings.approverIds}
          emptyNote="Approvers need at least Commenter access to this task’s project."
          footer={
            <p className="px-2.5 py-1.5 text-2xs text-zinc-500">
              Ticked people approve this task. Pick someone again to remove them.
              {roundOpen ? " New approvers are asked right away." : ""}
            </p>
          }
          onPick={toggleApprover}
        />
      )}
    </Popover>
  ) : null;

  // The one next step (two for an approver: their decision, and Reject).
  let action: ReactNode = null;
  if (canDecide && myRequest && !decision) {
    action = (
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Your decision">
        {reviewsFiles ? (
          <button type="button" disabled={pending} onClick={() => setReviewExpanded(true)} className={`btn-primary ${small}`} data-approval-open-review="">
            <Eye className="size-3.5" aria-hidden />
            Open review
          </button>
        ) : (
          <>
            <button type="button" disabled={pending} onClick={() => decide("approved")} className={`btn-primary bg-green-700 hover:bg-green-800 ${small}`}>
              Approve
            </button>
            <button type="button" disabled={pending} onClick={() => decide("changes_requested")} className={`btn-secondary ${small}`}>
              Request changes
            </button>
          </>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => decide("rejected")}
          className={`btn-secondary border-red-200 text-red-700 hover:bg-red-50 ${small}`}
        >
          Reject
        </button>
      </div>
    );
  } else if (paused && canAct) {
    action = (
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => acknowledgeApproval(task.id), () => applyInfo({ type: "acknowledge", at: nowIso() }))}
        className={`btn-primary ${small}`}
      >
        <Check className="size-3.5" aria-hidden />
        {status === "rejected" ? "Rejection received" : "Feedback received"}
      </button>
    );
  } else if (approvers.length === 0 && canChangeApprovers && !completed) {
    action = (
      <button type="button" data-approval-finish-setup="" onClick={() => setSettingUp(true)} className={`btn-primary ${small}`}>
        Finish setup
      </button>
    );
  } else if (canSend) {
    action = (
      <button
        type="button"
        disabled={pending || settings.approverIds.length === 0}
        data-tooltip={settings.approverIds.length === 0 ? "Choose an approver first" : undefined}
        onClick={() => setSending(true)}
        className={`${status === "approved" ? "btn-secondary" : "btn-primary"} ${small}`}
      >
        <Send className="size-3.5" aria-hidden />
        {status === "approved" ? "Send for approval again" : "Ready for approval"}
      </button>
    );
  }

  const shown = approvers.slice(0, 3);
  return (
    <section
      ref={sectionRef}
      aria-label="Approval"
      className="mt-1"
      data-approval-status={status}
      data-approval-paused={paused ? "true" : undefined}
    >
      <div className={PANE_FIELDS}>
        <span className={`${PANE_LABEL} self-start`}>Approval</span>
        <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-approval-row="">
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            aria-haspopup="dialog"
            aria-describedby={headlineId}
            data-approval-summary=""
            data-tooltip={headline}
            className="-ml-1 inline-flex min-w-0 max-w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-zinc-100"
          >
            <span
              className={`inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${pillTone}`}
              data-approval-pill=""
            >
              {paused ? <Pause className="size-3 shrink-0" aria-hidden /> : <ThumbsUp className={`size-3 shrink-0 ${APPROVAL_ICON[status]}`} aria-hidden />}
              <span className="truncate">{approvalPillText(status, latest?.number ?? null)}</span>
              {paused ? <span className="sr-only"> (paused)</span> : null}
            </span>
            {shown.length ? (
              <span className="flex shrink-0 -space-x-1" aria-label={`${approvers.length === 1 ? "Approver" : "Approvers"}: ${joinNames(approverNames)}`}>
                {shown.map(({ id, profile }) => {
                  const name = profile ? displayName(profile) : "Someone";
                  const request = roundOpen ? latest?.requests.find((r) => r.approverId === id && r.status !== "cancelled") : undefined;
                  return (
                    <span key={id} data-approver={id} className="relative inline-flex rounded-full ring-2 ring-white">
                      <Avatar name={name} src={profile?.avatar_url} profileId={id} />
                      {request?.status === "approved" ? (
                        <Check className="absolute -right-1 -bottom-1 size-3 rounded-full bg-white text-green-600" aria-label="Approved" />
                      ) : request?.status === "pending" ? (
                        <Clock className="absolute -right-1 -bottom-1 size-3 rounded-full bg-white text-amber-600" aria-label="Waiting" />
                      ) : null}
                    </span>
                  );
                })}
                {approvers.length > shown.length ? (
                  <span className="inline-flex size-6 items-center justify-center rounded-full bg-zinc-100 text-2xs font-medium text-zinc-600 ring-2 ring-white">
                    +{approvers.length - shown.length}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-xs text-zinc-500">No approver yet</span>
            )}
            {settings.dueOn ? (
              <span className={`inline-flex shrink-0 items-center gap-1 text-xs ${dueOverdue ? "text-red-700" : "text-zinc-600"}`}>
                <CalendarDays className="size-3.5" aria-hidden />
                {formatDueDate(settings.dueOn)}
                {dueOverdue ? " · overdue" : ""}
              </span>
            ) : null}
            <ChevronRight className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
            <span className="sr-only">Details</span>
          </button>
          {feedbackCount > 0 ? (
            <a href={`#approval-feedback-${task.id}`} className="text-xs text-amber-800 hover:underline" data-approval-feedback-link="">
              {feedbackCount === 1 ? "1 note" : `${feedbackCount} notes`} ↓
            </a>
          ) : null}
          {action ? <div className="ml-auto flex flex-wrap items-center gap-1.5">{action}</div> : null}
        </div>
      </div>
      <p id={headlineId} className="sr-only" data-approval-headline="">
        {headline}
      </p>

      {canDecide && myRequest && decision ? (
        <div className="mt-2 space-y-2" data-approval-deciding="">
          {latest ? <RoundContent round={latest} task={task} nameOf={nameOf} label="What you’re approving" /> : null}
          <ApprovalDecisionForm
            key={decision.nonce}
            idPrefix={`approval-${task.id}`}
            pending={pending}
            recipientName={task.assigneeId ? assigneeName : null}
            initialDecision={decision.choice}
            onCancel={() => setDecision(null)}
            onDecide={(choice, note) => {
              setDecision(null);
              run(
                () => decideApproval(myRequest.id, choice, note || undefined),
                () =>
                  applyInfo({ type: "decide", requestId: myRequest.id, decision: choice, note: note || null, by: memberId, at: nowIso() }),
              );
            }}
          />
        </div>
      ) : null}

      {reviewExpanded && reviewsFiles && myRequest && latest ? (
        <ApproverReviewDialog
          taskId={task.id}
          requestId={myRequest.id}
          round={latest}
          attachments={task.attachments}
          onDecide={(choice, note) =>
            applyInfo({ type: "decide", requestId: myRequest.id, decision: choice, note: note || null, by: memberId, at: nowIso() })
          }
          onClose={() => setReviewExpanded(false)}
        />
      ) : null}

      {detailsOpen ? (
        <Dialog title="Approval" onClose={() => setDetailsOpen(false)} width="max-w-lg">
          <div data-approval-details="">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${pillTone}`}>
                {approvalPillText(status, latest?.number ?? null)}
              </span>
              {paused ? <span className="text-2xs font-medium tracking-wide text-amber-800 uppercase">Paused</span> : null}
            </div>
            <p className="mt-2 text-sm text-zinc-800">{headline}</p>
            {paused && !canAct ? (
              <p className="mt-1 text-xs text-zinc-500">
                Waiting on {assigneeName} to mark the {status === "rejected" ? "rejection" : "feedback"} received.
              </p>
            ) : null}

            {roundOpen && latest ? <RoundContent round={latest} task={task} nameOf={nameOf} label="What’s being approved" /> : null}

            <dl className={`mt-3 ${PANE_FIELDS}`}>
              <dt className={`${PANE_LABEL} self-start`}>{approvers.length === 1 ? "Approver" : "Approvers"}</dt>
              <dd className="min-w-0">
                <div className="flex min-h-8 flex-wrap items-center gap-1.5 py-0.5">
                  {approvers.length ? (
                    approvers.map(({ id, profile }) => {
                      const name = profile ? displayName(profile) : "Someone";
                      return (
                        <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-2 pl-0.5 text-xs text-zinc-700">
                          <Avatar name={name} src={profile?.avatar_url} profileId={id} />
                          <span className="truncate">{id === memberId ? `${name} (you)` : name}</span>
                        </span>
                      );
                    })
                  ) : (
                    <span className="text-zinc-500">No approver yet</span>
                  )}
                  {approverPicker}
                </div>
              </dd>

              {settings.approverIds.length > 1 || canChangeMode ? (
                <>
                  <dt className={PANE_LABEL}>Who decides</dt>
                  <dd className="min-w-0">
                    {canChangeMode ? (
                      <SmartPicker
                        label="Who decides"
                        value={settings.mode}
                        onChange={(value) => save({ mode: value === "all" ? "all" : "any" })}
                        searchable={false}
                        className="h-7 w-auto"
                        panelWidth={260}
                        options={[
                          { value: "any", label: APPROVAL_MODE_LABELS.any, description: "The first approval is enough" },
                          { value: "all", label: APPROVAL_MODE_LABELS.all, description: "Every approver has to approve" },
                        ]}
                      />
                    ) : (
                      <span className="flex min-h-8 items-center px-1 text-zinc-800">{APPROVAL_MODE_LABELS[settings.mode]}</span>
                    )}
                  </dd>
                </>
              ) : null}

              <dt className={PANE_LABEL}>Approval due</dt>
              <dd className="min-w-0">
                {canChangeDue ? (
                  <Popover
                    label={`Approval due: ${settings.dueOn ? formatDueDate(settings.dueOn) : "no date"}. Change`}
                    panelClassName="w-[19rem] p-0"
                    buttonClassName="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md px-1 text-sm hover:bg-zinc-100 aria-expanded:bg-zinc-100"
                    button={<DueLabel dueOn={settings.dueOn} overdue={dueOverdue} />}
                  >
                    {(close) => (
                      <SingleDatePicker
                        label="Approval due"
                        value={settings.dueOn}
                        onChange={(next) => {
                          close();
                          if (next !== settings.dueOn) save({ dueOn: next });
                        }}
                      />
                    )}
                  </Popover>
                ) : (
                  <span className="inline-flex h-8 items-center px-1">
                    <DueLabel dueOn={settings.dueOn} overdue={dueOverdue} />
                  </span>
                )}
              </dd>
            </dl>
            {settings.dueOn && roundOpen ? (
              <p className="mt-0.5 text-2xs text-zinc-500">Approvers get a reminder the day before, and again once it’s overdue.</p>
            ) : null}

            {canDecide || canWithdraw ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {canDecide ? (
                  <HandOffButton
                    candidates={eligible.filter((p) => p.id !== memberId && !settings.approverIds.includes(p.id))}
                    onHandOff={(personId, note) =>
                      run(
                        () => handOffApproval(task.id, personId, note),
                        () =>
                          myRequest &&
                          applyInfo({ type: "hand_off", requestId: myRequest.id, from: memberId, to: personId, note: note || null, at: nowIso() }),
                      )
                    }
                  />
                ) : null}
                {canWithdraw ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Withdraw the approval request?",
                        message: "The approvers can’t decide on it anymore. You can send it again later.",
                        confirmLabel: "Withdraw",
                        cancelLabel: "Keep it",
                        tone: "danger",
                      });
                      if (ok) run(() => withdrawApproval(task.id), () => applyInfo({ type: "withdraw", at: nowIso() }));
                    }}
                    className="btn-ghost text-zinc-600"
                  >
                    Withdraw
                  </button>
                ) : null}
              </div>
            ) : null}

            {info.rounds.length ? <ApprovalHistory rounds={info.rounds} task={task} nameOf={nameOf} /> : null}
          </div>
        </Dialog>
      ) : null}
      {sending ? <SendForApprovalDialog task={task} profiles={profiles} onClose={() => setSending(false)} /> : null}
      {settingUp ? <ApprovalSetupDialog task={task} profiles={profiles} onClose={() => setSettingUp(false)} /> : null}
    </section>
  );
}

const FEEDBACK_PILL: Record<FeedbackTone, string> = {
  changes_requested: "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100",
  rejected: "border-red-300 bg-red-50 text-red-800 hover:bg-red-100",
  approved: "border-green-300 bg-green-50 text-green-800 hover:bg-green-100",
};
const FEEDBACK_WORD: Record<FeedbackTone, string> = {
  changes_requested: "Changes requested",
  rejected: "Rejected",
  approved: "Approved",
};

// Nov 4 notes (batch 27, 161): the latest round's feedback as small pills next to the task's files: a
// file's short name and the start of its note, colored by its outcome (changes requested amber, rejected
// red, approved green). A pill opens the whole note, who wrote it and when, and "Create subtask".
export function ApprovalFeedback({ task, profiles, memberId }: { task: TaskDetail; profiles: Profile[]; memberId: string }) {
  const latest = task.approval?.rounds[0] ?? null;
  const items = roundFeedback(latest, task.attachments);
  if (!latest || items.length === 0) return null;
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const nameOf = (id: string) => (id === memberId ? "You" : profilesById.get(id) ? displayName(profilesById.get(id)!) : "Someone");
  const canSubtask = canAddSubtask(task);
  return (
    <section id={`approval-feedback-${task.id}`} className="mt-6 scroll-mt-4" aria-labelledby={`approval-feedback-heading-${task.id}`} data-approval-feedback="">
      <h3 id={`approval-feedback-heading-${task.id}`} className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
        <MessageSquareText className="size-4 text-zinc-500" aria-hidden />
        Approval feedback
        <span className="font-normal text-zinc-500">· Round {latest.number}</span>
      </h3>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {items.map((item) => {
          const title = item.fileName ? shortFileName(item.fileName) : "Note";
          const snippet = item.text ? feedbackSnippet(item.text) : FEEDBACK_WORD[item.tone];
          const Icon = item.tone === "approved" ? Check : item.tone === "rejected" ? X : AlertCircle;
          return (
            <li key={item.key} className="max-w-full">
              <Popover
                label={`${FEEDBACK_WORD[item.tone]}: ${item.fileName ?? "note"}${item.text ? ` — ${item.text}` : ""}`}
                panelClassName="w-80 p-3"
                buttonClassName={`inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2 text-xs ${FEEDBACK_PILL[item.tone]}`}
                button={
                  <span className="flex min-w-0 items-center gap-1" data-feedback-pill={item.tone}>
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span className="shrink-0 font-medium">{title}</span>
                    <span className="min-w-0 truncate opacity-80">· {snippet}</span>
                  </span>
                }
              >
                {() => (
                  <div className="space-y-2 text-sm" data-feedback-detail="">
                    <p className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium ${FEEDBACK_PILL[item.tone]}`}>
                      {FEEDBACK_WORD[item.tone]}
                    </p>
                    {item.fileName ? (
                      item.fileId ? (
                        <a href={`/attachments/${item.fileId}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 break-all text-xs font-medium text-zinc-800 hover:underline">
                          <Paperclip className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                          {item.fileName}
                        </a>
                      ) : (
                        <p className="break-all text-xs font-medium text-zinc-800">{item.fileName}</p>
                      )
                    ) : null}
                    <p className="whitespace-pre-wrap text-zinc-800">{item.text || "Approved, no note."}</p>
                    <p className="text-2xs text-zinc-500">
                      {nameOf(item.approverId)}
                      {item.decidedAt ? (
                        <>
                          {" · "}
                          <Timestamp iso={item.decidedAt} />
                        </>
                      ) : null}
                    </p>
                    {item.tone !== "approved" && item.text && canSubtask ? (
                      <FeedbackSubtaskButton task={task} feedback={feedbackSubtaskText(item)} from={nameOf(item.approverId)} className="-ml-1.5" />
                    ) : null}
                  </div>
                )}
              </Popover>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DueLabel({ dueOn, overdue }: { dueOn: string | null; overdue: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full ${
          dueOn ? (overdue ? "text-red-600" : "text-zinc-500") : "border border-dashed border-zinc-300 text-zinc-400"
        }`}
      >
        <CalendarDays className="size-3.5" />
      </span>
      <span className={dueOn ? (overdue ? "text-red-700" : "text-zinc-800") : "text-zinc-500"}>
        {dueOn ? `${formatDueDate(dueOn)}${overdue ? " · overdue" : ""}` : "No due date"}
      </span>
    </>
  );
}

// The final text and files of a round (the open one at the top; every round in History).
function RoundContent({
  round,
  task,
  nameOf,
  label,
}: {
  round: ApprovalRound;
  task: TaskDetail;
  nameOf: (id: string | null | undefined, you?: boolean) => string;
  label?: string;
}) {
  const files = round.attachmentIds.map((id) => ({ id, name: task.attachments.find((a) => a.id === id)?.fileName ?? null }));
  return (
    <div className="mt-2 rounded-md border border-zinc-200 bg-white px-2.5 py-2" data-approval-round={round.number}>
      {label ? <p className="text-xs font-medium text-zinc-700">{label}</p> : null}
      <p className="text-2xs text-zinc-500">
        Sent by {nameOf(round.sentBy)} · <Timestamp iso={round.sentAt} />
        {round.dueOn ? ` · due ${formatDueDate(round.dueOn)}` : ""}
      </p>
      {round.finalText ? <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-800">{round.finalText}</p> : null}
      {files.length ? (
        <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Files">
          {files.map((f) =>
            f.name ? (
              <li key={f.id}>
                <a
                  href={`/attachments/${f.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-56 items-center gap-1 rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50"
                >
                  <Paperclip className="size-3 shrink-0 text-zinc-400" aria-hidden />
                  <span className="truncate">{f.name}</span>
                </a>
              </li>
            ) : (
              <li key={f.id} className="inline-flex items-center gap-1 rounded border border-dashed border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-500">
                A removed file
              </li>
            ),
          )}
        </ul>
      ) : null}
      {round.moreSteps ? (
        <p className="mt-1.5 text-2xs text-zinc-500">
          On approval:{" "}
          {round.afterApproval === "move_section"
            ? `move it to ${round.moveSectionName ?? "the chosen section"}, don’t complete`
            : "notify, don’t complete"}
        </p>
      ) : null}
    </div>
  );
}

function ApprovalHistory({
  rounds,
  task,
  nameOf,
}: {
  rounds: ApprovalRound[];
  task: TaskDetail;
  nameOf: (id: string | null | undefined, you?: boolean) => string;
}) {
  return (
    <details className="group/history mt-2.5 border-t border-zinc-200 pt-2" data-approval-history="">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open/history:rotate-90" aria-hidden />
        <History className="size-3.5" aria-hidden />
        History · {rounds.length} {rounds.length === 1 ? "round" : "rounds"}
      </summary>
      <ol className="mt-2 space-y-3">
        {rounds.map((round) => (
          <li key={round.id} className="text-sm">
            <p className="font-medium text-zinc-900">
              Round {round.number} · {ROUND_STATUS_LABELS[round.status]}
            </p>
            <RoundContent round={round} task={task} nameOf={nameOf} />
            <ul className="mt-1.5 space-y-1">
              {round.requests.map((r) => (
                <li key={r.id} className="text-xs text-zinc-700">
                  <span className="font-medium">{nameOf(r.approverId, true)}</span>
                  {": "}
                  {requestOutcome(r, r.handoffTo ? nameOf(r.handoffTo) : null)}
                  {r.decidedAt ? (
                    <span className="text-zinc-500">
                      {" "}
                      · <Timestamp iso={r.decidedAt} />
                    </span>
                  ) : null}
                  {r.decisionNote ? <span className="block whitespace-pre-wrap pl-2 text-zinc-600">“{r.decisionNote}”</span> : null}
                  {r.decisionNote && (r.status === "changes_requested" || r.status === "rejected") && canAddSubtask(task) ? (
                    <FeedbackSubtaskButton task={task} feedback={r.decisionNote} from={nameOf(r.approverId)} className="ml-0.5" />
                  ) : null}
                  {r.cancelReason === "handed_off" && r.handoffNote ? (
                    <span className="block whitespace-pre-wrap pl-2 text-zinc-600">“{r.handoffNote}”</span>
                  ) : null}
                </li>
              ))}
            </ul>
            {round.withdrawnAt ? (
              <p className="mt-1 text-xs text-zinc-500">
                Withdrawn · <Timestamp iso={round.withdrawnAt} />
              </p>
            ) : null}
            {round.acknowledgedAt ? (
              <p className="mt-1 text-xs text-zinc-500">
                {round.status === "rejected" ? "Rejection" : "Feedback"} marked received · <Timestamp iso={round.acknowledgedAt} />
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

// Approve / Request changes / Reject, then a note: required for Request changes, prompted for the others
// (the send button reads "Approve without a note" until one is written). Shared with the Inbox.
export function ApprovalDecisionForm({
  idPrefix,
  pending,
  recipientName,
  onDecide,
  compact = false,
  initialDecision = null,
  onCancel,
}: {
  idPrefix: string;
  pending: boolean;
  // Who reads the note ("Sam"), when known.
  recipientName?: string | null;
  onDecide: (decision: Decision, note: string) => void;
  compact?: boolean;
  // Opens straight on a decision's note step (a link that says what to do, and tests).
  initialDecision?: Decision | null;
  // Cancel (or Escape) on the note step; without it the form goes back to its three buttons.
  onCancel?: () => void;
}) {
  const [chosen, setChosen] = useState<Decision | null>(initialDecision);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const autoId = useId();
  const noteId = `${idPrefix}-${autoId}-note`;
  const hintId = `${idPrefix}-${autoId}-hint`;
  const size = compact ? "h-6 px-2 text-xs" : "";

  function cancel() {
    if (onCancel) onCancel();
    else setChosen(null);
  }

  function submit() {
    if (!chosen) return;
    setTried(true);
    if (!canSubmitDecision(chosen, note)) return;
    onDecide(chosen, note.trim());
    setChosen(null);
    setNote("");
    setTried(false);
  }

  if (!chosen) {
    return (
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Your decision">
        <button
          type="button"
          disabled={pending}
          onClick={() => setChosen("approved")}
          className={`btn-primary bg-green-700 hover:bg-green-800 ${size}`}
        >
          Approve
        </button>
        <button type="button" disabled={pending} onClick={() => setChosen("changes_requested")} className={`btn-secondary ${size}`}>
          Request changes
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setChosen("rejected")}
          className={`btn-secondary border-red-200 text-red-700 hover:bg-red-50 ${size}`}
        >
          Reject
        </button>
      </div>
    );
  }

  const required = decisionNoteRule(chosen) === "required";
  const missing = required && !note.trim();
  const reader = recipientName ?? "the assignee";
  return (
    <form
      className="space-y-2 rounded-md border border-zinc-200 bg-white p-2.5"
      data-decision={chosen}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor={noteId} className="block text-xs font-medium text-zinc-800">
        {required ? (
          <>
            What needs to change? <span className="font-normal text-red-700">(required)</span>
          </>
        ) : chosen === "approved" ? (
          <>
            Add a note <span className="font-normal text-zinc-500">(recommended)</span>
          </>
        ) : (
          <>
            Say why <span className="font-normal text-zinc-500">(recommended)</span>
          </>
        )}
      </label>
      {!required ? (
        <p className="rounded bg-amber-50 px-2 py-1 text-2xs text-amber-900">
          A short note helps {reader} know what’s next.
        </p>
      ) : null}
      <textarea
        id={noteId}
        autoFocus
        value={note}
        rows={compact ? 2 : 3}
        maxLength={2000}
        aria-required={required || undefined}
        aria-invalid={(tried && missing) || undefined}
        aria-describedby={required ? hintId : undefined}
        onChange={(e) => setNote(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
        placeholder={required ? "Say what to change, so it can be fixed." : chosen === "approved" ? "Looks great — ship it." : "What’s wrong with it?"}
        className="field h-auto w-full py-1.5"
      />
      {required ? (
        <p id={hintId} className={`text-2xs ${missing ? "text-red-700" : "text-zinc-500"}`} role={tried && missing ? "alert" : undefined}>
          {missing ? "Add a note saying what needs to change before you send it." : `${reader} gets this note with the request.`}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="submit"
          disabled={pending || missing}
          className={
            chosen === "approved"
              ? `btn-primary bg-green-700 hover:bg-green-800 ${size}`
              : chosen === "rejected"
                ? `btn-primary bg-red-600 hover:bg-red-700 ${size}`
                : `btn-primary ${size}`
          }
        >
          {decisionSubmitLabel(chosen, note)}
        </button>
        <button type="button" onClick={cancel} className={`btn-ghost ${size}`}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// "Hand off…": an approver passes their decision to someone else, with an optional note.
function HandOffButton({ candidates, onHandOff }: { candidates: Profile[]; onHandOff: (personId: string, note: string) => void }) {
  return (
    <Popover
      label="Hand off the approval"
      panelClassName="w-72 p-0"
      buttonClassName="btn-ghost text-zinc-600"
      button={
        <>
          <UserRound className="size-3.5" aria-hidden />
          Hand off…
        </>
      }
    >
      {(close) => (
        <HandOffPanel
          candidates={candidates}
          onHandOff={(id, note) => {
            close();
            onHandOff(id, note);
          }}
        />
      )}
    </Popover>
  );
}

function HandOffPanel({ candidates, onHandOff }: { candidates: Profile[]; onHandOff: (personId: string, note: string) => void }) {
  const [picked, setPicked] = useState<Profile | null>(null);
  const [note, setNote] = useState("");
  const noteId = useId();
  if (!picked) {
    return (
      <PeopleList
        label="Hand off to"
        people={candidates}
        selected={[]}
        emptyNote="Nobody else here can approve it (they need at least Commenter access)."
        onPick={(id) => setPicked(candidates.find((p) => p.id === id) ?? null)}
      />
    );
  }
  const name = displayName(picked);
  return (
    <form
      className="space-y-2 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        onHandOff(picked.id, note.trim());
      }}
    >
      <p className="flex items-center gap-2 text-sm text-zinc-800">
        <Avatar name={name} src={picked.avatar_url} profileId={picked.id} size="md" />
        Hand off to {name}
      </p>
      <label htmlFor={noteId} className="block text-xs font-medium text-zinc-700">
        Note for {name} <span className="font-normal text-zinc-500">(optional)</span>
      </label>
      <textarea
        id={noteId}
        autoFocus
        value={note}
        rows={3}
        maxLength={2000}
        onChange={(e) => setNote(e.currentTarget.value)}
        placeholder="Why you’re passing it on, or what to look at."
        className="field h-auto w-full py-1.5"
      />
      <p className="text-2xs text-zinc-500">You stop being an approver, and {name} is asked to decide.</p>
      <div className="flex gap-1.5">
        <button type="submit" className="btn-primary">
          Hand off
        </button>
        <button type="button" onClick={() => setPicked(null)} className="btn-ghost">
          Back
        </button>
      </div>
    </form>
  );
}

