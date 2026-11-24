"use client";

import { useId, useState, type ReactNode } from "react";
import { CalendarDays, ChevronDown, ChevronRight, Eye, MessageSquareText, Plus, X } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { displayName } from "@alhc/core/people";
import { useConfirm } from "@/components/confirm";
import { Dialog } from "@/components/dialog";
import { Popover } from "@/components/popover";
import { SmartPicker } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import { setUpApprovalTask } from "@/lib/actions/approvals";
import { withdrawReviewCheck } from "@/lib/actions/reviews";
import { setTaskKind } from "@/lib/actions/tasks";
import type { TaskKind } from "@alhc/core/task-kinds";
import { externalReviewerSectionOpen, reviewerLabel, TWO_STAGE_FOLLOW_UP_NOTE, TWO_STEP_NOTE } from "@alhc/core/external-review";
import {
  APPROVAL_SETUP_LEAVE,
  approvalSetupProblem,
  approvalSetupUnfinished,
  defaultApprovalSetup,
  type ApprovalFollowUp,
  type ApprovalSetupDraft,
} from "@alhc/core/approval-setup";
import { approvalPlanSummary, outsideName } from "@alhc/core/approval-track";
import { planTrack } from "@alhc/core/approval-plan";
import type { Profile } from "@alhc/core/api/people/model";
import type { ReviewOrder, TaskDetail } from "@alhc/core/api/task-pane/model";
import { hasRole } from "@alhc/core/roles";
import { SingleDatePicker } from "./date-picker";
import { PeopleList } from "./person-picker";
import { TrackPills, weekdayDate } from "./approval-track";

// Nov 1 notes, batch 9a (Avi's decision b): "by default it should be easy: choose an approver, they
// approve it, and then a follow-up step decision." Opens when a person makes a task an approval task (the
// pane's Task type, Add approval in a List / Board) and from the approval's Finish setup.
// Nov 10 batch 36: the setup also names the outside reviewer (the requester by default); a review that is
// already open is named, with Withdraw, instead of being replaced silently.
// Notes 184–186: the outside reviewer is a collapsed optional section; leaving with no approver asks first.
// Nov 18 notes (batch 44, item 3): `make` — the task becomes an approval only when this is done
// (setUpApprovalTask: the type, the approvers, and what happens after, in one go). Leaving early writes
// nothing (`undoKind`: only for a template's task that is still an approval, which goes back to that kind).
// Nov 24 batch 45 (docs/design/task-card/png/08): everything on one screen under a live preview pinned at
// the top — the plan's pills (Work → Team → Outside → Done; in the parallel order the team and the outside
// reviewer share a column) and a plain-English summary — that follows every choice. New: the Order (team
// first, then outside / at the same time), the outside reviewer's due date, and "When everyone has
// approved" for two-stage tasks too (the step runs by itself once the last stage approves).

const FOLLOW_UP_CARDS: Record<ApprovalFollowUp, { label: string; hint: string }> = {
  complete: { label: "Complete the task", hint: "Finishes it" },
  move_section: { label: "Move to a section", hint: "For a next step" },
  notify: { label: "Just notify", hint: "Assignee is told" },
};

const LABEL = "mb-1.5 block text-[13px] font-medium text-zinc-800";
const NEW_TAG = (
  <span className="ml-1.5 inline-flex rounded bg-violet-100 px-1.5 text-[10px] leading-4 font-bold tracking-wider text-violet-700 uppercase">
    New
  </span>
);
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

// A radio drawn as a card (How they decide, When everyone has approved).
function RadioCard({
  name,
  checked,
  disabled = false,
  onChange,
  label,
  hint,
  children,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
  hint: ReactNode;
  children?: ReactNode;
}) {
  return (
    <label
      className={`flex min-w-0 items-start gap-2.5 rounded-lg border px-2.5 py-1.5 transition-colors ${
        checked ? "border-accent-500 bg-[#f0f4fc]" : "border-zinc-200 hover:border-zinc-300"
      } ${disabled ? "cursor-not-allowed text-zinc-400" : "cursor-pointer text-zinc-800"}`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-1 size-3.5 shrink-0 accent-accent-600"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="block text-xs text-zinc-500">{hint}</span>
        {children}
      </span>
    </label>
  );
}

// A date as a field-like button with the calendar (Approval due, Outside reviewer due).
function DateField({ label, value, onChange, disabled = false }: { label: string; value: string | null; onChange: (value: string | null) => void; disabled?: boolean }) {
  return (
    <Popover
      label={label}
      disabled={disabled}
      panelClassName="w-72 p-0"
      buttonClassName="field flex h-9 w-full items-center gap-2 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-60"
      button={
        <>
          <CalendarDays className="size-4 shrink-0 text-zinc-500" aria-hidden />
          <span className={value ? "text-zinc-900" : "text-zinc-500"}>{value ? weekdayDate(value) : "No due date"}</span>
        </>
      }
    >
      {(close) => (
        <SingleDatePicker
          label={label}
          value={value}
          onChange={(next) => {
            close();
            onChange(next);
          }}
        />
      )}
    </Popover>
  );
}

export function ApprovalSetupDialog({
  task,
  profiles,
  onClose,
  make = false,
  undoKind,
}: {
  task: TaskDetail;
  profiles: Profile[];
  onClose: () => void;
  make?: boolean;
  undoKind?: TaskKind;
}) {
  const ids = useId();
  const notify = useNotify();
  const confirm = useConfirm();
  const [pending, run] = useServerAction();
  const info = task.approval;
  const [tried, setTried] = useState(false);
  const [draft, setDraft] = useState<ApprovalSetupDraft>(() =>
    defaultApprovalSetup({
      approverIds: info?.approverIds ?? [],
      mode: info?.mode ?? "any",
      dueOn: info?.dueOn ?? null,
      followUp: info?.followUp?.afterApproval ?? "complete",
      sectionId: info?.followUp?.sectionId ?? null,
      reminders: info?.followUp?.reminders ?? true,
    }),
  );
  const patch = (next: Partial<ApprovalSetupDraft>) => setDraft((current) => ({ ...current, ...next }));
  const savedReviewer = task.externalReview?.saved ?? null;
  const [reviewerEmail, setReviewerEmail] = useState(savedReviewer?.email ?? task.submission?.email ?? "");
  const [reviewerName, setReviewerName] = useState(savedReviewer?.name ?? task.submission?.name ?? "");
  // Batch 45: the review order and the outside reviewer's due date (task_review_settings).
  const savedOrder: ReviewOrder = task.externalReview?.plan?.order ?? "sequential";
  const savedDue = task.externalReview?.plan?.dueOn ?? null;
  const [order, setOrder] = useState<ReviewOrder>(savedOrder);
  const [reviewerDueOn, setReviewerDueOn] = useState<string | null>(savedDue);
  const [openReview, setOpenReview] = useState(task.externalReview?.latest?.status === "pending" ? task.externalReview.latest : null);
  const reviewerChanged =
    reviewerEmail.trim().toLowerCase() !== (savedReviewer?.email ?? "") || (reviewerName.trim() || null) !== (savedReviewer?.name ?? null);
  const planChanged = order !== savedOrder || reviewerDueOn !== savedDue;
  // The database refuses changing the order while a team round or an outside review is open.
  const roundOpen = info?.rounds[0]?.status === "pending" || task.externalReview?.latest?.status === "pending";

  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const eligible = profiles.filter((p) => hasRole(task.memberRoles[p.id], "commenter") || draft.approverIds.includes(p.id));
  const names = draft.approverIds.map((id) => {
    const p = profilesById.get(id);
    return p ? displayName(p) : "Someone";
  });
  // Sections of the task's projects where the viewer edits (subtasks aren't in sections).
  const sectionOptions = task.isSubtask
    ? []
    : task.memberships
        .filter((m) => task.editableProjectIds.includes(m.projectId))
        .flatMap((m) =>
          m.sections.map((s) => ({ value: s.id, label: s.name, group: task.memberships.length > 1 ? m.projectName : undefined })),
        );
  const sectionName = sectionOptions.find((o) => o.value === draft.sectionId)?.label ?? null;
  const namedReviewer = Boolean(reviewerEmail.trim());
  // Note 183: approvers plus an outside reviewer = two-stage.
  const twoStage = draft.approverIds.length > 0 && namedReviewer;
  const problem = approvalSetupProblem("approvers", draft) ?? approvalSetupProblem("after", draft);
  const reviewerStartsOpen = externalReviewerSectionOpen({
    savedEmail: savedReviewer?.email,
    submissionEmail: task.submission?.email,
    pendingReview: task.externalReview?.latest?.status === "pending",
  });

  // The live preview: the plan as it stands in the form.
  const reviewer = namedReviewer ? { email: reviewerEmail.trim().toLowerCase(), name: reviewerName.trim() || null } : null;
  const plan = planTrack({
    assigneeId: task.assigneeId,
    approverIds: draft.approverIds,
    approverNames: names,
    mode: draft.mode,
    reviewer,
    reviewerDueOn,
    order,
    after: draft.followUp,
    sectionName,
    approvalDueOn: draft.dueOn,
  });
  const summary = approvalPlanSummary({
    approverNames: names.map(firstName),
    mode: draft.mode,
    reviewerName: twoStage && reviewer ? outsideName(reviewer) : null,
    order,
    after: draft.followUp,
    sectionName,
  });

  // Note 185: closing (Skip, Cancel, Escape, the X) while nobody approves it yet asks before leaving the task
  // half set up. A setup that already has approvers just closes. Batch 44: making a task an approval isn't
  // half set up when it's left — it simply doesn't happen (nothing was saved), so it just closes.
  async function requestClose() {
    // While Done is saving, the setup stays open: closing then would say nothing changed while the save
    // goes on (and a Cancel's undo could race it).
    if (pending) return;
    if (make) {
      if (undoKind && undoKind !== task.kind) run(() => setTaskKind(task.id, undoKind));
      notify(`Not made an approval. It stays a ${(undoKind ?? task.kind) === "milestone" ? "milestone" : "task"}.`);
      onClose();
      return;
    }
    if (approvalSetupUnfinished(info?.approverIds.length ?? 0)) {
      const leave = await confirm(APPROVAL_SETUP_LEAVE);
      if (!leave) return;
    }
    onClose();
  }

  function toggle(id: string) {
    patch({
      approverIds: draft.approverIds.includes(id) ? draft.approverIds.filter((a) => a !== id) : [...draft.approverIds, id],
    });
  }

  function finish() {
    setTried(true);
    if (problem) return;
    run(async () => {
      const result = await setUpApprovalTask(task.id, {
        // A template's task that is still an approval (undoKind) keeps its kind; anything else becomes one now.
        fromKind: make ? task.kind : "approval",
        approvers: { approverIds: draft.approverIds, mode: draft.mode, dueOn: draft.dueOn },
        followUp: { followUp: draft.followUp, sectionId: draft.sectionId, reminders: draft.reminders },
        reviewer:
          reviewerChanged && (reviewerEmail.trim() || savedReviewer)
            ? { email: reviewerEmail.trim() || null, name: reviewerName.trim() || null }
            : undefined,
        // Batch 45: only when it changed (an unchanged order is never refused because a round is open).
        plan: planChanged ? { order, dueOn: reviewerDueOn } : undefined,
      });
      if (!result.error) {
        notify(`${make ? "Approval made" : "Approval set up"}. ${summary.sentence}`);
        onClose();
      }
      return result;
    });
  }

  // The summary with the section in bold, as in the mockup ("it moves to **Ready to publish**").
  const sentence =
    sectionName && draft.followUp === "move_section" && summary.sentence.includes(sectionName) ? (
      <>
        {summary.sentence.slice(0, summary.sentence.indexOf(sectionName))}
        <b className="font-semibold text-zinc-900">{sectionName}</b>
        {summary.sentence.slice(summary.sentence.indexOf(sectionName) + sectionName.length)}
      </>
    ) : (
      summary.sentence
    );

  return (
    <Dialog
      title={make ? "Make this an approval" : "Set up this approval"}
      description={make ? "It becomes an approval task only when you finish here. Until then nothing changes." : task.title}
      width="max-w-[39rem]"
      onClose={requestClose}
    >
      <div className="flex flex-col gap-4" data-approval-setup={make ? "make" : "setup"}>
        {/* The live preview stays at the top while the form scrolls under it. */}
        <div className="sticky -top-5 z-[1] -mx-5 -mt-1 border-b border-zinc-200 bg-white px-5 pt-1 pb-3" data-approval-preview="">
          <div className="rounded-[10px] border border-zinc-200 bg-white px-3 pt-2 pb-2.5">
            <p className="mb-[7px] flex items-center gap-1.5 text-[11px] leading-4 font-medium tracking-[0.01em] text-zinc-500">
              <Eye className="size-3" aria-hidden />
              Live preview · updates as you choose
            </p>
            <TrackPills track={plan} profiles={profiles} variant="plan" />
          </div>
          <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-zinc-700" aria-live="polite" data-approval-summary="">
            <MessageSquareText className="mt-0.5 size-4 shrink-0 text-zinc-400" aria-hidden />
            <span>{sentence}</span>
          </p>
        </div>

        <div>
          <span className={LABEL} id={`${ids}-approvers`}>
            Team approvers
          </span>
          <ul className="flex flex-wrap items-center gap-1.5" aria-labelledby={`${ids}-approvers`}>
            {draft.approverIds.map((id, i) => (
              <li
                key={id}
                className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white py-0.5 pr-1.5 pl-0.5 text-[13px] text-zinc-800"
              >
                <Avatar name={names[i]} profileId={id} />
                {names[i]}
                <button
                  type="button"
                  aria-label={`Remove ${names[i]}`}
                  onClick={() => toggle(id)}
                  className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
            <li>
              <Popover
                label="Add a team approver"
                panelClassName="w-72 p-0"
                buttonClassName="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-zinc-300 px-2.5 text-[13px] text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 aria-expanded:border-zinc-400"
                button={
                  <>
                    <Plus className="size-3.5" aria-hidden />
                    Add
                  </>
                }
              >
                {() => (
                  <PeopleList
                    label="Approvers"
                    people={eligible}
                    selected={draft.approverIds}
                    emptyNote="Approvers need to be able to comment in this task’s project."
                    footer={<p className="px-2.5 py-1.5 text-2xs text-zinc-500">Ticked people approve it. Pick someone again to remove them.</p>}
                    onPick={toggle}
                  />
                )}
              </Popover>
            </li>
          </ul>
          {draft.approverIds.length === 0 ? (
            <p className="mt-1 text-xs text-zinc-500">The assignee does the work, then sends it to the people you pick.</p>
          ) : null}
        </div>

        <fieldset>
          <legend className={LABEL}>How they decide</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <RadioCard name={`${ids}-mode`} checked={draft.mode === "any"} onChange={() => patch({ mode: "any" })} label="Any one" hint="The first approval is enough" />
            <RadioCard name={`${ids}-mode`} checked={draft.mode === "all"} onChange={() => patch({ mode: "all" })} label="Everyone" hint="Every approver has to approve" />
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className={LABEL}>Approval due</span>
            <DateField label="Approval due" value={draft.dueOn} onChange={(value) => patch({ dueOn: value })} />
          </div>
          <div>
            <span className={LABEL} id={`${ids}-reminders`}>
              Reminders
            </span>
            <div className="flex h-9 items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={draft.reminders}
                aria-labelledby={`${ids}-reminders`}
                aria-describedby={`${ids}-reminders-hint`}
                onClick={() => patch({ reminders: !draft.reminders })}
                className={`relative inline-flex h-5 w-[34px] shrink-0 rounded-full transition-colors ${draft.reminders ? "bg-accent-500" : "bg-zinc-300"}`}
              >
                <span
                  aria-hidden
                  className={`absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-[left] ${draft.reminders ? "left-[16px]" : "left-0.5"}`}
                />
              </button>
              <span id={`${ids}-reminders-hint`} className="text-xs text-zinc-500">
                Day before and when overdue
              </span>
            </div>
          </div>
        </div>

        <ExternalReviewerSection
          ids={ids}
          startsOpen={reviewerStartsOpen}
          email={reviewerEmail}
          name={reviewerName}
          onEmail={setReviewerEmail}
          onName={setReviewerName}
          showTwoStep={twoStage && order === "sequential"}
          parallel={order === "parallel"}
          openReview={openReview}
          pending={pending}
          onWithdraw={() =>
            openReview
              ? run(async () => {
                  const result = await withdrawReviewCheck(openReview.id);
                  if (!result.error) setOpenReview(null);
                  return result;
                })
              : undefined
          }
        />

        {twoStage ? (
          <>
            <div data-review-order="">
              <span className={LABEL} id={`${ids}-order`}>
                Order
              </span>
              <div
                role="radiogroup"
                aria-labelledby={`${ids}-order`}
                aria-describedby={roundOpen ? `${ids}-order-locked` : undefined}
                className="inline-flex max-w-full flex-wrap gap-[3px] rounded-lg border border-zinc-200 bg-zinc-100 p-[3px]"
              >
                {(["sequential", "parallel"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={order === value}
                    disabled={roundOpen && value !== order}
                    data-review-order-option={value}
                    onClick={() => setOrder(value)}
                    onKeyDown={(e) => {
                      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !roundOpen) {
                        e.preventDefault();
                        setOrder(value === "sequential" ? "parallel" : "sequential");
                        (e.currentTarget.parentElement?.querySelector(`[data-review-order-option="${value === "sequential" ? "parallel" : "sequential"}"]`) as HTMLElement | null)?.focus();
                      }
                    }}
                    className={`inline-flex items-center rounded-md px-3 py-[5px] text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      order === value ? "bg-white text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-zinc-600 hover:text-zinc-900"
                    }`}
                  >
                    {value === "sequential" ? "Team first, then outside" : <>At the same time{NEW_TAG}</>}
                  </button>
                ))}
              </div>
              {roundOpen ? (
                <p id={`${ids}-order-locked`} className="mt-1 text-xs text-zinc-500" data-review-order-locked="">
                  Change the order once the current round is decided or withdrawn.
                </p>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <span className={LABEL}>
                  Outside reviewer due{NEW_TAG}
                </span>
                <DateField label="Outside reviewer due" value={reviewerDueOn} onChange={setReviewerDueOn} />
              </div>
            </div>
          </>
        ) : null}

        <fieldset data-when-approved="">
          <legend className={LABEL}>{twoStage ? "When everyone has approved" : "When it’s approved"}</legend>
          {twoStage ? (
            <p role="note" className="mb-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700" data-two-stage-note="">
              {TWO_STAGE_FOLLOW_UP_NOTE}
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(FOLLOW_UP_CARDS) as ApprovalFollowUp[]).map((key) => {
              const disabled = key === "move_section" && sectionOptions.length === 0;
              return (
                <RadioCard
                  key={key}
                  name={`${ids}-after`}
                  checked={draft.followUp === key}
                  disabled={disabled}
                  onChange={() => patch({ followUp: key })}
                  label={FOLLOW_UP_CARDS[key].label}
                  hint={disabled ? (task.isSubtask ? "Subtasks aren’t in sections" : "You can’t move it in its projects") : key === "move_section" && sectionName ? sectionName : FOLLOW_UP_CARDS[key].hint}
                />
              );
            })}
          </div>
          {draft.followUp === "move_section" && sectionOptions.length ? (
            <SmartPicker
              label="Section"
              placeholder="Choose the section"
              className="mt-2 w-full sm:w-1/2"
              options={sectionOptions}
              value={draft.sectionId}
              onChange={(value) => patch({ sectionId: value })}
            />
          ) : null}
        </fieldset>

        {tried && problem ? (
          <p role="alert" className="text-sm text-red-700">
            {problem}
          </p>
        ) : null}

        <div className="-mx-5 -mb-5 flex items-center gap-2 border-t border-zinc-200 px-5 py-3">
          <button
            type="button"
            onClick={() => void requestClose()}
            disabled={pending}
            className="btn-ghost mr-auto text-zinc-500"
            data-approval-setup-skip=""
          >
            {make ? "Cancel" : "Skip for now"}
          </button>
          {make ? null : (
            <button type="button" onClick={() => void requestClose()} disabled={pending} className="btn-secondary" data-approval-setup-cancel="">
              Cancel
            </button>
          )}
          <button type="button" onClick={finish} disabled={pending} className="btn-primary" data-approval-setup-done="">
            {pending ? "Saving…" : make ? "Make it an approval" : "Done"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// Note 184: "Outside reviewer (optional)" stays closed unless a reviewer is already named. The two-step
// explanation stays inside the open section.
function ExternalReviewerSection({
  ids,
  startsOpen,
  email,
  name,
  onEmail,
  onName,
  showTwoStep,
  parallel,
  openReview,
  pending,
  onWithdraw,
}: {
  ids: string;
  startsOpen: boolean;
  email: string;
  name: string;
  onEmail: (value: string) => void;
  onName: (value: string) => void;
  showTwoStep: boolean;
  parallel: boolean;
  openReview: { id: string; recipientEmail: string; recipientName: string | null } | null;
  pending: boolean;
  onWithdraw: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(startsOpen);
  const summary = email.trim()
    ? reviewerLabel({ email: email.trim(), name: name.trim() || null })
    : openReview
      ? `Review still open for ${openReview.recipientName ?? openReview.recipientEmail}`
      : null;
  return (
    <div data-external-reviewer="" data-external-reviewer-open={open ? "true" : "false"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${ids}-external-reviewer`}
        onClick={() => setOpen((current) => !current)}
        className="mb-1.5 flex w-full items-center gap-1 rounded text-left text-[13px] font-medium text-zinc-800 hover:text-zinc-950"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0 text-zinc-500" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-zinc-500" aria-hidden />}
        <span>
          Outside reviewer <span className="font-normal text-zinc-500">(optional)</span>
        </span>
        {!open && summary ? <span className="ml-auto min-w-0 truncate text-xs font-normal text-zinc-500">{summary}</span> : null}
      </button>
      {open ? (
        <div id={`${ids}-external-reviewer`}>
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              aria-label="Outside reviewer’s name"
              value={name}
              maxLength={200}
              onChange={(e) => onName(e.currentTarget.value)}
              placeholder="Their name"
              className="field h-9 w-full"
            />
            <input
              type="email"
              aria-label="Outside reviewer’s email"
              value={email}
              onChange={(e) => onEmail(e.currentTarget.value)}
              placeholder="name@example.com"
              className="field h-9 w-full"
            />
          </div>
          <p className="mt-1 text-2xs text-zinc-500">
            Someone outside the team who reviews it by email link, no login: the requester, a facility contact, anyone.
          </p>
          {showTwoStep ? (
            <p className="mt-1 text-2xs text-zinc-600" data-two-step-note="">
              {TWO_STEP_NOTE}
            </p>
          ) : null}
          {openReview ? (
            <p role="note" className="mt-2 flex flex-wrap items-center gap-2 rounded bg-amber-50 px-2 py-1.5 text-2xs text-amber-900">
              <span className="min-w-0 flex-1">
                A review sent to {openReview.recipientName ?? openReview.recipientEmail} is still open.{" "}
                {parallel ? "The next one goes out with the team round." : "With a team approver, the next one goes out only after the approval."}
              </span>
              <button type="button" className="btn-secondary h-6 px-2 text-2xs" disabled={pending} onClick={onWithdraw}>
                Withdraw it
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
