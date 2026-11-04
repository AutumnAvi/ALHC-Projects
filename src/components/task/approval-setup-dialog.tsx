"use client";

import { useId, useState } from "react";
import { CalendarDays, ChevronDown, ChevronRight, X } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { displayName } from "@/lib/people";
import { Dialog } from "@/components/dialog";
import { Popover } from "@/components/popover";
import { SmartPicker } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import { setApprovalFollowUp, setTaskApprovers } from "@/lib/actions";
import {
  FOLLOW_UP_LABELS,
  approvalSetupProblem,
  approvalSetupSummary,
  defaultApprovalSetup,
  type ApprovalFollowUp,
  type ApprovalSetupDraft,
} from "@/lib/approval-setup";
import type { Profile } from "@/lib/api/people/model";
import type { TaskDetail } from "@/lib/api/task-pane/model";
import { formatDueDate } from "@/lib/dates";
import { hasRole } from "@/lib/roles";
import { SingleDatePicker } from "./date-picker";
import { PeopleList } from "./person-picker";

// Nov 1 notes, batch 9a (Avi's decision b): "by default it should be easy: choose an approver, they
// approve it, and then a follow-up step decision." Two short steps, the rest behind More options, and
// Skip for now (the approval banner offers Finish setup later). Opens when a person makes a task an
// approval task (the pane's Task type, Add approval in a List / Board) and from the banner.
export function ApprovalSetupDialog({
  task,
  profiles,
  onClose,
  ready,
}: {
  task: TaskDetail;
  profiles: Profile[];
  onClose: () => void;
  // Nov 2 notes (batch 15, 112): opened while the task type is still being saved; saving waits for it.
  ready?: Promise<{ error?: string }> | null;
}) {
  const ids = useId();
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const info = task.approval;
  const [step, setStep] = useState<0 | 1>(0);
  const [tried, setTried] = useState(false);
  const [more, setMore] = useState(false);
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
  const problem = approvalSetupProblem(step === 0 ? "approvers" : "after", draft);

  function toggle(id: string) {
    patch({
      approverIds: draft.approverIds.includes(id) ? draft.approverIds.filter((a) => a !== id) : [...draft.approverIds, id],
    });
  }

  function next() {
    setTried(true);
    if (problem) return;
    setTried(false);
    setStep(1);
  }

  function finish() {
    setTried(true);
    if (approvalSetupProblem("approvers", draft)) {
      setStep(0);
      return;
    }
    if (problem) return;
    run(async () => {
      if (ready) {
        const made = await ready;
        if (made.error) return made;
      }
      const approvers = await setTaskApprovers(task.id, { approverIds: draft.approverIds, mode: draft.mode, dueOn: draft.dueOn });
      if (approvers.error) return approvers;
      const followUp = await setApprovalFollowUp(task.id, {
        followUp: draft.followUp,
        sectionId: draft.sectionId,
        reminders: draft.reminders,
      });
      if (!followUp.error) {
        notify(`Approval set up. ${approvalSetupSummary(draft, names, sectionName)}`);
        onClose();
      }
      return followUp;
    });
  }

  return (
    <Dialog
      title="Set up this approval"
      description={`Step ${step + 1} of 2 · ${step === 0 ? "Who approves it?" : "What happens after it’s approved?"}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4" data-approval-setup={step === 0 ? "approvers" : "after"}>
        {step === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-zinc-600">
              Pick the people who approve it. The assignee does the work, then sends it to them.
            </p>
            {draft.approverIds.length ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Chosen approvers">
                {draft.approverIds.map((id, i) => (
                  <li
                    key={id}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white py-0.5 pr-1 pl-0.5 text-xs text-zinc-800"
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
              </ul>
            ) : null}
            <div className="rounded-md border border-zinc-200">
              <PeopleList
                label="Approvers"
                people={eligible}
                selected={draft.approverIds}
                emptyNote="Approvers need at least Commenter access to this task’s project."
                onPick={toggle}
              />
            </div>
          </div>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm text-zinc-600">When it’s approved:</legend>
            {(Object.keys(FOLLOW_UP_LABELS) as ApprovalFollowUp[]).map((key) => {
              const disabled = key === "move_section" && sectionOptions.length === 0;
              return (
                <label
                  key={key}
                  className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                    draft.followUp === key ? "border-accent-400 bg-accent-50/50" : "border-zinc-200"
                  } ${disabled ? "text-zinc-400" : "text-zinc-800"}`}
                >
                  <input
                    type="radio"
                    name={`${ids}-after`}
                    checked={draft.followUp === key}
                    disabled={disabled}
                    onChange={() => patch({ followUp: key })}
                    className="mt-0.5 size-3.5 accent-accent-600"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{FOLLOW_UP_LABELS[key].label}</span>
                    <span className="block text-xs text-zinc-500">
                      {disabled ? (task.isSubtask ? "Subtasks aren’t in sections." : "You can’t move it in any of its projects.") : FOLLOW_UP_LABELS[key].hint}
                    </span>
                    {key === "move_section" && draft.followUp === "move_section" ? (
                      <SmartPicker
                        label="Section"
                        placeholder="Choose section"
                        className="mt-1.5 w-full"
                        options={sectionOptions}
                        value={draft.sectionId}
                        onChange={(value) => patch({ sectionId: value })}
                      />
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}

        {step === 1 ? (
          <div className="border-t border-zinc-100 pt-3">
            <button
              type="button"
              aria-expanded={more}
              aria-controls={`${ids}-more`}
              onClick={() => setMore((open) => !open)}
              className="inline-flex items-center gap-1 text-sm font-medium text-zinc-700 hover:text-zinc-900"
            >
              {more ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
              More options
            </button>
            {more ? (
              <div id={`${ids}-more`} className="mt-2 flex flex-col gap-3 pl-5">
                {draft.approverIds.length > 1 ? (
                  <fieldset className="flex flex-col gap-1 text-sm text-zinc-800">
                    <legend className="mb-1 text-xs font-medium text-zinc-600">How they decide</legend>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`${ids}-mode`}
                        checked={draft.mode === "any"}
                        onChange={() => patch({ mode: "any" })}
                        className="size-3.5 accent-accent-600"
                      />
                      Any one can approve
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`${ids}-mode`}
                        checked={draft.mode === "all"}
                        onChange={() => patch({ mode: "all" })}
                        className="size-3.5 accent-accent-600"
                      />
                      Everyone must approve
                    </label>
                  </fieldset>
                ) : null}
                <div className="flex items-center gap-2 text-sm text-zinc-800">
                  <span className="text-xs font-medium text-zinc-600">Approval due</span>
                  <Popover
                    label="Approval due date"
                    panelClassName="w-72 p-0"
                    buttonClassName="btn-secondary h-7 px-2 text-xs"
                    button={
                      <>
                        <CalendarDays className="size-3.5" aria-hidden />
                        {draft.dueOn ? formatDueDate(draft.dueOn) : "No due date"}
                      </>
                    }
                  >
                    {(close) => (
                      <SingleDatePicker
                        label="Approval due"
                        value={draft.dueOn}
                        onChange={(value) => {
                          close();
                          patch({ dueOn: value });
                        }}
                      />
                    )}
                  </Popover>
                </div>
                <label className="flex items-start gap-2 text-sm text-zinc-800">
                  <input
                    type="checkbox"
                    checked={draft.reminders}
                    onChange={(e) => patch({ reminders: e.currentTarget.checked })}
                    className="mt-0.5 size-3.5 accent-accent-600"
                  />
                  <span>
                    Remind approvers
                    <span className="block text-xs text-zinc-500">The day before the approval due date, and once it’s overdue.</span>
                  </span>
                </label>
              </div>
            ) : null}
          </div>
        ) : null}

        <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600" aria-live="polite">
          {approvalSetupSummary(draft, names, sectionName)} Only its approvers can complete it.
        </p>
        {tried && problem ? (
          <p role="alert" className="text-sm text-red-700">
            {problem}
          </p>
        ) : null}

        <div className="flex items-center gap-2 border-t border-zinc-100 pt-3">
          <button type="button" onClick={onClose} className="btn-ghost mr-auto text-zinc-500" data-approval-setup-skip="">
            Skip for now
          </button>
          {step === 1 ? (
            <button type="button" onClick={() => setStep(0)} className="btn-secondary">
              Back
            </button>
          ) : null}
          {step === 0 ? (
            <button type="button" onClick={next} className="btn-primary">
              Next
            </button>
          ) : (
            <button type="button" onClick={finish} disabled={pending} className="btn-primary">
              {pending ? "Saving…" : "Done"}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
