"use client";

import { useId, useOptimistic, useRef, useState } from "react";
import { CalendarDays, Check, ChevronDown, ChevronRight, Clock, History, Lock, Paperclip, Send, ThumbsUp, UserRound, Users } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { Popover } from "@/components/popover";
import { ApprovalStatusBadge } from "@/components/project/task-meta";
import { SmartPicker } from "@/components/smart-picker";
import { useApprovalActionListener } from "./approval-action";
import { setApprovalDetailsOpen, useApprovalDetailsOpen } from "./pane-size";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import {
  acknowledgeApproval,
  decideApproval,
  handOffApproval,
  setTaskApprovers,
  withdrawApproval,
} from "@/lib/actions";
import type { ApprovalRound, Profile, TaskApproval, TaskApprovalInfo, TaskDetail } from "@/lib/data";
import { formatDueDate, useToday } from "@/lib/dates";
import { taskPermissions } from "@/lib/permissions";
import { hasRole } from "@/lib/roles";
import { SingleDatePicker } from "./date-picker";
import { PeopleList } from "./person-picker";
import { PANE_FIELDS, PANE_LABEL } from "./pane-styles";
import { SendForApprovalDialog, joinNames } from "./send-for-approval-dialog";

// Oct 27 notes (batch 6, items 45 / 45b): the approval panel at the top of an approval task's pane.
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

export function ApprovalTaskBanner({
  task,
  profiles,
  memberId,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
}) {
  const info = task.approval;
  if (!info) {
    return (
      <section aria-label="Approval" className="mb-3 rounded-md border border-zinc-200 bg-zinc-50/70 px-3 py-2.5">
        <p className="flex items-center gap-2 text-sm text-zinc-700">
          <ThumbsUp className="size-4 shrink-0 text-zinc-500" aria-hidden />
          Approvals need this release’s database update.
        </p>
      </section>
    );
  }
  return <ApprovalPanel task={task} info={info} profiles={profiles} memberId={memberId} />;
}

// Oct 29 notes (batch 7, item 52): one slim row — the approvers (each locked in), the status, and what the
// viewer can do now — with everything else (how they decide, the approval due date, what's being
// approved, history, changing approvers) behind Details, open or closed as this browser last left it.
function ApprovalPanel({
  task,
  info,
  profiles,
  memberId,
}: {
  task: TaskDetail;
  info: TaskApprovalInfo;
  profiles: Profile[];
  memberId: string;
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const confirm = useConfirm();
  const today = useToday();
  const detailsId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [sending, setSending] = useState(false);
  // The decision the approver started (Approve / Request changes / Reject): its note step shows under the row.
  const [decision, setDecision] = useState<{ choice: Decision; nonce: number } | null>(null);
  const detailsOpen = useApprovalDetailsOpen();
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
  const eligible = profiles.filter((p) => hasRole(task.memberRoles[p.id], "commenter") || settings.approverIds.includes(p.id));
  const approvers = settings.approverIds.map((id) => ({ id, profile: profilesById.get(id) ?? null }));
  const approverNames = approvers.map((a) => nameOf(a.id));
  const canSend =
    canAct &&
    !completed &&
    (status === "not_sent" || ((status === "changes_requested" || status === "rejected") && !paused) || status === "approved");

  function setDetails(open: boolean) {
    setApprovalDetailsOpen(open);
  }

  // A row's (or the pane header's) "Ready for approval" / "Approve" lands here (approval-action.ts).
  useApprovalActionListener(task.id, (action) => {
    sectionRef.current?.scrollIntoView?.({ block: "nearest" });
    if (action === "decide") {
      if (canDecide) setDecision({ choice: "approved", nonce: Date.now() });
      else notify("Your decision on this approval isn’t open anymore");
      return;
    }
    if (canSend && settings.approverIds.length > 0) {
      setSending(true);
    } else if (paused) {
      notify(`Mark the ${status === "rejected" ? "rejection" : "feedback"} received first, then send it again`);
    } else if (settings.approverIds.length === 0) {
      setDetails(true);
      notify(canChangeApprovers ? "Choose who approves this first" : "Nobody approves this yet. Ask an Editor to choose the approvers.");
    } else if (roundOpen) {
      notify("It’s already waiting for approval");
    } else if (!canAct) {
      notify(`Only ${assigneeName} or an Editor can send it for approval`);
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

  // The headline in plain words (the status pill's tooltip, and the first line of Details).
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

  const decisionRequest =
    latest && (latest.status === "changes_requested" || latest.status === "rejected")
      ? (latest.requests.find((r) => r.status === latest.status) ?? null)
      : null;
  const approvalNotes = latest?.status === "approved" ? latest.requests.filter((r) => r.status === "approved" && r.decisionNote) : [];
  const dueOverdue = Boolean(roundOpen && settings.dueOn && today && settings.dueOn < today);
  const decide = (choice: Decision) => setDecision({ choice, nonce: Date.now() });
  // Choosing approvers (Editors+; Owners / Admins while a round is pending): in Details, or right in the
  // row while nobody approves it yet.
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
  const small = "h-7 px-2 text-xs";

  return (
    <section
      ref={sectionRef}
      aria-label="Approval"
      className="mb-3 rounded-md border border-zinc-200 bg-zinc-50/70 px-3 py-2"
      data-approval-status={status}
      data-approval-paused={paused ? "true" : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" data-approval-row="">
        <ThumbsUp className="size-4 shrink-0 text-zinc-500" aria-hidden />
        <span className="text-xs font-medium text-zinc-500">{approvers.length === 1 ? "Approver" : "Approvers"}</span>
        {approvers.length === 0 ? <span className="text-sm text-zinc-500">No approver yet</span> : null}
        {approvers.length === 0 ? approverPicker : null}
        {approvers.map(({ id, profile }) => {
          const request = roundOpen ? latest?.requests.find((r) => r.approverId === id && r.status !== "cancelled") : undefined;
          const name = profile ? displayName(profile) : "Someone";
          return (
            <span
              key={id}
              data-approver={id}
              data-tooltip={`Approver (locked in): ${name}`}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-zinc-200 bg-white py-0.5 pr-2 pl-0.5 text-xs text-zinc-800"
            >
              <Avatar name={name} src={profile?.avatar_url} profileId={id} />
              <span className="truncate">{id === memberId ? `${name} (you)` : name}</span>
              {request?.status === "approved" ? (
                <Check className="size-3.5 text-green-600" aria-label="Approved" />
              ) : request?.status === "pending" ? (
                <Clock className="size-3.5 text-amber-600" aria-label="Waiting" />
              ) : null}
              <Lock className="size-3 text-zinc-400" aria-label="Locked in as an approver" data-approver-lock="" />
            </span>
          );
        })}
        <span data-tooltip={headline} className="inline-flex">
          <ApprovalStatusBadge status={status} paused={paused} />
          {/* The tooltip is pointer-only; screen readers get the same words while Details is closed. */}
          {detailsOpen ? null : (
            <span className="sr-only" data-approval-headline-sr="">
              {headline}
            </span>
          )}
        </span>
        {latest && status !== "not_sent" ? <span className="text-2xs text-zinc-500">Round {latest.number}</span> : null}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {canDecide && myRequest && !decision ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Your decision">
              <button
                type="button"
                disabled={pending}
                onClick={() => decide("approved")}
                className={`btn-primary bg-green-700 hover:bg-green-800 ${small}`}
              >
                Approve
              </button>
              <button type="button" disabled={pending} onClick={() => decide("changes_requested")} className={`btn-secondary ${small}`}>
                Request changes
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => decide("rejected")}
                className={`btn-secondary border-red-200 text-red-700 hover:bg-red-50 ${small}`}
              >
                Reject
              </button>
            </div>
          ) : null}
          {canSend ? (
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
          ) : null}
          {paused && canAct ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => acknowledgeApproval(task.id))}
              className={`btn-primary ${small}`}
            >
              <Check className="size-3.5" aria-hidden />
              {status === "rejected" ? "Rejection received" : "Feedback received"}
            </button>
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
                if (ok) run(() => withdrawApproval(task.id));
              }}
              className={`btn-ghost text-zinc-600 ${small}`}
            >
              Withdraw
            </button>
          ) : null}
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetails(!detailsOpen)}
            data-approval-details-toggle=""
            className={`btn-ghost gap-1 text-zinc-600 ${small}`}
          >
            Details
            <ChevronDown className={`size-3.5 transition-transform ${detailsOpen ? "rotate-180" : ""}`} aria-hidden />
          </button>
        </div>
      </div>

      {decisionRequest ? (
        <div
          className={`mt-2 rounded-md border px-2.5 py-1.5 text-sm ${
            status === "rejected" ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900"
          } ${paused ? "shadow-sm" : ""}`}
          data-approval-decision-note=""
        >
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs font-medium">
            <Avatar name={nameOf(decisionRequest.approverId, true)} profileId={decisionRequest.approverId} />
            {nameOf(decisionRequest.approverId, true)} {status === "rejected" ? "rejected this" : "requested changes"}
            {decisionRequest.decidedAt ? (
              <span className="font-normal opacity-75">
                · <Timestamp iso={decisionRequest.decidedAt} />
              </span>
            ) : null}
          </p>
          {decisionRequest.decisionNote ? (
            <p className="mt-1 whitespace-pre-wrap">{decisionRequest.decisionNote}</p>
          ) : (
            <p className="mt-1 italic opacity-75">No note.</p>
          )}
        </div>
      ) : null}

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
              run(() => decideApproval(myRequest.id, choice, note || undefined));
            }}
          />
        </div>
      ) : null}

      <div id={detailsId} hidden={!detailsOpen} className="mt-2 border-t border-zinc-200 pt-2" data-approval-details="">
        <p className="text-sm text-zinc-800" data-approval-headline="">
          {headline}
        </p>
        {paused && !canAct ? (
          <p className="mt-1 text-xs text-zinc-500">
            Waiting on {assigneeName} to mark the {status === "rejected" ? "rejection" : "feedback"} received.
          </p>
        ) : null}

        {approvalNotes.length ? (
          <ul className="mt-2 space-y-1.5">
            {approvalNotes.map((r) => (
              <li key={r.id} className="rounded-md border border-green-200 bg-green-50 px-2.5 py-2 text-sm text-green-900">
                <span className="text-xs font-medium">{nameOf(r.approverId, true)}:</span>{" "}
                <span className="whitespace-pre-wrap">{r.decisionNote}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {roundOpen && latest ? <RoundContent round={latest} task={task} nameOf={nameOf} label="What’s being approved" /> : null}

        <dl className={`mt-2 ${PANE_FIELDS}`}>
          <dt className={`${PANE_LABEL} self-start`}>Approvers</dt>
          <dd className="min-w-0">
            <div className="flex min-h-8 flex-wrap items-center gap-1.5 py-0.5">
              <span className="text-zinc-800">
                {approvers.length ? joinNames(approvers.map((a) => (a.profile ? displayName(a.profile) : "Someone"))) : "No approver yet"}
              </span>
              {approvers.length ? approverPicker : null}
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

        {canDecide ? (
          <div className="mt-2">
            <HandOffButton
              candidates={eligible.filter((p) => p.id !== memberId && !settings.approverIds.includes(p.id))}
              onHandOff={(personId, note) => run(() => handOffApproval(task.id, personId, note))}
            />
          </div>
        ) : null}

        {info.rounds.length ? <ApprovalHistory rounds={info.rounds} task={task} nameOf={nameOf} /> : null}
      </div>

      {sending ? <SendForApprovalDialog task={task} profiles={profiles} onClose={() => setSending(false)} /> : null}
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

