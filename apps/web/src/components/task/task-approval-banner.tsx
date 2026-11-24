"use client";

import { createContext, useContext, useId, useOptimistic, useRef, useState, type ReactNode } from "react";
import { applyApprovalChange, type ApprovalChange } from "@alhc/core/approval-optimistic";
import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  History,
  MessageSquareText,
  PanelsTopLeft,
  Paperclip,
  Pause,
  Send,
  ThumbsUp,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { APPROVAL_STATUS_LABELS } from "@alhc/core/task-kinds";
import { feedbackSnippet, feedbackSubtaskText, roundFeedback, shortFileName, type FeedbackTone } from "@alhc/core/approval-feedback";
import { Avatar } from "@/components/avatar";
import { displayName } from "@alhc/core/people";
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
} from "@/lib/actions/approvals";
import { cantDecideMessage, cantSendMessage } from "@alhc/core/approval-complete";
import type { ApprovalRound, TaskApproval, TaskApprovalInfo, TaskDetail } from "@alhc/core/api/task-pane/model";
import type { Profile } from "@alhc/core/api/people/model";
import { formatDueDate, useToday } from "@/lib/dates";
import { taskPermissions } from "@alhc/core/permissions";
import { hasRole } from "@alhc/core/roles";
import { SingleDatePicker } from "./date-picker";
import { PeopleList } from "./person-picker";
import { PANE_FIELDS, PANE_LABEL } from "./pane-styles";
import { SendForApprovalDialog, joinNames } from "./send-for-approval-dialog";
import { ApprovalSetupDialog } from "./approval-setup-dialog";
import { ApproverReview, ApproverReviewDialog } from "./approver-review";
import { approverReviewFiles } from "@alhc/core/approver-review";
import { FeedbackSubtaskButton } from "./feedback-subtask";
import { AssetThumb } from "./asset-thumb";
import { feedbackSubtaskTitle } from "@alhc/core/feedback-subtask";
import { canAddSubtask } from "./task-subtasks";
import { externallyApproved, isTwoStageApproval, reviewsInParallel } from "@alhc/core/external-review";
import { RoleTag } from "./approval-track";
import { APPROVAL_SETUP_UNFINISHED } from "@alhc/core/approval-setup";

// Oct 27 notes (batch 6, items 45 / 45b): the approval panel of an approval task's pane (Nov 4 notes,
// batch 27, 161: feedback as pills; Nov 18 notes, batch 44, item 2: a small status heading under the
// name, and the approval itself as its own section between the description and the subtasks).
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

// Nov 18 notes (batch 44, item 2): the approval's state is shared by the small status heading under the
// task's name and the approval section below the description, so an action in the section (Approve,
// Withdraw, a new approver) changes both at once. One optimistic copy of the server's approval info:
// decisions and round changes (approval-optimistic.ts) and the settings (approvers, how they decide, the
// approval due date). The server's answer replaces it.
type SettingsChange = { type: "settings"; patch: Partial<Settings> };
type ApprovalStateChange = ApprovalChange | SettingsChange;

function approvalStateReducer(current: TaskApprovalInfo | null, change: ApprovalStateChange): TaskApprovalInfo | null {
  if (!current) return current;
  if (change.type === "settings") return { ...current, ...change.patch };
  return applyApprovalChange(current, change);
}

const ApprovalStateContext = createContext<{
  info: TaskApprovalInfo | null;
  apply: (change: ApprovalStateChange) => void;
} | null>(null);

export function ApprovalStateProvider({ task, children }: { task: Pick<TaskDetail, "approval">; children: ReactNode }) {
  const [info, apply] = useOptimistic(task.approval ?? null, approvalStateReducer);
  return <ApprovalStateContext.Provider value={{ info, apply }}>{children}</ApprovalStateContext.Provider>;
}

function useApprovalState(task: Pick<TaskDetail, "approval">) {
  return useContext(ApprovalStateContext) ?? { info: task.approval ?? null, apply: () => {} };
}

// Nov 24 batch 45: the approval as the pane draws it right now (the optimistic copy), for the step track.
export function useApprovalInfo(task: Pick<TaskDetail, "approval">): TaskApprovalInfo | null {
  return useApprovalState(task).info;
}

// Scrolls only the pane's own scroll area (never the page around it) to put the section near the top,
// then focuses it. Smooth unless the person asked for reduced motion.
function revealInScrollArea(section: HTMLElement) {
  let area: HTMLElement | null = section.parentElement;
  while (area && !/(auto|scroll)/.test(getComputedStyle(area).overflowY)) area = area.parentElement;
  if (area) {
    const top = section.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - 16;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    area.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  }
  section.focus({ preventScroll: true });
}

export function approvalSectionId(taskId: string): string {
  return `approval-section-${taskId}`;
}

// The heading's words: "Waiting for approval", else "Approval: <status>" ("Approval: Not sent").
export function approvalHeadingText(info: Pick<TaskApprovalInfo, "status" | "approverIds">): string {
  if (info.status === "pending") return APPROVAL_STATUS_LABELS.pending;
  if (info.status === "not_sent" && info.approverIds.length === 0) return `Approval: ${APPROVAL_SETUP_UNFINISHED.toLowerCase().replace(/^approval /, "")}`;
  return `Approval: ${APPROVAL_STATUS_LABELS[info.status]}`;
}

// Batch 44 (item 2): under the task's name, only a small status heading — the approval's state and its
// approvers' faces. A click scrolls to the approval section (below the description) and focuses it.
export function ApprovalStatusHeading({ task, profiles }: { task: TaskDetail; profiles: Profile[] }) {
  const { info } = useApprovalState(task);
  if (task.kind !== "approval" || !info) return null;
  const status = info.status;
  const latest = info.rounds[0] ?? null;
  const roundOpen = status === "pending" && latest?.status === "pending";
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const shown = info.approverIds.slice(0, 3);
  const names = info.approverIds.map((id) => {
    const p = profilesById.get(id);
    return p ? displayName(p) : "Someone";
  });
  return (
    <button
      type="button"
      data-approval-heading={status}
      aria-controls={approvalSectionId(task.id)}
      onClick={() => {
        const section = document.getElementById(approvalSectionId(task.id));
        if (section) revealInScrollArea(section);
      }}
      className={`mt-1.5 inline-flex max-w-full items-center gap-2 rounded-full py-0.5 pr-2.5 pl-1 text-xs font-medium ring-1 ring-inset transition-colors hover:brightness-95 ${APPROVAL_PILL[status]}`}
    >
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white/80">
        {info.paused ? <Pause className="size-3" aria-hidden /> : <ThumbsUp className={`size-3 ${APPROVAL_ICON[status]}`} aria-hidden />}
      </span>
      <span className="truncate">
        {approvalHeadingText(info)}
        {latest && status !== "not_sent" ? <span className="font-normal opacity-75"> · Round {latest.number}</span> : null}
        {info.paused ? <span className="font-normal opacity-75"> · Paused</span> : null}
      </span>
      {shown.length ? (
        <span className="flex shrink-0 -space-x-1" aria-label={`${names.length === 1 ? "Approver" : "Approvers"}: ${joinNames(names)}`}>
          {shown.map((id) => {
            const profile = profilesById.get(id) ?? null;
            const request = roundOpen ? latest?.requests.find((r) => r.approverId === id && r.status !== "cancelled") : undefined;
            return (
              <span key={id} data-approver={id} className="relative inline-flex rounded-full ring-2 ring-white">
                <Avatar name={profile ? displayName(profile) : "Someone"} src={profile?.avatar_url} profileId={id} size="sm" />
                {request?.status === "approved" ? (
                  <Check className="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-white text-green-600" aria-label="Approved" />
                ) : null}
              </span>
            );
          })}
          {info.approverIds.length > shown.length ? (
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-white text-2xs font-medium text-zinc-600 ring-2 ring-white">
              +{info.approverIds.length - shown.length}
            </span>
          ) : null}
        </span>
      ) : null}
      <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
      <span className="sr-only">Go to the approval section</span>
    </button>
  );
}

export function ApprovalTaskBanner({
  task,
  profiles,
  memberId,
  onOpenReviewTab,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
  // Nov 24 batch 45: "Open in Review tab".
  onOpenReviewTab?: () => void;
}) {
  const shared = useContext(ApprovalStateContext);
  if (!task.approval) {
    return (
      <section aria-label="Approval" className="mt-6 rounded-lg border border-zinc-200 bg-zinc-50/70 px-3 py-2.5">
        <p className="flex items-center gap-2 text-sm text-zinc-700">
          <ThumbsUp className="size-4 shrink-0 text-zinc-500" aria-hidden />
          Couldn’t load this approval. Close the task and open it again to try again.
        </p>
      </section>
    );
  }
  const panel = <ApprovalPanel task={task} profiles={profiles} memberId={memberId} onOpenReviewTab={onOpenReviewTab} />;
  // Rendered on its own (tests, the instant preview): it keeps its own optimistic copy.
  return shared ? panel : <ApprovalStateProvider task={task}>{panel}</ApprovalStateProvider>;
}

// Batch 44 (item 2): the approval as its own section, below the description and above the subtasks — a
// panel with a dark header (the approval's name, status, and round), then everything about it: what it
// says in plain words, the viewer's next step, the approver's decision (and their compact review of the
// round's files), what's being approved, the approvers, how they decide, the approval due date, Hand
// off / Withdraw, the latest feedback, and the history.
function ApprovalPanel({
  task,
  profiles,
  memberId,
  onOpenReviewTab,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
  onOpenReviewTab?: () => void;
}) {
  const [pending, run] = useServerAction();
  const state = useApprovalState(task);
  const info = state.info ?? task.approval!;
  const applyInfo = state.apply;
  const nowIso = () => new Date().toISOString();
  const notify = useNotify();
  const confirm = useConfirm();
  const today = useToday();
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [sending, setSending] = useState(false);
  // Nov 1 notes, batch 9a: the guided setup (choose approvers, then what happens after approval).
  const [settingUp, setSettingUp] = useState(false);
  // The decision the approver started (Approve / Request changes / Reject): its note step shows in the section.
  const [decision, setDecision] = useState<{ choice: Decision; nonce: number } | null>(null);
  // Nov 2 notes (batch 15, 114): the approver's per-file review, full screen in the app.
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const settings: Settings = { approverIds: info.approverIds, mode: info.mode, dueOn: info.dueOn };

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
  // Submit once every file is reviewed), like the requester review page; Reject stays with the actions.
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
  // Nov 24 batch 45: the outside reviewer has their own (amber) block; this one is the team's.
  const externalReviewer = task.approval?.approverIds.length ? (task.externalReview?.reviewer ?? null) : null;
  const canSend =
    canAct &&
    !completed &&
    (status === "not_sent" || ((status === "changes_requested" || status === "rejected") && !paused) || status === "approved");

  function reveal() {
    const section = sectionRef.current;
    section?.scrollIntoView?.({ block: "nearest" });
  }

  // A row's (or the pane header's) "Ready for approval" / "Approve" lands here (approval-action.ts).
  useApprovalActionListener(
    task.id,
    (action) => {
      reveal();
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
    },
    // "convert" (a template's new approval task) is the pane's: it opens the setup that makes it one.
    (action) => action !== "convert",
  );

  function save(patch: Partial<Settings>) {
    const next = { ...settings, ...patch };
    run(() => setTaskApprovers(task.id, next), () => applyInfo({ type: "settings", patch }));
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

  // The state in plain words, at the top of the section.
  let headline: string;
  const decider = latest?.decidedBy ?? null;
  if (status === "not_sent") {
    if (completed) headline = "The task is complete. It wasn’t sent for approval.";
    else if (settings.approverIds.length === 0) headline = `${APPROVAL_SETUP_UNFINISHED}. Choose who approves this before anything is sent.`;
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
    // Note 183: a two-stage task stays open after the internal approval (no follow-up runs).
    const outcome = isTwoStageApproval(task) && !completed
      ? externallyApproved(task.externalReview)
        ? "The external reviewer approved it too. Its approvers or its assignee complete it."
        : "Next: the external review. The task stays open."
      : latest
        ? approvedOutcome(latest)
        : "";
    headline = `Approved by ${approvedBy.length ? joinNames(approvedBy) : nameOf(decider)}. ${outcome}`.trim();
  }

  const dueOverdue = Boolean(roundOpen && settings.dueOn && today && settings.dueOn < today);
  const decide = (choice: Decision) => setDecision({ choice, nonce: Date.now() });
  const small = "h-8 px-2.5 text-xs";

  // Choosing approvers (Editors+; Owners / Admins while a round is pending).
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
          emptyNote="Approvers need to be able to comment in this task’s project."
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
            <button type="button" disabled={pending} onClick={() => decide("approved")} className={`btn-primary bg-green-600 hover:bg-green-700 ${small}`}>
              <ThumbsUp className="size-3.5" aria-hidden />
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
          className={`btn-ghost text-zinc-700 hover:bg-red-50 hover:text-red-700 ${small}`}
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

  // Nov 24 batch 45: what happens when it's approved, in the block's meta line.
  const followUpRound = latest && (latest.status === "pending" || latest.status === "approved") ? latest : null;
  const followUpAfter = followUpRound?.afterApproval ?? info.followUp?.afterApproval ?? "complete";
  const followUpSection =
    followUpRound?.moveSectionName ??
    (info.followUp?.sectionId
      ? (task.memberships.flatMap((m) => m.sections).find((sec) => sec.id === info.followUp?.sectionId)?.name ?? null)
      : null);
  const followUpText =
    followUpAfter === "move_section" ? `move to ${followUpSection ?? "the chosen section"}` : followUpAfter === "notify" ? "tell the assignee" : "complete the task";
  const outsideName = externalReviewer ? (externalReviewer.name?.trim().split(/\s+/)[0] ?? externalReviewer.email) : null;
  const followUpWhen = outsideName
    ? `When the team and ${outsideName} approve`
    : settings.mode === "all" && settings.approverIds.length > 1
      ? "When everyone’s approved"
      : "When it’s approved";
  const myTurn = Boolean(myRequest);
  const waitingNames = roundOpen
    ? (latest?.requests ?? []).filter((r) => r.status === "pending").map((r) => nameOf(r.approverId, true))
    : [];
  const badge: { text: string; tone: "blue" | "green" | "amber" | "red" | "grey"; icon: "clock" | "check" | "back" | "x" | "dot" } =
    status === "pending"
      ? {
          text: `${myTurn ? "Waiting on you" : `Waiting on ${waitingNames.length ? joinNames(waitingNames) : joinNames(approverNames)}`}${settings.dueOn ? ` · due ${formatDueDate(settings.dueOn)}` : ""}`,
          tone: "blue",
          icon: "clock",
        }
      : status === "approved"
        ? { text: latest?.decidedAt ? `Approved ${formatDueDate(latest.decidedAt.slice(0, 10))}` : "Approved", tone: "green", icon: "check" }
        : status === "changes_requested"
          ? { text: paused ? "Changes requested · paused" : "Changes requested", tone: "amber", icon: "back" }
          : status === "rejected"
            ? { text: paused ? "Rejected · paused" : "Rejected", tone: "red", icon: "x" }
            : latest?.closedReason === "outside_changes"
              ? { text: "Round ended", tone: "grey", icon: "back" }
              : { text: settings.approverIds.length ? "Not sent yet" : "Setup not finished", tone: "grey", icon: "dot" };
  const BADGE_CLASS = {
    blue: "bg-accent-500 text-white",
    green: "bg-green-100 text-green-700",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-800",
    grey: "bg-zinc-100 text-zinc-600",
  } as const;
  const BadgeIcon = { clock: Clock, check: Check, back: AlertCircle, x: X, dot: Clock }[badge.icon];

  return (
    <section
      ref={sectionRef}
      id={approvalSectionId(task.id)}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="scroll-mt-4 rounded-[10px] border border-l-4 border-[#c0d1f1] border-l-accent-500 bg-gradient-to-t from-white to-[#f6f8fd] px-3.5 pt-[11px] pb-3 outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2"
      data-approval-section=""
      data-review-block="team"
      data-approval-status={status}
      data-approval-paused={paused ? "true" : undefined}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2" data-approval-header="">
        <h3 id={headingId} className="m-0 flex items-center">
          <RoleTag role="team" />
        </h3>
        <span
          className={`inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_CLASS[badge.tone]}`}
          data-approval-pill=""
        >
          {paused ? <Pause className="size-3 shrink-0" aria-hidden /> : <BadgeIcon className="size-3 shrink-0" aria-hidden />}
          <span className="truncate">{badge.text}</span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-medium text-zinc-800" data-approval-people="">
        {approvers.length ? (
          approvers.map(({ id, profile }) => {
            const name = profile ? displayName(profile) : "Someone";
            const request = roundOpen ? latest?.requests.find((r) => r.approverId === id && r.status !== "cancelled") : undefined;
            return (
              <span key={id} data-approver={id} className="inline-flex max-w-full items-center gap-1.5 text-sm">
                <Avatar name={name} src={profile?.avatar_url} profileId={id} size="md" />
                <span className="truncate">{id === memberId ? `${name} (you)` : name}</span>
                {request?.status === "approved" ? (
                  <Check className="size-3.5 shrink-0 text-green-600" aria-label="Approved" />
                ) : request?.status === "pending" ? (
                  <Clock className="size-3.5 shrink-0 text-amber-600" aria-label="Waiting" />
                ) : null}
              </span>
            );
          })
        ) : (
          <span className="text-xs font-medium text-amber-800" data-approval-unfinished="">
            {APPROVAL_SETUP_UNFINISHED}
          </span>
        )}
        {approverPicker}
      </div>

      <p className="mt-1.5 text-xs leading-[17px] text-zinc-600" data-approval-meta="">
        {APPROVAL_MODE_LABELS[settings.mode]}
        {settings.dueOn ? <> · Approval due <span className={dueOverdue ? "font-medium text-red-700" : ""}>{formatDueDate(settings.dueOn)}{dueOverdue ? " (overdue)" : ""}</span></> : null}
        {settings.approverIds.length ? (
          <>
            {" "}· {followUpWhen}: <b className="font-medium text-zinc-800">{followUpText}</b>
          </>
        ) : null}
      </p>
      {status !== "pending" || paused ? (
        <p className="mt-1 text-xs text-zinc-600" data-approval-headline="">
          {headline}
        </p>
      ) : (
        <p className="sr-only" data-approval-headline="">
          {headline}
        </p>
      )}
      {paused && !canAct ? (
        <p className="mt-1 text-xs text-zinc-500">
          Waiting on {assigneeName} to mark the {status === "rejected" ? "rejection" : "feedback"} received.
        </p>
      ) : null}

      {action || canDecide || canWithdraw || onOpenReviewTab ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-approval-row="">
          {action}
          {canDecide && !decision ? (
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
                  message: reviewsInParallel(task)
                    ? "The approvers can’t decide on it anymore, and the outside review sent with it is withdrawn too. You can send it again later."
                    : "The approvers can’t decide on it anymore. You can send it again later.",
                  confirmLabel: "Withdraw",
                  cancelLabel: "Keep it",
                  tone: "danger",
                });
                if (ok) run(() => withdrawApproval(task.id), () => applyInfo({ type: "withdraw", at: nowIso() }));
              }}
              className="btn-ghost h-8 px-2 text-xs text-zinc-600"
            >
              Withdraw
            </button>
          ) : null}
          {onOpenReviewTab && !reviewsFiles && latest ? (
            <button type="button" onClick={onOpenReviewTab} className="btn-ghost h-8 px-2 text-xs text-zinc-600" data-approval-open-tab="">
              <PanelsTopLeft className="size-3.5" aria-hidden />
              Open in Review tab
            </button>
          ) : null}
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
              run(
                () => decideApproval(myRequest.id, choice, note || undefined),
                () =>
                  applyInfo({ type: "decide", requestId: myRequest.id, decision: choice, note: note || null, by: memberId, at: nowIso() }),
              );
            }}
          />
        </div>
      ) : null}

      {/* The approver's compact review of the round's files, right here (Expand / Open review: full screen). */}
      {reviewsFiles && myRequest && latest && !decision ? (
        <ApproverReview
          taskId={task.id}
          requestId={myRequest.id}
          round={latest}
          attachments={task.attachments}
          onExpand={() => setReviewExpanded(true)}
          onDecide={(choice, note) =>
            applyInfo({ type: "decide", requestId: myRequest.id, decision: choice, note: note || null, by: memberId, at: nowIso() })
          }
        />
      ) : null}

      {roundOpen && latest && !(canDecide && decision) ? (
        <RoundContent round={latest} task={task} nameOf={nameOf} label="What’s being approved" />
      ) : null}

      <ApprovalFeedback task={{ ...task, approval: info }} profiles={profiles} memberId={memberId} inSection />

      <details className="group/details mt-2.5 border-t border-[#dfe6f5] pt-2" data-approval-details="">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 transition-transform group-open/details:rotate-90" aria-hidden />
          Approvers, due date, and history
        </summary>
        <dl className={`mt-2 ${PANE_FIELDS}`}>
          <dt className={`${PANE_LABEL} self-start`}>{approvers.length === 1 ? "Approver" : "Approvers"}</dt>
          <dd className="min-w-0">
            <div className="flex min-h-8 flex-wrap items-center gap-1.5 py-0.5">
              {approvers.map(({ id }) => (
                <span key={id} className="inline-flex items-center rounded-full bg-white px-2 py-0.5 text-xs text-zinc-700 ring-1 ring-zinc-200">
                  {nameOf(id, true)}
                </span>
              ))}
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
                buttonClassName="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md px-1 text-sm hover:bg-white aria-expanded:bg-white"
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
        {canChangeApprovers && !roundOpen && !completed ? (
          <button type="button" onClick={() => setSettingUp(true)} className="btn-ghost mt-1 h-7 px-2 text-xs text-accent-700" data-approval-edit-setup="">
            Edit the approval setup…
          </button>
        ) : null}
        {info.rounds.length ? <ApprovalHistory rounds={info.rounds} task={task} nameOf={nameOf} /> : null}
      </details>

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
// Batch 44 (item 2): drawn inside the approval section (`inSection`), under its details.
export function ApprovalFeedback({
  task,
  profiles,
  memberId,
  inSection = false,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
  inSection?: boolean;
}) {
  const latest = task.approval?.rounds[0] ?? null;
  const items = roundFeedback(latest, task.attachments);
  if (!latest || items.length === 0) return null;
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const nameOf = (id: string) => (id === memberId ? "You" : profilesById.get(id) ? displayName(profilesById.get(id)!) : "Someone");
  const canSubtask = canAddSubtask(task);
  const contentTypes = new Map(task.attachments.map((a) => [a.id, a.contentType] as const));
  return (
    <section
      id={`approval-feedback-${task.id}`}
      className={inSection ? "mt-3 scroll-mt-4 border-t border-zinc-100 pt-2.5" : "mt-6 scroll-mt-4"}
      aria-labelledby={`approval-feedback-heading-${task.id}`}
      data-approval-feedback=""
    >
      <h3
        id={`approval-feedback-heading-${task.id}`}
        className={`flex items-center gap-1.5 font-semibold text-zinc-900 ${inSection ? "text-xs" : "text-sm"}`}
      >
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
                    {item.fileName ? (
                      // Nov 5 note 166: which file this is about, at a glance.
                      <AssetThumb
                        fileId={item.fileId}
                        fileName={item.fileName}
                        contentType={contentTypes.get(item.fileId ?? "") ?? null}
                        className="-ml-1 size-5"
                        iconClassName="size-3"
                      />
                    ) : null}
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
                        <a
                          href={`/attachments/${item.fileId}?preview=1`}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2 break-all text-xs font-medium text-zinc-800 hover:underline"
                        >
                          <AssetThumb
                            fileId={item.fileId}
                            fileName={item.fileName}
                            contentType={contentTypes.get(item.fileId) ?? null}
                            className="size-12"
                            iconClassName="size-5"
                          />
                          {item.fileName}
                        </a>
                      ) : (
                        <p className="flex items-center gap-2 break-all text-xs font-medium text-zinc-800">
                          <AssetThumb fileId={null} fileName={item.fileName} className="size-12" iconClassName="size-5" />
                          {item.fileName}
                        </p>
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
                      <FeedbackSubtaskButton
                        task={task}
                        feedback={item.text}
                        file={item.fileName ? { id: item.fileId, name: item.fileName } : null}
                        legacyTitle={item.fileName ? feedbackSubtaskTitle(feedbackSubtaskText(item)) : null}
                        from={nameOf(item.approverId)}
                        className="-ml-1.5"
                      />
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
          {missing ? "Add a note saying what needs to change before you send it." : `${reader} gets this note with your decision.`}
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
        emptyNote="Nobody else here can approve it (approvers need to be able to comment)."
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

