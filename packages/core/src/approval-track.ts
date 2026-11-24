// Nov 24 batch 45: the task card's step track — Work → Team approver → Outside reviewer → Done — as pure
// data, so the pane's pills, the wide view's rail, the review blocks, the setup dialog's live preview, and
// the tests all read one answer. It mirrors the database's rules (20261124010000_nov24_batch45_a.sql):
//   - sequential order (the default): the team approves first, then the outside reviewer gets the email;
//   - parallel order: both review the same round at the same time; changes from either side end the round
//     for both, and the next round goes to both; Done needs both approvals of the same round;
//   - a plain task whose only review is an outside review check: Work → Outside → Done.
// An outside review "belongs" to a team round when it was sent after the round was sent (parallel) or after
// the round was approved (sequential) — approval_external_done() in SQL.

import type { ApprovalRound, ExternalReview, ExternalReviewRound, ReviewOrder, TaskApprovalInfo } from "./api/task-pane/model";
import type { AfterApproval, TaskKind } from "./task-kinds";
import { shiftDays } from "./date-input";

export type TrackRole = "work" | "team" | "outside" | "done";
// done ✓ · current (someone is on it now) · waiting (not started) · locked (outside, sequential: after the
// team) · changes (asked for changes) · rejected.
export type TrackState = "done" | "current" | "waiting" | "locked" | "changes" | "rejected";

export type TrackStep = {
  role: TrackRole;
  // "Work", "Team: Avi", "Team: Avi + Isaiah", "Outside: Sarah", "Done".
  label: string;
  state: TrackState;
  // The assignee (work) or the approvers (team).
  personIds: string[];
  outside: { email: string; name: string | null } | null;
  // The plain-words state for the hover card, the rail, and the block's badge.
  status: string;
  dueOn: string | null;
  sentBy: string | null;
  sentAt: string | null;
  round: number | null;
  // The round before this one, when it ended with changes ("round 1 changes requested Dec 8").
  previous: { number: number; status: "changes_requested" | "rejected" | "withdrawn"; at: string | null } | null;
  // When the automatic reminder goes out (YYYY-MM-DD), or went out (reminderSent).
  reminderOn: string | null;
  reminderSent: boolean;
  decidedAt: string | null;
};

export type ApprovalTrack = {
  kind: "approval" | "outside";
  order: ReviewOrder;
  round: number | null;
  // "Approval · team first, then outside · round 2".
  headline: string;
  steps: TrackStep[];
};

export type TrackTask = {
  kind: TaskKind;
  completedAt: string | null;
  assigneeId: string | null;
  approval: TaskApprovalInfo | null;
  externalReview?: ExternalReview | null;
};

export type TrackOptions = {
  // A person's short name ("Avi W."); "you" handled by the caller if wanted.
  nameOf: (id: string) => string;
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export function outsideName(reviewer: { email: string; name: string | null } | null | undefined): string {
  if (!reviewer) return "Outside reviewer";
  return reviewer.name?.trim() ? firstName(reviewer.name) : reviewer.email.split("@")[0];
}

export function reviewOrderOf(review: ExternalReview | null | undefined): ReviewOrder {
  return review?.plan?.order === "parallel" ? "parallel" : "sequential";
}

// Does this outside review round belong to the team round (see the header)?
export function outsideBelongsToRound(
  check: Pick<ExternalReviewRound, "createdAt"> | null | undefined,
  round: Pick<ApprovalRound, "status" | "sentAt" | "decidedAt"> | null | undefined,
  order: ReviewOrder,
): boolean {
  if (!check || !round) return false;
  if (order === "parallel") return check.createdAt >= round.sentAt;
  return round.status === "approved" && Boolean(round.decidedAt) && check.createdAt >= round.decidedAt!;
}

// The day the outside reviewer's one automatic reminder goes out (review_nudge_due in SQL): the day before
// the due date (never in the first 12 hours after sending), else a day after sending.
export function outsideReminderOn(check: Pick<ExternalReviewRound, "createdAt" | "dueOn">): string {
  const sent = Date.parse(check.createdAt);
  if (check.dueOn) {
    const dayBefore = shiftDays(check.dueOn, -1);
    const earliest = new Date(sent + 12 * 3600_000).toISOString().slice(0, 10);
    return dayBefore > earliest ? dayBefore : earliest;
  }
  return new Date(sent + 24 * 3600_000).toISOString().slice(0, 10);
}

function joinShort(names: string[]): string {
  if (names.length <= 2) return names.join(" + ");
  return `${names.slice(0, 2).join(" + ")} +${names.length - 2}`;
}

function previousOf(rounds: ApprovalRound[]): TrackStep["previous"] {
  const before = rounds[1];
  if (!before) return null;
  if (before.status === "changes_requested" || before.status === "rejected") {
    return { number: before.number, status: before.status, at: before.decidedAt };
  }
  if (before.status === "withdrawn") return { number: before.number, status: "withdrawn", at: before.withdrawnAt };
  return null;
}

function step(role: TrackRole, label: string, state: TrackState, status: string, extra: Partial<TrackStep> = {}): TrackStep {
  return {
    role,
    label,
    state,
    status,
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

function outsideStepFromCheck(
  check: ExternalReviewRound,
  reviewer: { email: string; name: string | null },
  name: string,
  dueOn: string | null,
): TrackStep {
  const state: TrackState =
    check.status === "approved" ? "done" : check.status === "changes_requested" ? "changes" : check.status === "pending" ? "current" : "waiting";
  const status =
    check.status === "approved"
      ? `${name} approved`
      : check.status === "changes_requested"
        ? `${name} asked for changes`
        : check.status === "pending"
          ? check.emailStatus === "failed"
            ? "The email didn’t go out"
            : "Reviewing now"
          : check.closedReason === "team_changes"
            ? "Round ended: the team asked for changes"
            : check.closedReason === "team_rejected"
              ? "Round ended: the team rejected it"
              : check.status === "cancelled"
              ? "Withdrawn"
              : "Replaced by a newer round";
  return step("outside", `Outside: ${name}`, state, status, {
    outside: reviewer,
    dueOn: check.dueOn ?? dueOn,
    sentBy: check.createdBy ?? null,
    sentAt: check.createdAt,
    round: check.round,
    reminderOn: check.status === "pending" ? (check.nudgedAt ? check.nudgedAt.slice(0, 10) : outsideReminderOn({ createdAt: check.createdAt, dueOn: check.dueOn ?? dueOn })) : null,
    reminderSent: Boolean(check.nudgedAt),
    decidedAt: check.decidedAt,
  });
}

// The track of a task, or null when it has none (a plain task without an outside review, a milestone).
export function approvalTrack(task: TrackTask, { nameOf }: TrackOptions): ApprovalTrack | null {
  const review = task.externalReview ?? null;
  const check = review?.latest ?? null;
  const completed = Boolean(task.completedAt);
  const assignee = task.assigneeId ? [task.assigneeId] : [];

  // A plain task (not an approval) with an outside review check: Work → Outside → Done.
  if (task.kind !== "approval") {
    if (!check || task.kind === "milestone") return null;
    const reviewer = { email: check.recipientEmail, name: check.recipientName };
    const name = outsideName(reviewer);
    const outside = outsideStepFromCheck(check, reviewer, name, review?.plan?.dueOn ?? null);
    const workBack = check.status === "changes_requested" && !completed;
    return {
      kind: "outside",
      order: "sequential",
      round: check.round,
      headline: `Outside review · round ${check.round}`,
      steps: [
        step("work", "Work", workBack ? "current" : "done", workBack ? "Back with the assignee for changes" : "Sent for review", {
          personIds: assignee,
          sentAt: check.createdAt,
        }),
        outside,
        step("done", "Done", completed || check.status === "approved" ? "done" : "waiting", completed ? "Completed" : check.status === "approved" ? "Approved" : "After the outside reviewer approves"),
      ],
    };
  }

  const info = task.approval;
  const approverIds = info?.approverIds ?? [];
  const rounds = info?.rounds ?? [];
  const latest = rounds[0] ?? null;
  const order = reviewOrderOf(review);
  const reviewer = review?.reviewer ?? null;
  const hasOutside = approverIds.length > 0 && Boolean(reviewer);

  // Team.
  const teamNames = approverIds.map((id) => firstName(nameOf(id)));
  const teamLabel = approverIds.length ? `Team: ${joinShort(teamNames)}` : "Team: not set";
  let teamState: TrackState = "waiting";
  let teamStatus = approverIds.length ? "Not sent yet" : "Choose who approves it";
  if (latest) {
    if (latest.status === "pending") {
      teamState = "current";
      const waiting = latest.requests.filter((r) => r.status === "pending").map((r) => firstName(nameOf(r.approverId)));
      teamStatus = waiting.length ? `Waiting on ${waiting.join(latest.mode === "all" ? " and " : " or ")}` : "Waiting for approval";
    } else if (latest.status === "approved") {
      teamState = "done";
      teamStatus = "Approved";
    } else if (latest.status === "changes_requested") {
      teamState = "changes";
      teamStatus = "Asked for changes";
    } else if (latest.status === "rejected") {
      teamState = "rejected";
      teamStatus = "Rejected";
    } else {
      teamState = "waiting";
      teamStatus = latest.closedReason === "outside_changes" ? "Round ended: the outside reviewer asked for changes" : "Withdrawn";
    }
  }
  const teamDue = latest?.status === "pending" ? (latest.dueOn ?? info?.dueOn ?? null) : (info?.dueOn ?? null);
  const remindersOn = info?.followUp?.reminders !== false;
  const team = step("team", teamLabel, teamState, teamStatus, {
    personIds: approverIds,
    dueOn: teamDue,
    sentBy: latest?.sentBy ?? null,
    sentAt: latest?.sentAt ?? null,
    round: latest?.number ?? null,
    previous: previousOf(rounds),
    reminderOn: latest?.status === "pending" && remindersOn && teamDue ? shiftDays(teamDue, -1) : null,
    decidedAt: latest?.decidedAt ?? null,
  });

  // Outside.
  let outside: TrackStep | null = null;
  let outsideDone = false;
  if (hasOutside && reviewer) {
    const name = outsideName(reviewer);
    const dueOn = review?.plan?.dueOn ?? null;
    const belongs = outsideBelongsToRound(check, latest, order);
    if (belongs && check) {
      outside = outsideStepFromCheck(check, reviewer, name, dueOn);
      outsideDone = check.status === "approved";
    } else if (order === "sequential" && latest?.status !== "approved") {
      outside = step("outside", `Outside: ${name}`, "locked", "Up next, after the team approves", { outside: reviewer, dueOn });
    } else if (order === "sequential") {
      outside = step("outside", `Outside: ${name}`, "current", `Ready to send to ${name}`, { outside: reviewer, dueOn });
    } else {
      // Parallel: normally it goes out with the team round. If it didn't (skipped at send time), it can be
      // sent while that round is open, and still once the team approved it (then the outside approval is
      // the last stage).
      const sendable = latest?.status === "pending" || latest?.status === "approved";
      outside = step(
        "outside",
        `Outside: ${name}`,
        sendable ? "current" : "waiting",
        sendable ? "Not sent yet" : "Goes out with the team round",
        { outside: reviewer, dueOn },
      );
    }
  }

  // Work: back with the assignee whenever a round isn't open or approved (not sent, withdrawn, changes).
  const outsideChanges = outside?.state === "changes";
  let workState: TrackState = "current";
  let workStatus = approverIds.length ? "Working on it" : "Approval setup not finished";
  if (completed) {
    workState = "done";
    workStatus = "Done";
  } else if (latest && (latest.status === "pending" || latest.status === "approved") && !outsideChanges) {
    workState = "done";
    workStatus = "Sent for approval";
  } else if (latest?.status === "changes_requested" || latest?.status === "rejected" || outsideChanges) {
    workStatus = info?.paused ? "Paused: feedback to read" : "Back with the assignee for changes";
  } else if (latest?.status === "withdrawn") {
    workStatus = latest.closedReason === "outside_changes" ? "Back with the assignee for changes" : "Withdrawn: send it again when ready";
  }
  const work = step("work", "Work", workState, workStatus, {
    personIds: assignee,
    sentAt: latest?.sentAt ?? null,
    previous: previousOf(rounds),
    round: latest?.number ?? null,
  });

  const allApproved = latest?.status === "approved" && (!outside || outsideDone);
  const done = step(
    "done",
    "Done",
    completed || allApproved ? "done" : "waiting",
    completed ? "Completed" : allApproved ? "Approved" : hasOutside ? (order === "parallel" ? "When both approve" : "After the outside reviewer approves") : "After approval",
    { dueOn: null },
  );

  const orderWords = !outside ? "team only" : order === "parallel" ? "team and outside at the same time" : "team first, then outside";
  return {
    kind: "approval",
    order,
    round: latest?.number ?? null,
    headline: `Approval · ${orderWords}${latest ? ` · round ${latest.number}` : ""}`,
    steps: outside ? [work, team, outside, done] : [work, team, done],
  };
}

// The step(s) someone is on now: the first one that isn't done (in the parallel order, the team and the
// outside reviewer together).
export function currentRoles(track: ApprovalTrack): TrackRole[] {
  const open = track.steps.filter((s) => s.state !== "done" && s.role !== "done");
  if (!open.length) return [];
  if (track.order === "parallel" && (open[0].role === "team" || open[0].role === "outside")) {
    return open.filter((s) => s.role === "team" || s.role === "outside").map((s) => s.role);
  }
  return [open[0].role];
}

const NUMBER_WORDS = ["", "one", "both", "all three", "all four", "all five", "all six", "all seven", "all eight", "all nine", "all ten"];

function joinAnd(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function joinOr(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

export type PlanSummaryInput = {
  approverNames: string[];
  mode: "any" | "all";
  reviewerName: string | null;
  order: ReviewOrder;
  after: AfterApproval | null;
  sectionName: string | null;
  // The round the next send opens (2 → "round 2"); default 2.
  nextRound?: number;
};

function afterWords(after: AfterApproval | null, sectionName: string | null): string {
  if (after === "move_section") return `it moves to ${sectionName ?? "the chosen section"}`;
  if (after === "notify") return "the assignee is told";
  return "it’s completed";
}

// The setup dialog's plain-English summary: a one-line flow ("Work, then Team and Outside review at the same
// time, then Done") and a sentence of what happens.
export function approvalPlanSummary(input: PlanSummaryInput): { flow: string; sentence: string } {
  const team = input.approverNames.filter(Boolean);
  const outside = input.reviewerName?.trim() || null;
  const next = input.nextRound ?? 2;
  if (!team.length) {
    return {
      flow: outside ? "Work, then Outside review, then Done" : "Work, then Done",
      sentence: "Choose who on the team approves it.",
    };
  }
  const then = afterWords(input.after, input.sectionName);
  const teamDecides =
    team.length === 1 ? `${team[0]} approves it` : input.mode === "all" ? `${joinAnd(team)} ${team.length === 2 ? "both" : "all"} approve it` : `${joinOr(team)} approves it`;
  const teamYes = team.length === 1 ? team[0] : input.mode === "all" ? NUMBER_WORDS[Math.min(team.length, 10)] ?? "everyone" : "one of them";
  if (!outside) {
    return {
      flow: "Work, then Team review, then Done",
      sentence: `${teamDecides}. When ${teamYes} ${team.length === 1 || input.mode === "any" ? "says" : "say"} yes, ${then}. If changes are asked for, round ${next} goes back to them.`,
    };
  }
  if (input.order === "parallel") {
    const everyone = input.mode === "all" ? team.length + 1 : 2;
    const yes = input.mode === "all" ? NUMBER_WORDS[Math.min(everyone, 10)] : `${team.length === 1 ? team[0] : "the team"} and ${outside}`;
    return {
      flow: "Work, then Team and Outside review at the same time, then Done",
      sentence: `${teamDecides} while ${outside} reviews by email. When ${yes} say yes, ${then}. If anyone asks for changes, round ${next} goes to ${input.mode === "all" ? NUMBER_WORDS[Math.min(everyone, 10)] : "both"}.`,
    };
  }
  return {
    flow: "Work, then Team review, then Outside review, then Done",
    sentence: `${teamDecides} first, then ${outside} reviews it by email. When ${outside} says yes too, ${then}. If anyone asks for changes, it comes back for round ${next}.`,
  };
}
