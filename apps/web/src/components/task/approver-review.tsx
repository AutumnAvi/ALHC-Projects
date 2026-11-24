"use client";

import Link from "next/link";
import { useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Maximize2, MessageSquare } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { Dialog } from "@/components/dialog";
import { useServerAction } from "@/components/toast";
import { decideApproval } from "@/lib/actions/approvals";
import {
  approverDecision,
  approverDecisionNote,
  approverFileStatus,
  approverReviewFiles,
  approverReviewHref,
  approverReviewStorageKey,
  parseStoredReview,
} from "@alhc/core/approver-review";
import type { ApprovalRound, TaskAttachment } from "@alhc/core/api/task-pane/model";
import { answerProblem, approveFile, confirmQuestion, nextUnreviewedIndex, reviewTally, reviewedLabel, setFileNote, submitLabel, unapproveFile, type FileReviews } from "@alhc/core/review-portal";
import { reviewMediaKind, type ReviewFile } from "@alhc/core/review-checks";

// Nov 2 notes (batch 15, 114): the approver's review of a round's files, inside the task — a compact
// version of the requester review page. Only the approver whose decision is open sees it (the banner
// decides). Each file is Approved or Has feedback; Submit waits until every file is reviewed, and the
// answer is derived from the files (decide_approval with each file's outcome in the note). Expand opens
// it full screen in the app; "Open review page" is /approve/<task> (the same review on its own page).
// Progress is kept in this browser per request until it's sent.

type Stored = { files: FileReviews; overall: string };
const EMPTY: Stored = { files: {}, overall: "" };
const cache = new Map<string, Stored>();
const listeners = new Set<() => void>();

function readStored(key: string): Stored {
  let value = cache.get(key);
  if (!value) {
    value = typeof window === "undefined" ? EMPTY : parseStoredReview(window.localStorage.getItem(key));
    cache.set(key, value);
  }
  return value;
}

function writeStored(key: string, value: Stored | null) {
  if (value) cache.set(key, value);
  else cache.delete(key);
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value));
    else window.localStorage.removeItem(key);
  } catch {
    // Storage full or blocked: progress lives only in memory then.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function ApproverReview({
  taskId,
  requestId,
  round,
  attachments,
  variant = "compact",
  onExpand,
  onDone,
  onDecide,
  extraAction,
  intro,
  fileId,
  onSelectFile,
}: {
  // Nov 2 notes (batch 16, 126): the approval card shows the decision at once.
  onDecide?: (decision: "approved" | "changes_requested", note: string) => void;
  taskId: string;
  requestId: string;
  round: ApprovalRound;
  attachments: readonly TaskAttachment[];
  // Batch 45: "panel" = only the controls (the Review tab draws the preview and the file strip itself and
  // says which file is shown through `fileId`; "Next file to review" asks it to move with `onSelectFile`).
  variant?: "compact" | "full" | "panel";
  fileId?: string;
  onSelectFile?: (fileId: string) => void;
  onExpand?: () => void;
  onDone?: () => void;
  // Batch 44 (item 1): another action shown next to Submit in the pinned bar (the review page's Reject).
  extraAction?: ReactNode;
  // Batch 44 (item 1): what the review page shows above the files (the task's details, the final text).
  // It's drawn inside the review so the pinned Submit bar holds from the top of the page: a sticky bar
  // can't rise above the block it's in, so long details above that block would push it below the screen.
  intro?: ReactNode;
}) {
  const ids = useId();
  const key = approverReviewStorageKey(requestId);
  const stored = useSyncExternalStore(subscribe, () => readStored(key), () => EMPTY);
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const assets = approverReviewFiles(round, attachments);
  const [index, setIndexState] = useState(() => {
    const first = assets.findIndex((a) => approverFileStatus(a.id, stored.files) === "unreviewed");
    return first < 0 ? 0 : first;
  });
  const noteRef = useRef<HTMLTextAreaElement>(null);
  if (assets.length === 0) return null;
  const shown = fileId ? assets.findIndex((a) => a.id === fileId) : -1;
  const at = shown >= 0 ? shown : Math.min(index, assets.length - 1);
  const setIndex = (i: number) => {
    setIndexState(i);
    if (assets[i]) onSelectFile?.(assets[i].id);
  };
  const file = assets[at];
  const files = stored.files;
  const state = { pins: [], files };
  const tally = reviewTally(assets, state);
  const decision = approverDecision(assets, files);
  const problem = answerProblem(assets, state);
  const status = approverFileStatus(file.id, files);
  const full = variant === "full";
  const panel = variant === "panel";

  const save = (next: Partial<Stored>) => writeStored(key, { ...stored, ...next });
  const nextOpen = nextUnreviewedIndex(assets, state, at);

  async function approveThis() {
    if (status === "approved") {
      save({ files: unapproveFile(files, file.id) });
      return;
    }
    if (files[file.id]?.note.trim()) {
      const ok = await confirm({
        title: "Approve this file?",
        message: "Your feedback on it will be removed.",
        confirmLabel: "Approve file",
      });
      if (!ok) return;
    }
    const nextFiles = approveFile(state, file.id).files;
    save({ files: nextFiles });
    const after = nextUnreviewedIndex(assets, { pins: [], files: nextFiles }, at);
    if (after !== null) setIndex(after);
  }

  async function submit() {
    if (!decision || problem) return;
    const ok = await confirm({
      title: confirmQuestion(assets, state),
      message: decision === "approved" ? "The assignee is told it’s approved." : "It goes back to the assignee with your feedback on each file.",
      confirmLabel: submitLabel(decision),
    });
    if (!ok) return;
    const note = approverDecisionNote(assets, files, stored.overall);
    run(
      async () => {
        const result = await decideApproval(requestId, decision, note);
        if (!result.error) {
          writeStored(key, null);
          onDone?.();
        }
        return result;
      },
      () => onDecide?.(decision, note),
    );
  }

  return (
    <div
      data-approver-review={variant}
      className={full ? "flex min-h-0 flex-col gap-3" : panel ? "flex flex-col" : "mt-2 rounded-lg border border-accent-200 bg-white p-3 shadow-sm"}
    >
      {intro}
      <div className={`flex flex-wrap items-center gap-2 ${panel ? "hidden" : ""}`}>
        <h3 className="text-sm font-semibold text-zinc-900">Review the files</h3>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium tabular-nums text-zinc-700" data-approver-progress="">
          {reviewedLabel(tally)}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {!full && onExpand ? (
            <button type="button" onClick={onExpand} className="btn-ghost h-7 px-2 text-xs">
              <Maximize2 className="size-3.5" aria-hidden />
              Expand
            </button>
          ) : null}
          {!full && !panel ? (
            <Link href={approverReviewHref(taskId)} className="btn-ghost h-7 px-2 text-xs">
              <ExternalLink className="size-3.5" aria-hidden />
              Open review page
            </Link>
          ) : null}
        </span>
      </div>

      <ul className={`mt-2 flex gap-1.5 overflow-x-auto pb-1 ${panel ? "hidden" : ""}`} aria-label="Files to review">
        {assets.map((a, i) => {
          const s = approverFileStatus(a.id, files);
          return (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-current={i === at ? "true" : undefined}
                aria-label={`${a.name}: ${s === "approved" ? "approved" : s === "feedback" ? "has feedback" : "not reviewed yet"}`}
                className={`relative flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-zinc-50 ${
                  i === at ? "border-accent-500 ring-2 ring-accent-200" : "border-zinc-200 hover:border-zinc-400"
                }`}
              >
                <FilePreview file={a} size="thumb" />
                {s !== "unreviewed" ? (
                  <span
                    aria-hidden
                    className={`absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full text-white ${
                      s === "approved" ? "bg-green-600" : "bg-amber-500"
                    }`}
                  >
                    {s === "approved" ? <Check className="size-3" /> : <MessageSquare className="size-2.5" />}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      <div className={`grid gap-3 ${panel ? "" : "mt-2"} ${full ? "min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_20rem]" : ""}`}>
        {panel ? null : (
          <div
            className={`flex items-center justify-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 ${
              full ? "min-h-[50vh]" : "h-44"
            }`}
          >
            <FilePreview file={file} size={full ? "full" : "medium"} />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-2">
          <p className="flex items-center gap-1.5 text-sm text-zinc-800">
            <span className="min-w-0 flex-1 truncate font-medium" title={file.name}>
              {file.name}
            </span>
            <span className="shrink-0 text-xs text-zinc-500">
              File {at + 1} of {assets.length}
            </span>
            <button type="button" aria-label="Previous file" data-tooltip="Previous file" disabled={assets.length < 2} onClick={() => setIndex((at - 1 + assets.length) % assets.length)} className="btn-icon size-7">
              <ChevronLeft className="size-4" />
            </button>
            <button type="button" aria-label="Next file" data-tooltip="Next file" disabled={assets.length < 2} onClick={() => setIndex((at + 1) % assets.length)} className="btn-icon size-7">
              <ChevronRight className="size-4" />
            </button>
          </p>
          <button
            type="button"
            aria-pressed={status === "approved"}
            onClick={() => void approveThis()}
            className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium ${
              status === "approved"
                ? "border-green-600 bg-green-600 text-white hover:bg-green-700"
                : "border-green-600 bg-white text-green-700 hover:bg-green-50"
            }`}
          >
            <Check className="size-4" aria-hidden />
            {status === "approved" ? "Approved" : panel ? "Approve file" : "Approve this file"}
          </button>
          {panel ? (
            <button
              type="button"
              aria-pressed={status === "feedback"}
              onClick={() => noteRef.current?.focus()}
              className="btn-secondary h-8 justify-center px-3"
              data-approver-has-feedback=""
            >
              <MessageSquare className="size-4" aria-hidden />
              Has feedback
            </button>
          ) : null}
          <label htmlFor={`${ids}-note`} className="text-xs font-medium text-zinc-700">
            Or leave feedback on this file
          </label>
          <textarea
            ref={noteRef}
            id={`${ids}-note`}
            value={files[file.id]?.note ?? ""}
            onChange={(e) => save({ files: setFileNote(files, file.id, e.currentTarget.value.slice(0, 1000)) })}
            rows={full ? 5 : 2}
            placeholder="What should change?"
            className="field h-auto w-full py-1.5 text-sm"
          />
          {panel ? (
            <span className="text-2xs tabular-nums text-zinc-500" data-approver-progress="">
              {reviewedLabel(tally)}
            </span>
          ) : null}
          {nextOpen !== null ? (
            <button type="button" onClick={() => setIndex(nextOpen)} className="btn-ghost h-7 self-start px-2 text-xs">
              Next file to review
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      {/* Nov 18 notes (batch 44, item 1): on the full review (its page, Expand) Submit never needs a scroll:
          the note and Submit stick to the bottom of the screen while the files are in view. */}
      <div
        className={`mt-3 flex flex-col gap-2 border-t border-zinc-100 pt-3 ${
          full ? "sticky bottom-0 z-10 -mx-1 rounded-b-lg bg-white px-1 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-10px_20px_-14px_rgba(24,24,27,0.35)]" : ""
        }`}
        data-approver-review-submit=""
      >
        <label htmlFor={`${ids}-overall`} className="text-xs font-medium text-zinc-700">
          Note for the assignee <span className="font-normal text-zinc-400">(optional)</span>
        </label>
        <textarea
          id={`${ids}-overall`}
          value={stored.overall}
          onChange={(e) => save({ overall: e.currentTarget.value.slice(0, 1000) })}
          rows={2}
          className="field h-auto w-full py-1.5 text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-xs text-zinc-500" aria-live="polite" data-approver-review-problem="">
            {problem ?? (decision === "approved" ? "Every file is approved." : "Some files have feedback: this requests changes.")}
          </p>
          {extraAction}
          <button
            type="button"
            disabled={pending || Boolean(problem)}
            onClick={() => void submit()}
            className={`btn-primary h-8 px-3 ${decision === "approved" ? "bg-green-700 hover:bg-green-800" : ""}`}
          >
            {pending ? "Sending…" : submitLabel(decision)}
          </button>
        </div>
      </div>
    </div>
  );
}

// The full-screen review in the app (Expand from the task's banner).
export function ApproverReviewDialog(props: Omit<Parameters<typeof ApproverReview>[0], "variant" | "onExpand"> & { onClose: () => void }) {
  const { onClose, ...rest } = props;
  return (
    <Dialog title="Review the files" description={`Round ${props.round.number}`} onClose={onClose} width="max-w-6xl">
      <ApproverReview
        {...rest}
        variant="full"
        onDone={() => {
          rest.onDone?.();
          onClose();
        }}
      />
    </Dialog>
  );
}

function FilePreview({ file, size }: { file: ReviewFile; size: "thumb" | "medium" | "full" }) {
  const kind = reviewMediaKind(file.name, file.contentType);
  const [broken, setBroken] = useState(false);
  const ext = file.name.match(/\.([A-Za-z0-9]{1,6})$/)?.[1]?.toUpperCase() ?? "FILE";
  const tile = (
    <span className="flex flex-col items-center gap-1 text-zinc-500">
      <FileText className={size === "thumb" ? "size-4" : "size-8"} aria-hidden />
      <span className="text-2xs font-semibold">{ext}</span>
    </span>
  );
  if (kind === "image" && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/attachments/${file.id}?preview=1`}
        alt={size === "thumb" ? "" : file.name}
        onError={() => setBroken(true)}
        className={size === "thumb" ? "size-full object-cover" : "max-h-full max-w-full object-contain"}
      />
    );
  }
  if (size === "thumb") return tile;
  if (kind === "pdf" && size === "full") {
    return <iframe title={file.name} src={`/attachments/${file.id}?preview=1`} className="h-[60vh] w-full border-0 bg-white" />;
  }
  if (kind === "video") {
    return <video src={`/attachments/${file.id}?media=1`} controls className="max-h-full max-w-full" />;
  }
  return (
    <div className="flex flex-col items-center gap-2">
      {tile}
      <a
        href={kind === "pdf" ? `/attachments/${file.id}?preview=1` : `/attachments/${file.id}`}
        target="_blank"
        rel="noreferrer"
        className="btn-secondary h-7 px-2 text-xs"
      >
        {kind === "pdf" ? <ExternalLink className="size-3.5" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
        {kind === "pdf" ? "Open PDF" : "Download"}
      </a>
    </div>
  );
}
