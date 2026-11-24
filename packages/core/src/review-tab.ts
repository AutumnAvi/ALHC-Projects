// Nov 24 batch 45: the task card's Review tab (docs/design/task-card/png/06-review-tab.png) as pure data —
// which files the tab shows, each file's status for each reviewer (the blue team approver chip, the amber
// outside reviewer chip), the comments on one file, and the team's and the outside reviewer's rounds
// merged newest first. The tab draws it; the tests pin it.
//
// Sources: the team's approval rounds (TaskApprovalInfo.rounds; each approver's per-file decision note is
// the "✓ / ✗ name: note" lines approverDecisionNote() writes) and the outside reviewer's review checks
// (TaskReviewRound: the round's files as assets, the reviewer's pins on them). An outside round answered
// with changes says which files have pins; a file without a pin in such a round is "answered" (its own
// note, if any, isn't in this data).

import type { ApprovalRound, TaskApproval, TaskAttachment } from "./api/task-pane/model";
import type { ReviewPin, TaskReviewRound } from "./review-checks";
import type { TrackState } from "./approval-track";
import { parseDecisionNote } from "./approval-feedback";

export type ReviewTabFile = {
  attachmentId: string;
  name: string;
  contentType: string | null;
  size: number | null;
  // The asset of the latest outside round that shows this file (pins point at it), else null.
  outsideAssetId: string | null;
  outsideRoundId: string | null;
};

// The files the tab shows: the latest team round's files (the task's attachments still there), else the
// latest outside round's. Each is linked to the latest outside round that holds the same attachment.
export function reviewTabFiles(
  teamRounds: readonly Pick<ApprovalRound, "attachmentIds">[],
  outsideRounds: readonly Pick<TaskReviewRound, "id" | "assets">[],
  attachments: readonly Pick<TaskAttachment, "id" | "fileName" | "contentType" | "sizeBytes">[],
): ReviewTabFile[] {
  const outsideFor = (attachmentId: string) => {
    for (const round of outsideRounds) {
      const asset = round.assets.find((a) => a.attachmentId === attachmentId);
      if (asset) return { outsideAssetId: asset.id, outsideRoundId: round.id };
    }
    return { outsideAssetId: null, outsideRoundId: null };
  };
  const team = teamRounds.find((r) => r.attachmentIds.length > 0);
  if (team) {
    const byId = new Map(attachments.map((a) => [a.id, a] as const));
    const files = team.attachmentIds.flatMap((id) => {
      const a = byId.get(id);
      return a ? [{ attachmentId: a.id, name: a.fileName, contentType: a.contentType, size: a.sizeBytes, ...outsideFor(a.id) }] : [];
    });
    if (files.length) return files;
  }
  const outside = outsideRounds.find((r) => r.assets.length > 0);
  if (!outside) return [];
  return outside.assets.map((a) => ({
    attachmentId: a.attachmentId,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    outsideAssetId: a.id,
    outsideRoundId: outside.id,
  }));
}

// A reviewer's state on one file: approved ✓ · feedback (asked for changes on it) · pending (their round is
// open) · locked (the outside reviewer waits for the team, sequential order) · waiting (not sent to them
// for this file yet) · answered (answered with changes, but nothing pinned on this file).
export type FileChip = "approved" | "feedback" | "pending" | "locked" | "waiting" | "answered";

// The team's chip for a file: the latest team round that holds it.
export function teamFileChip(
  rounds: readonly Pick<ApprovalRound, "status" | "attachmentIds" | "requests">[],
  file: { attachmentId: string; name: string },
  roundFileNames: (round: Pick<ApprovalRound, "attachmentIds">) => string[],
): FileChip {
  const round = rounds.find((r) => r.attachmentIds.includes(file.attachmentId)) ?? rounds[0] ?? null;
  if (!round) return "waiting";
  if (round.status === "pending") return "pending";
  if (round.status === "withdrawn") return "waiting";
  const names = roundFileNames(round);
  let sawLine = false;
  let feedback = false;
  let approved = false;
  for (const request of round.requests) {
    if (request.status !== "approved" && request.status !== "changes_requested" && request.status !== "rejected") continue;
    const line = request.decisionNote ? parseDecisionNote(request.decisionNote, names).files.find((f) => f.name === file.name) : undefined;
    if (line) {
      sawLine = true;
      if (line.approved) approved = true;
      else feedback = true;
    }
  }
  if (feedback) return "feedback";
  if (sawLine && approved) return "approved";
  if (round.status === "approved") return "approved";
  return "feedback";
}

// The outside reviewer's chip for a file, given the outside step's state on the track.
export function outsideFileChip(
  rounds: readonly Pick<TaskReviewRound, "id" | "status" | "assets" | "pins">[],
  file: { attachmentId: string },
  stepState: TrackState | null,
): FileChip | null {
  if (stepState === null) return null;
  if (stepState === "locked") return "locked";
  const round = rounds.find((r) => r.assets.some((a) => a.attachmentId === file.attachmentId));
  if (!round) return "waiting";
  if (round.status === "pending") return "pending";
  if (round.status === "approved") return "approved";
  if (round.status === "changes_requested") {
    const asset = round.assets.find((a) => a.attachmentId === file.attachmentId);
    return asset && round.pins.some((p) => p.assetId === asset.id) ? "feedback" : "answered";
  }
  return "waiting";
}

export type FileComment = {
  key: string;
  role: "team" | "outside";
  // Team notes are numbered 1, 2, 3 on this file (oldest first); outside pins keep their own numbers.
  number: number;
  authorId: string | null;
  authorName: string;
  round: number;
  text: string;
  pin: Pick<ReviewPin, "page" | "x" | "y" | "time"> | null;
};

// The comments on one file: every team approver's note on it (each decided round, oldest first) and the
// outside reviewer's pins on it (each round, oldest first).
export function fileComments(
  file: { attachmentId: string; name: string },
  teamRounds: readonly Pick<ApprovalRound, "number" | "attachmentIds" | "requests">[],
  outsideRounds: readonly Pick<TaskReviewRound, "id" | "round" | "assets" | "pins" | "recipientName" | "recipientEmail">[],
  options: { nameOf: (id: string) => string; roundFileNames: (round: Pick<ApprovalRound, "attachmentIds">) => string[] },
): FileComment[] {
  const team: FileComment[] = [];
  for (const round of [...teamRounds].sort((a, b) => a.number - b.number)) {
    if (!round.attachmentIds.includes(file.attachmentId)) continue;
    const names = options.roundFileNames(round);
    const decided = round.requests
      .filter((r): r is TaskApproval => r.status === "approved" || r.status === "changes_requested" || r.status === "rejected")
      .sort((a, b) => (a.decidedAt ?? "").localeCompare(b.decidedAt ?? ""));
    for (const request of decided) {
      const line = request.decisionNote ? parseDecisionNote(request.decisionNote, names).files.find((f) => f.name === file.name) : undefined;
      if (!line || line.approved || !line.text.trim()) continue;
      team.push({
        key: `team:${request.id}`,
        role: "team",
        number: team.length + 1,
        authorId: request.approverId,
        authorName: options.nameOf(request.approverId),
        round: round.number,
        text: line.text.trim(),
        pin: null,
      });
    }
  }
  const outside: FileComment[] = [];
  for (const round of [...outsideRounds].sort((a, b) => a.round - b.round)) {
    const asset = round.assets.find((a) => a.attachmentId === file.attachmentId);
    if (!asset) continue;
    const reviewer = round.recipientName?.trim() || round.recipientEmail;
    for (const pin of round.pins.filter((p) => p.assetId === asset.id)) {
      outside.push({
        key: `outside:${round.id}:${pin.number}`,
        role: "outside",
        number: pin.number,
        authorId: null,
        authorName: reviewer,
        round: round.round,
        text: pin.body,
        pin: { page: pin.page, x: pin.x, y: pin.y, time: pin.time },
      });
    }
  }
  return [...team, ...outside];
}

export type RoundTone = "blue" | "amber" | "green" | "red" | "grey";

export type MergedRound = {
  key: string;
  role: "team" | "outside";
  number: number;
  sentAt: string;
  sentBy: string | null;
  fileCount: number;
  // "Waiting on Avi", "Changes requested by Avi", "Approved by Sarah", …
  status: string;
  tone: RoundTone;
  // The round being decided now (a filled chip).
  open: boolean;
};

function joinNames(names: string[], word: "and" | "or"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${word} ${names[names.length - 1]}`;
}

// The team's rounds and the outside reviewer's rounds in one list, newest first.
export function mergeReviewRounds(
  teamRounds: readonly ApprovalRound[],
  outsideRounds: readonly Pick<TaskReviewRound, "id" | "round" | "status" | "createdAt" | "senderId" | "assets" | "recipientName" | "recipientEmail">[],
  nameOf: (id: string) => string,
): MergedRound[] {
  const first = (name: string) => name.trim().split(/\s+/)[0] || name;
  const team: MergedRound[] = teamRounds.map((r) => {
    const by = (status: TaskApproval["status"]) => r.requests.filter((q) => q.status === status).map((q) => first(nameOf(q.approverId)));
    let status: string;
    let tone: RoundTone;
    if (r.status === "pending") {
      const waiting = by("pending");
      status = waiting.length ? `Waiting on ${joinNames(waiting, r.mode === "all" ? "and" : "or")}` : "Waiting for approval";
      tone = "blue";
    } else if (r.status === "approved") {
      const who = by("approved");
      status = who.length ? `Approved by ${joinNames(who, "and")}` : "Approved";
      tone = "green";
    } else if (r.status === "changes_requested") {
      const who = by("changes_requested");
      status = who.length ? `Changes requested by ${joinNames(who, "and")}` : "Changes requested";
      tone = "amber";
    } else if (r.status === "rejected") {
      const who = by("rejected");
      status = who.length ? `Rejected by ${joinNames(who, "and")}` : "Rejected";
      tone = "red";
    } else {
      status = r.closedReason === "outside_changes" ? "Ended: outside reviewer asked for changes" : "Withdrawn";
      tone = "grey";
    }
    return {
      key: `team:${r.id}`,
      role: "team",
      number: r.number,
      sentAt: r.sentAt,
      sentBy: r.sentBy,
      fileCount: r.attachmentIds.length,
      status,
      tone,
      open: r.status === "pending",
    };
  });
  const outside: MergedRound[] = outsideRounds.map((r) => {
    const reviewer = first(r.recipientName?.trim() || r.recipientEmail.split("@")[0]);
    const status =
      r.status === "pending"
        ? `Waiting on ${reviewer}`
        : r.status === "approved"
          ? `Approved by ${reviewer}`
          : r.status === "changes_requested"
            ? `Changes requested by ${reviewer}`
            : r.status === "superseded"
              ? "Replaced by a newer round"
              : "Withdrawn";
    const tone: RoundTone = r.status === "pending" ? "amber" : r.status === "approved" ? "green" : r.status === "changes_requested" ? "amber" : "grey";
    return {
      key: `outside:${r.id}`,
      role: "outside",
      number: r.round,
      sentAt: r.createdAt,
      sentBy: r.senderId,
      fileCount: r.assets.length,
      status,
      tone,
      open: r.status === "pending",
    };
  });
  return [...team, ...outside].sort((a, b) => b.sentAt.localeCompare(a.sentAt) || (a.role === "team" ? -1 : 1));
}

// The next / previous file index for ← / →, wrapping.
export function stepFile(index: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}
