"use client";

// Nov 24 batch 45: the task card's Review tab (docs/design/task-card/png/06-review-tab.png). A focused view of
// the review: the selected file large, with the outside reviewer's pins in amber; a strip of the round's files
// with each reviewer's status on each file (blue = Team approver, amber = Outside reviewer); the viewer's card
// (a pending team approver reviews file by file here, through the same per-file review as the task card); the
// comments on the file; and every round, the team's and the outside reviewer's, newest first. Two columns when
// the pane is wide, stacked in the side pane and on phones. ← / → move between files.

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Check, CircleDot, Clock, FileText, Lock, MessageSquare, Send } from "lucide-react";
import { approvalTrack, type TrackStep } from "@alhc/core/approval-track";
import { approverReviewFiles } from "@alhc/core/approver-review";
import type { Profile } from "@alhc/core/api/people/model";
import type { ApprovalRound, TaskDetail } from "@alhc/core/api/task-pane/model";
import { displayName } from "@alhc/core/people";
import { taskPermissions } from "@alhc/core/permissions";
import { reviewMediaKind, type TaskReviewRound } from "@alhc/core/review-checks";
import {
  fileComments,
  mergeReviewRounds,
  outsideFileChip,
  reviewTabFiles,
  stepFile,
  teamFileChip,
  type FileChip,
  type MergedRound,
  type ReviewTabFile,
} from "@alhc/core/review-tab";
import { ReviewViewer, type ViewerPin } from "@/components/review/review-viewer";
import { isTypingTarget } from "@/components/shortcuts/keyboard";
import { TalkButton, DictationInterim } from "@/components/dictation-button";
import { textareaTarget, useDictation } from "@/lib/dictation";
import { useServerAction } from "@/components/toast";
import { addComment } from "@/lib/actions/comments";
import { loadTaskReviews } from "@/lib/actions/reviews";
import { formatDueDate } from "@/lib/dates";
import { addPendingComment, dropPendingComment, settlePendingComment } from "./pending-comments-store";
import { ApproverReview } from "./approver-review";
import { RoleTag, weekdayDate } from "./approval-track";
import { reviewsReloaded, useReviewEvents } from "./review-events";
import { Avatar } from "@/components/avatar";

const noop = () => () => {};

// "Dec 9" in the viewer's zone (drawn only in the browser, so the server render never disagrees).
function LocalDay({ iso }: { iso: string }) {
  const ready = useSyncExternalStore(noop, () => true, () => false);
  if (!ready) return <time dateTime={iso} />;
  return <time dateTime={iso}>{new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

function fileCountWords(n: number): string {
  return n === 1 ? "the file" : n === 2 ? "both files" : `all ${n} files`;
}

export function TaskReviewTab({ task, profiles, memberId }: { task: TaskDetail; profiles: Profile[]; memberId: string }) {
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const nameOf = (id: string) => {
    const p = profilesById.get(id);
    return p ? displayName(p) : "Someone";
  };
  const track = approvalTrack(task, { nameOf });
  const teamStep = track?.steps.find((s) => s.role === "team") ?? null;
  const outsideStep = track?.steps.find((s) => s.role === "outside") ?? null;
  const teamRounds = task.approval?.rounds ?? [];
  const latest = teamRounds[0] ?? null;
  const hasOutside = Boolean(outsideStep || task.externalReview?.latest);

  // The outside reviewer's rounds (files, pins), as the Reviews tab reads them; reloaded after a review is
  // sent, sent again, or withdrawn in this browser (review-events.ts), and when the task changes.
  const [rounds, setRounds] = useState<TaskReviewRound[] | null | undefined>(hasOutside ? undefined : []);
  const { version } = useReviewEvents(task.id);
  useEffect(() => {
    if (!hasOutside) return;
    let live = true;
    const startedAt = version;
    loadTaskReviews(task.id)
      .then((loaded) => {
        if (!live) return;
        setRounds(loaded ?? []);
        reviewsReloaded(task.id, startedAt);
      })
      .catch(() => live && setRounds(null));
    return () => {
      live = false;
    };
  }, [task.id, task.commentTotal, task.attachments.length, version, hasOutside]);
  const outsideRounds = rounds ?? [];
  const loadingOutside = hasOutside && rounds === undefined;

  const files = reviewTabFiles(teamRounds, outsideRounds, task.attachments);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activePin, setActivePin] = useState<string | null>(null);
  const index = Math.max(0, files.findIndex((f) => f.attachmentId === selectedId));
  const selected = files[index] ?? null;
  const select = (attachmentId: string) => {
    setSelectedId(attachmentId);
    setActivePin(null);
  };

  const roundFileNames = (round: Pick<ApprovalRound, "attachmentIds">) =>
    round.attachmentIds.flatMap((id) => task.attachments.filter((a) => a.id === id).map((a) => a.fileName));

  // The viewer's open decision on a round with files: reviewed file by file in the card.
  const perms = taskPermissions(task);
  const myRequest =
    latest?.status === "pending" && perms.canComment
      ? (latest.requests.find((r) => r.approverId === memberId && r.status === "pending") ?? null)
      : null;
  const myFiles = myRequest && latest ? approverReviewFiles(latest, task.attachments) : [];
  const viewerIsApprover = Boolean(task.approval?.approverIds.includes(memberId));

  const teamName = teamStep
    ? teamStep.personIds.length === 0
      ? "Team"
      : teamStep.personIds.length <= 2
        ? teamStep.personIds.map((id) => firstName(nameOf(id))).join(" + ")
        : "Team"
    : "";
  const outsideName = outsideStep?.outside
    ? firstName(outsideStep.outside.name ?? outsideStep.outside.email.split("@")[0])
    : task.externalReview?.latest
      ? firstName(task.externalReview.latest.recipientName ?? task.externalReview.latest.recipientEmail.split("@")[0])
      : "";

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || isTypingTarget(e.target)) return;
    if (e.target instanceof HTMLVideoElement || files.length < 2) return;
    e.preventDefault();
    const next = stepFile(index, files.length, e.key === "ArrowRight" ? 1 : -1);
    select(files[next].attachmentId);
  }

  if (!track && files.length === 0 && !loadingOutside) {
    return (
      <div data-review-tab="empty" className="rounded-lg border border-dashed border-zinc-200 px-4 py-8 text-center text-sm text-zinc-500">
        No review yet. When this task goes to the team for approval or to an outside reviewer, its files, comments,
        and rounds show here.
      </div>
    );
  }

  const outsideRoundForFile = selected?.outsideRoundId ? outsideRounds.find((r) => r.id === selected.outsideRoundId) : undefined;
  const pins: ViewerPin[] =
    selected && outsideRoundForFile
      ? outsideRoundForFile.pins
          .filter((p) => p.assetId === selected.outsideAssetId)
          .map((p) => ({ key: `outside:${outsideRoundForFile.id}:${p.number}`, number: p.number, page: p.page, x: p.x, y: p.y, time: p.time, body: p.body }))
      : [];
  const comments = selected
    ? fileComments(selected, teamRounds, outsideRounds, { nameOf, roundFileNames })
    : [];
  const merged = mergeReviewRounds(teamRounds, outsideRounds, nameOf);
  const outsideAnswered = outsideStep?.state === "done" || outsideStep?.state === "changes" || outsideRounds.some((r) => r.decidedAt);

  return (
    <div className="@container/review" onKeyDown={onKeyDown} data-review-tab="">
      <div className="grid gap-[18px] @min-[44rem]/review:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        {/* The selected file, large, with the outside reviewer's pins (amber). */}
        <div className="min-w-0">
          <div
            tabIndex={files.length ? 0 : -1}
            aria-label={selected ? `${selected.name}. Use the left and right arrow keys for the other files.` : "No files yet"}
            className="relative flex min-h-[18rem] items-center justify-center overflow-auto rounded-[10px] border border-zinc-200 bg-zinc-100 p-4 outline-none focus-visible:ring-2 focus-visible:ring-accent-400 @min-[44rem]/review:min-h-[26rem] @min-[44rem]/review:max-h-[34rem] [&_[data-pin-key]]:bg-amber-500 [&_[data-pin-key]:hover]:bg-amber-600 [&_img]:max-h-[24rem]"
            data-review-preview=""
          >
            {selected ? (
              <div className="w-full">
                <ReviewViewer
                  key={selected.attachmentId}
                  file={{
                    id: selected.outsideAssetId ?? selected.attachmentId,
                    name: selected.name,
                    contentType: selected.contentType,
                    src: `/attachments/${selected.attachmentId}?media=1`,
                    downloadHref: `/attachments/${selected.attachmentId}?download`,
                  }}
                  pins={pins}
                  activePin={activePin}
                  onSelectPin={setActivePin}
                />
              </div>
            ) : loadingOutside ? (
              <span className="skeleton h-40 w-32 rounded" aria-hidden />
            ) : (
              <p className="max-w-xs text-center text-sm text-zinc-500">
                The files show here once the task is sent{teamStep ? " for approval" : " for review"}.
              </p>
            )}
          </div>
          {files.length ? (
            <ul className="mt-2.5 flex gap-2.5 overflow-x-auto pb-1" aria-label="Files in this round" data-review-strip="">
              {files.map((f) => (
                <li key={f.attachmentId}>
                  <StripFile
                    file={f}
                    selected={f.attachmentId === selected?.attachmentId}
                    onSelect={() => select(f.attachmentId)}
                    team={teamStep ? { name: teamName, chip: teamFileChip(teamRounds, f, roundFileNames) } : null}
                    outside={
                      outsideStep || task.externalReview?.latest
                        ? { name: outsideName, chip: loadingOutside ? null : outsideFileChip(outsideRounds, f, outsideStep?.state ?? "current") }
                        : null
                    }
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="min-w-0">
          {/* The viewer's card. */}
          <div className="rounded-[10px] border border-zinc-200 px-3.5 py-3" data-review-card="">
            {teamStep ? (
              <section aria-label="Team approver" className={outsideStep ? "border-b border-zinc-100 pb-3" : ""}>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <RoleTag role="team" suffix={viewerIsApprover ? " · You" : undefined} />
                  <span className="text-zinc-500">{myFiles.length ? "this file" : teamCardState(teamStep)}</span>
                </div>
                {myRequest && latest && myFiles.length && selected && myFiles.some((f) => f.id === selected.attachmentId) ? (
                  <div className="mt-2">
                    <ApproverReview
                      variant="panel"
                      taskId={task.id}
                      requestId={myRequest.id}
                      round={latest}
                      attachments={task.attachments}
                      fileId={selected.attachmentId}
                      onSelectFile={select}
                    />
                  </div>
                ) : myRequest ? (
                  <p className="mt-2 text-[13px] text-zinc-600">
                    This round has no files to review one by one. Decide in the Team approver block on the Task tab.
                  </p>
                ) : (
                  <TeamSummary step={teamStep} profilesById={profilesById} nameOf={nameOf} />
                )}
              </section>
            ) : null}
            {outsideStep || task.externalReview?.latest ? (
              <section aria-label="Outside reviewer" className={teamStep ? "pt-3" : ""}>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <RoleTag role="outside" suffix={outsideName ? ` · ${outsideStep?.outside?.name ?? outsideName}` : undefined} />
                  <span className="text-zinc-500">{outsideCardState(outsideStep, viewerIsApprover && Boolean(myRequest))}</span>
                </div>
                <p className="mt-1.5 text-[13px] text-zinc-600" data-review-outside-line="">
                  {outsideLine(outsideStep, outsideName, files.length, Boolean(myRequest))}
                </p>
              </section>
            ) : null}
          </div>

          {/* Comments on this file. */}
          <section className="mt-3.5" aria-labelledby="review-file-comments">
            <h3 id="review-file-comments" className="mb-2 text-[13px] font-semibold text-zinc-900">
              Comments on this file
            </h3>
            {comments.length ? (
              <ol className="space-y-2.5" data-review-comments="">
                {comments.map((c) => {
                  const key = c.role === "outside" && outsideRoundForFile ? `outside:${outsideRoundForFile.id}:${c.number}` : c.key;
                  const pinned = c.role === "outside" && pins.some((p) => p.key === key);
                  return (
                    <li key={c.key} className="flex gap-2.5 text-[12.5px] leading-[18px]" data-review-comment={c.role}>
                      <button
                        type="button"
                        disabled={!pinned}
                        onClick={() => setActivePin(key)}
                        aria-label={pinned ? `Show comment ${c.number} on the file` : `Comment ${c.number}`}
                        className={`inline-flex size-[22px] shrink-0 items-center justify-center rounded-[99px_99px_99px_2px] border-2 border-white text-[11px] font-bold text-white disabled:cursor-default ${
                          c.role === "team" ? "bg-accent-500" : "bg-amber-500"
                        } ${activePin === key ? "ring-2 ring-amber-300" : ""}`}
                      >
                        {c.number}
                      </button>
                      <span className="min-w-0">
                        <span className="text-zinc-500">
                          <b className="font-semibold text-zinc-900">{c.authorName}</b> · {c.role === "team" ? "Team approver" : "Outside reviewer"} · round {c.round}
                        </span>
                        <span className="block whitespace-pre-line text-zinc-800">{c.text}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : loadingOutside ? null : (
              <p className="text-[12.5px] text-zinc-500">{selected ? "No comments on this file yet." : "No files yet."}</p>
            )}
            {/* The team's notes show at once; the outside reviewer's pins once their rounds load. */}
            {loadingOutside ? (
              <div className="mt-2 space-y-2" aria-hidden data-review-comments-loading="">
                <span className="skeleton block h-4 w-3/4 rounded" />
                <span className="skeleton block h-4 w-1/2 rounded" />
              </div>
            ) : null}
            {(outsideStep || task.externalReview?.latest) && !outsideAnswered && outsideName ? (
              <p className="mt-2 text-xs text-zinc-500">{outsideName}’s pins will show here in yellow after the review.</p>
            ) : null}
            {selected && perms.canComment ? <FileCommentBox task={task} memberId={memberId} file={selected} /> : null}
          </section>

          {/* Every round, newest first. */}
          <section className="mt-3.5" aria-labelledby="review-rounds">
            <h3 id="review-rounds" className="mb-2 text-[13px] font-semibold text-zinc-900">
              Rounds
            </h3>
            {merged.length ? (
              <ul className="space-y-1.5" data-review-rounds="">
                {merged.map((r) => (
                  <RoundRow key={r.key} round={r} nameOf={nameOf} />
                ))}
              </ul>
            ) : loadingOutside ? (
              <span className="skeleton block h-9 w-full rounded-lg" aria-hidden />
            ) : (
              <p className="text-[12.5px] text-zinc-500">Nothing sent yet.</p>
            )}
            {rounds === null ? <p className="mt-1 text-xs text-zinc-500" role="alert">Couldn’t load the outside reviewer’s rounds.</p> : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function teamCardState(step: TrackStep): string {
  if (step.state === "current") return step.dueOn ? `due ${formatDueDate(step.dueOn)}` : "waiting";
  if (step.state === "done") return "approved";
  if (step.state === "changes") return "asked for changes";
  if (step.state === "rejected") return "rejected";
  return "not sent yet";
}

function outsideCardState(step: TrackStep | null, viewerDecidesFirst: boolean): string {
  if (!step) return "";
  if (step.state === "locked") return viewerDecidesFirst ? "gets it after you" : "gets it after the team";
  if (step.state === "current") return step.sentAt ? "reviewing now" : "ready to send";
  if (step.state === "done") return "approved";
  if (step.state === "changes") return "asked for changes";
  return "not sent yet";
}

function outsideLine(step: TrackStep | null, name: string, fileCount: number, viewerDecidesFirst: boolean) {
  if (!step) return null;
  const due = step.dueOn ? <> · due {weekdayDate(step.dueOn)}</> : null;
  if (step.state === "locked") {
    return (
      <>
        {name} gets the email link once {viewerDecidesFirst ? "you approve" : "the team approves"} {fileCountWords(Math.max(1, fileCount))}.{due}
      </>
    );
  }
  if (step.state === "current" && step.sentAt) {
    return (
      <>
        Reviewing now · sent <LocalDay iso={step.sentAt} />
        {due}
      </>
    );
  }
  if (step.state === "done" && step.decidedAt) {
    return (
      <>
        Approved <LocalDay iso={step.decidedAt} />
      </>
    );
  }
  if (step.state === "changes" && step.decidedAt) {
    return (
      <>
        Asked for changes <LocalDay iso={step.decidedAt} /> · the next round goes back to them
      </>
    );
  }
  return (
    <>
      {step.status}
      {due}
    </>
  );
}

function TeamSummary({
  step,
  profilesById,
  nameOf,
}: {
  step: TrackStep;
  profilesById: Map<string, Profile>;
  nameOf: (id: string) => string;
}) {
  return (
    <div className="mt-2">
      {step.personIds.length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] font-medium text-zinc-800">
          {step.personIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1.5">
              <Avatar name={nameOf(id)} src={profilesById.get(id)?.avatar_url} profileId={id} />
              {nameOf(id)}
            </span>
          ))}
        </div>
      ) : null}
      <p className="mt-1.5 text-[13px] text-zinc-600">
        {step.status}
        {step.state === "current" && step.dueOn ? ` · due ${formatDueDate(step.dueOn)}` : ""}
      </p>
    </div>
  );
}

const CHIP_ICON: Record<FileChip, typeof Check> = {
  approved: Check,
  feedback: MessageSquare,
  pending: Clock,
  locked: Lock,
  waiting: CircleDot,
  answered: CircleDot,
};

const CHIP_WORD: Record<FileChip, string> = {
  approved: "approved",
  feedback: "has feedback",
  pending: "reviewing",
  locked: "after the team",
  waiting: "not sent yet",
  answered: "answered, nothing pinned",
};

function MiniChip({ role, name, chip }: { role: "team" | "outside"; name: string; chip: FileChip }) {
  const Icon = CHIP_ICON[chip];
  return (
    <span
      data-file-chip={`${role}:${chip}`}
      aria-label={`${role === "team" ? "Team approver" : "Outside reviewer"} ${name}: ${CHIP_WORD[chip]}`}
      className={`inline-flex items-center gap-[3px] rounded px-[5px] text-[10.5px] leading-4 font-semibold ${
        role === "team" ? "bg-[#dfe8f8] text-[#2a457f]" : "bg-amber-100 text-amber-800"
      } ${chip === "waiting" ? "opacity-60" : ""}`}
    >
      <Icon className={`size-2.5 ${chip === "approved" ? "text-green-700" : ""}`} strokeWidth={2.5} aria-hidden />
      {name}
    </span>
  );
}

function StripFile({
  file,
  selected,
  onSelect,
  team,
  outside,
}: {
  file: ReviewTabFile;
  selected: boolean;
  onSelect: () => void;
  team: { name: string; chip: FileChip } | null;
  outside: { name: string; chip: FileChip | null } | null;
}) {
  const kind = reviewMediaKind(file.name, file.contentType);
  const [broken, setBroken] = useState(false);
  const ext = file.name.match(/\.([A-Za-z0-9]{1,6})$/)?.[1]?.toUpperCase() ?? "FILE";
  return (
    <div className={`w-[150px] rounded-[9px] border-2 p-[3px] ${selected ? "border-accent-500" : "border-transparent"}`}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        aria-label={`${file.name}${selected ? " (shown)" : ""}`}
        className="block w-full overflow-hidden rounded-md border border-zinc-200 bg-white text-left hover:border-zinc-300"
      >
        <span className="flex h-[62px] items-center justify-center bg-zinc-50 text-zinc-400">
          {kind === "image" && !broken ? (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link to the private bucket
            <img src={`/attachments/${file.attachmentId}?preview=1`} alt="" onError={() => setBroken(true)} className="size-full object-cover" />
          ) : (
            <span className="flex flex-col items-center gap-0.5">
              <FileText className="size-5" aria-hidden />
              <span className="text-[10px] font-semibold">{ext}</span>
            </span>
          )}
        </span>
        <span className="block truncate px-2 py-1.5 text-xs font-medium text-zinc-800" title={file.name}>
          {file.name}
        </span>
      </button>
      {team || outside ? (
        <span className="mt-[5px] flex min-h-4 flex-wrap gap-1">
          {team ? <MiniChip role="team" name={team.name} chip={team.chip} /> : null}
          {outside?.chip ? <MiniChip role="outside" name={outside.name} chip={outside.chip} /> : null}
        </span>
      ) : null}
    </div>
  );
}

const ROUND_CHIP: Record<MergedRound["tone"], string> = {
  blue: "bg-accent-500 text-white",
  amber: "bg-amber-100 text-amber-800",
  green: "bg-green-100 text-green-700",
  red: "bg-red-100 text-red-700",
  grey: "bg-zinc-100 text-zinc-600",
};

function RoundRow({ round, nameOf }: { round: MergedRound; nameOf: (id: string) => string }) {
  const chip = round.open && round.role === "outside" ? "bg-amber-500 text-white" : ROUND_CHIP[round.tone];
  const tint = round.open ? (round.role === "team" ? "border-[#c0d1f1] bg-[#f6f8fd]" : "border-amber-200 bg-amber-50/60") : "border-zinc-200";
  return (
    <li className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-2 text-[12.5px] ${tint}`} data-review-round={round.role}>
      <b className="font-semibold text-zinc-900">Round {round.number}</b>
      <RoleTag role={round.role} small />
      <span className="min-w-0 text-zinc-500">
        sent <LocalDay iso={round.sentAt} />
        {round.sentBy ? ` by ${nameOf(round.sentBy)}` : ""} · {round.fileCount} {round.fileCount === 1 ? "file" : "files"}
      </span>
      <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${chip}`}>{round.status}</span>
    </li>
  );
}

// A comment on the shown file: an ordinary task comment that starts with the file's name. It shows in the
// task's comments at once (a pending row), like the comment box's. Talk dictates into it.
function FileCommentBox({ task, memberId, file }: { task: TaskDetail; memberId: string; file: ReviewTabFile }) {
  const id = useId();
  const [, run] = useServerAction();
  const [draft, setDraftState] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // The text dictation writes into, kept in step with every change (read outside render only).
  const latest = useRef("");
  const setDraft = (next: string | ((current: string) => string)) => {
    const value = typeof next === "function" ? next(latest.current) : next;
    latest.current = value;
    setDraftState(value);
  };
  const talk = useDictation();
  const { attach } = talk;
  useEffect(
    () =>
      attach(
        textareaTarget(
          () => ref.current,
          () => latest.current,
          (next) => {
            latest.current = next;
            setDraftState(next);
          },
        ),
      ),
    [attach],
  );

  function submit() {
    const text = draft.trim();
    if (!text || talk.listening) return;
    const body = `${file.name}: ${text}`;
    const tempId = `pending-${crypto.randomUUID()}`;
    addPendingComment({
      tempId,
      taskId: task.id,
      authorId: memberId,
      body,
      createdAt: new Date().toISOString(),
      email: null,
      serverId: null,
      knownIds: task.comments.map((c) => c.id),
    });
    setDraft("");
    run(async () => {
      const result = await addComment(task.id, body);
      if (result.error || !result.commentId) {
        dropPendingComment(tempId);
        setDraft((current) => (current.trim() ? current : text));
      } else {
        settlePendingComment(tempId, result.commentId);
      }
      return result;
    });
  }

  return (
    <div className="mt-3" data-review-comment-box="">
      <label htmlFor={id} className="sr-only">
        Comment on {file.name}
      </label>
      <div className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 focus-within:border-accent-500/60 focus-within:shadow-[0_0_0_3px_var(--focus-ring)]">
        <textarea
          ref={ref}
          id={id}
          rows={1}
          value={draft}
          onChange={(e) => {
            if (talk.listening) talk.abandon();
            setDraft(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Comment on this file"
          className="field-sizing-content max-h-40 min-h-6 flex-1 resize-none border-0 bg-transparent p-0 text-[13px] text-zinc-900 shadow-none outline-none placeholder:text-zinc-500 focus-visible:shadow-none"
        />
        <TalkButton dictation={talk} label={`Dictate a comment on ${file.name}`} />
        {draft.trim() ? (
          <button type="button" onClick={submit} disabled={talk.listening} aria-label="Post the comment" data-tooltip="Comment (Enter)" className="btn-icon size-6 text-accent-600">
            <Send className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      <DictationInterim dictation={talk} className="mt-1 px-3" />
    </div>
  );
}

