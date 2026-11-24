// Nov 24 batch 45: the approval setup's live preview (docs/design/task-card/png/08-approval-setup.png). The
// plan as it stands in the form — who approves, how, the outside reviewer, the order, what happens at the
// end — turned into the same TrackStep[] the task card's track draws, so the preview and the card read
// alike: "Work → Team: Avi + Isaiah · both → Outside: Sarah · due Dec 15 → Done → Ready to publish" (in
// the parallel order the team and the outside reviewer share a column). Pure and dependency-free (tested).

import type { ReviewOrder } from "./api/task-pane/model";
import { outsideName, type TrackStep } from "./approval-track";
import { dayLabel } from "./date-input";
import type { AfterApproval } from "./task-kinds";

export type PlanInput = {
  assigneeId: string | null;
  approverIds: string[];
  // Shown names, same order as approverIds.
  approverNames: string[];
  mode: "any" | "all";
  // Null when no outside reviewer is named (or nobody approves on the team: the outside review then
  // isn't part of an approval's plan).
  reviewer: { email: string; name: string | null } | null;
  reviewerDueOn: string | null;
  order: ReviewOrder;
  after: AfterApproval;
  sectionName: string | null;
  approvalDueOn: string | null;
};

export type PlanTrack = { order: ReviewOrder; steps: TrackStep[] };

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

function shortDay(value: string): string {
  return dayLabel(value, Number(value.slice(0, 4)));
}

function planStep(role: TrackStep["role"], label: string, extra: Partial<TrackStep> = {}): TrackStep {
  return {
    role,
    label,
    state: "waiting",
    status: "",
    personIds: [],
    outside: null,
    dueOn: null,
    sentBy: null,
    sentAt: null,
    round: null,
    previous: null,
    reminderOn: null,
    reminderSent: false,
    decidedAt: null,
    ...extra,
  };
}

// "Team: Avi + Isaiah · both", "Team: Avi + Isaiah · any one", "Team: Avi, Isaiah +1 · all".
export function planTeamLabel(names: string[], mode: "any" | "all"): string {
  if (!names.length) return "Team: not set";
  const first = names.map(firstName);
  const who = first.length <= 2 ? first.join(" + ") : `${first.slice(0, 2).join(" + ")} +${first.length - 2}`;
  if (first.length === 1) return `Team: ${who}`;
  return `Team: ${who} · ${mode === "all" ? (first.length === 2 ? "both" : "all") : "any one"}`;
}

// "Done → Ready to publish" / "Done" / "Done · notify".
export function planDoneLabel(after: AfterApproval, sectionName: string | null): string {
  if (after === "move_section") return sectionName ? `Done → ${sectionName}` : "Done → a section";
  if (after === "notify") return "Done · notify";
  return "Done";
}

export function planTrack(input: PlanInput): PlanTrack {
  const hasOutside = input.approverIds.length > 0 && Boolean(input.reviewer);
  const steps: TrackStep[] = [
    planStep("work", "Work", { personIds: input.assigneeId ? [input.assigneeId] : [] }),
    planStep("team", planTeamLabel(input.approverNames, input.mode), {
      personIds: input.approverIds,
      dueOn: input.approvalDueOn,
    }),
  ];
  if (hasOutside && input.reviewer) {
    const name = outsideName(input.reviewer);
    steps.push(
      planStep("outside", `Outside: ${name}${input.reviewerDueOn ? ` · due ${shortDay(input.reviewerDueOn)}` : ""}`, {
        outside: input.reviewer,
        dueOn: input.reviewerDueOn,
      }),
    );
  }
  steps.push(planStep("done", planDoneLabel(input.after, input.sectionName)));
  return { order: hasOutside ? input.order : "sequential", steps };
}
