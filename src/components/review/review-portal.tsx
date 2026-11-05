"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, useTransition, type ReactNode, type RefObject } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleHelp,
  Download,
  ExternalLink,
  FileText,
  History,
  Image as ImageIcon,
  MessageSquare,
  Paperclip,
  Send,
  Upload,
  Video,
  X,
} from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { PinList } from "@/components/review/pin-list";
import { ReviewViewer, type PinPlace, type ViewerPin } from "@/components/review/review-viewer";
import { ReviewWalkthrough } from "@/components/review/review-walkthrough";
import {
  MAX_PIN_TEXT,
  MAX_REVIEW_NOTE,
  MAX_REVIEW_PINS,
  MAX_REVIEW_UPLOADS,
  REVIEW_REFUSALS,
  REVIEW_STATUS_LABELS,
  pinPlace,
  reviewMediaKind,
  reviewUploadProblem,
  roundLabel,
  type PreviousRound,
  type PublicReview,
  type ReviewFile,
  type ReviewFileResult,
  type ReviewPin,
  type ReviewStatus,
} from "@/lib/review-checks";
import {
  SAVE_DELAY_MS,
  answerProblem,
  approveFile,
  confirmQuestion,
  confirmationTitle,
  derivedDecision,
  draftToState,
  feedbackOnFile,
  fileOutcomes,
  fileProgressLabel,
  fileStatus,
  initialAssetIndex,
  nextUnreviewedIndex,
  numberedPins,
  outcomeLabel,
  pinCountByAsset,
  pinsByFile,
  retryDelay,
  reviewTally,
  reviewedLabel,
  saveStateText,
  savingStops,
  setFileNote,
  shortDate,
  shouldShowWalkthrough,
  stateToProgress,
  submitLabel,
  unapproveFile,
  walkthroughKey,
  type FileReviews,
  type FileStatus,
  type KeyedPin,
  type SaveState,
} from "@/lib/review-portal";
import {
  finishReviewUpload,
  saveReviewProgress,
  startReviewUpload,
  submitReviewDecision,
} from "@/lib/actions/review-public";
import { type ReviewProgress } from "@/lib/api/reviews/model";
import { uploadReviewFile } from "@/lib/api/client/storage";
import { createApiContext } from "@/lib/api/core/context";
import { createAnonBrowserClient } from "@/lib/supabase/anon-browser";

// Oct 26 notes (batch 3), reworked in Oct 27 notes (batch 5): the public review page (no sign-in; the
// link's token is the only key). One file at a time ("File 2 of 5", Previous / Next, a file list), click to
// pin numbered comments (images, PDF pages, video moments with a marked timeline), send files back, then
// send the answer. Since Nov 1 notes (batch 8) every file is approved or gets feedback (pins, a note on that
// file) on its own, "Next file to review" walks through the rest, Submit waits until every file is reviewed,
// and the answer is what the files add up to (src/lib/review-portal.ts). Everything is saved as they go
// (review_check_save), so leaving loses nothing. A first-visit "How it works" walkthrough, the previous
// round they answered (collapsed, with its pins), and a confirmation page once they've answered. Everything
// goes through the token-checked Server Actions and routes.

type SentAnswer = { decision: ReviewStatus; note: string | null; pins: ReviewPin[]; fileResults: ReviewFileResult[] | null };

const STATUS_WORDS: Record<FileStatus, string> = {
  approved: "Approved",
  feedback: "Has feedback",
  unreviewed: "Not reviewed yet",
};

function fileIcon(file: ReviewFile) {
  const kind = reviewMediaKind(file.name, file.contentType);
  if (kind === "image") return ImageIcon;
  if (kind === "video") return Video;
  if (kind === "pdf") return FileText;
  return Paperclip;
}

function size(bytes: number | null) {
  if (bytes === null) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The walkthrough's "closed it here" flag lives in this browser's storage (keyed by the round, never the
// token); a change in another tab or here tells useSyncExternalStore.
const WALKTHROUGH_EVENT = "alhc:review-walkthrough";
function subscribeWalkthrough(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(WALKTHROUGH_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(WALKTHROUGH_EVENT, onChange);
  };
}
function walkthroughSeenHere(key: string) {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

export function ReviewPortal({
  token,
  review,
  logoUrl,
  initialAction,
  initialFile = null,
}: {
  token: string;
  review: PublicReview;
  logoUrl: string | null;
  initialAction: "approve" | "feedback" | null;
  // ?file=<file id>: the file an email thumbnail linked to.
  initialFile?: string | null;
}) {
  const fileUrl = (id: string) => `/review/${token}/file/${id}`;
  const [status, setStatus] = useState<ReviewStatus>(review.status);
  const open = status === "pending";

  // The reviewer's work, restored from what they saved: pins, notes, and each file's approval.
  const [initial] = useState(() => {
    const state = draftToState(review.draft, review.assets);
    const index = initialAssetIndex(review.assets, initialFile, state.activeAsset);
    // What the database already has: nothing is saved again until something differs from it. (A draft
    // saved before files were reviewed one by one differs, so it's saved once in the new shape.)
    const baseline = review.draft?.perFile
      ? JSON.stringify(stateToProgress({ ...state, activeAsset: state.activeAsset ?? review.assets[index]?.id ?? null }, review.assets))
      : "";
    return { state, index, baseline };
  });
  const [active, setActive] = useState(initial.index);
  const [pins, setPins] = useState<KeyedPin[]>(initial.state.pins);
  const [note, setNote] = useState(initial.state.note);
  const [fileReviews, setFileReviews] = useState<FileReviews>(initial.state.files);
  // "Approval taken back" after feedback lands on an approved file (shown on that file).
  const [notice, setNotice] = useState<{ assetId: string; text: string } | null>(null);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [files, setFiles] = useState<ReviewFile[]>(review.files);
  const [uploading, setUploading] = useState<{ name: string; error?: string }[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentAnswer | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [pending, start] = useTransition();
  const fileNoteRef = useRef<HTMLTextAreaElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  const noteId = useId();
  const problemId = useId();
  const confirm = useConfirm();

  const asset = review.assets[active] ?? null;
  const work = { pins, files: fileReviews };
  const tally = reviewTally(review.assets, work);
  const decision = derivedDecision(review.assets, work);
  const problem = answerProblem(review.assets, work);

  // ---- Saved as they go -----------------------------------------------------------------------------
  const serialized = JSON.stringify(
    stateToProgress({ pins, note, files: fileReviews, activeAsset: asset?.id ?? null }, review.assets),
  );
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [stopReason, setStopReason] = useState<string | null>(null);
  const savedRef = useRef(initial.baseline);
  const latestRef = useRef(serialized);
  const openRef = useRef(open);
  const inFlight = useRef(false);
  const stopped = useRef(false);
  const attempt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    latestRef.current = serialized;
    openRef.current = open;
  }, [serialized, open]);

  useEffect(() => {
    flushRef.current = async () => {
      if (stopped.current || !openRef.current || inFlight.current) return;
      const payload = latestRef.current;
      if (payload === savedRef.current) return;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      inFlight.current = true;
      setSaveState("saving");
      const result = await saveReviewProgress(token, JSON.parse(payload) as ReviewProgress).catch(
        (): { error: string; status?: string } => ({ error: "network" }),
      );
      inFlight.current = false;
      if (!openRef.current) return;
      if (!result.error) {
        savedRef.current = payload;
        attempt.current = 0;
        setSaveState("saved");
        // Something changed while it was saving: save that too.
        if (latestRef.current !== payload) retryTimer.current = setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
      } else if (savingStops(result.status)) {
        stopped.current = true;
        setSaveState("stopped");
        setStopReason(REVIEW_REFUSALS[result.status ?? ""] ?? result.error);
      } else {
        setSaveState("error");
        retryTimer.current = setTimeout(() => void flushRef.current(), retryDelay(attempt.current++));
      }
    };
  });

  // Shortly after the last change.
  useEffect(() => {
    if (!open || serialized === savedRef.current) return;
    const timer = setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [serialized, open]);

  // Right away when they switch tabs or leave (best effort: the browser may not wait for it).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flushRef.current();
    };
    const onPageHide = () => void flushRef.current();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  useEffect(() => {
    if (initialAction === "feedback" && open) fileNoteRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival from the email's button
  }, []);

  // ---- How it works -----------------------------------------------------------------------------
  const walkthroughStorageKey = walkthroughKey(review.id);
  const seenHere = useSyncExternalStore(
    subscribeWalkthrough,
    () => walkthroughSeenHere(walkthroughStorageKey),
    // The server (and the first, hydrating render) never shows it: the browser decides.
    () => true,
  );
  const [dismissed, setDismissed] = useState(false);
  const [reopened, setReopened] = useState(false);
  const serverToldSeen = useRef(review.walkthroughSeen);
  const showWalkthrough =
    reopened ||
    (!dismissed && shouldShowWalkthrough({ open: review.status === "pending" && open, seenOnServer: review.walkthroughSeen, seenHere }));

  function closeWalkthrough() {
    setDismissed(true);
    setReopened(false);
    try {
      window.localStorage.setItem(walkthroughStorageKey, new Date().toISOString());
      window.dispatchEvent(new Event(WALKTHROUGH_EVENT));
    } catch {
      // Storage blocked: the server's flag still remembers it.
    }
    if (!serverToldSeen.current) {
      serverToldSeen.current = true;
      void saveReviewProgress(token, null, true).catch(() => undefined);
    }
  }

  // ---- Pins -------------------------------------------------------------------------------------
  const numberedDrafts = pins.map((p, i) => ({ ...p, number: i + 1 }));

  function addPin(place: PinPlace) {
    if (!asset || pins.length >= MAX_REVIEW_PINS) return;
    const key = `pin-new-${nextKey.current++}`;
    setPins((current) => [
      ...current,
      { key, assetId: asset.id, page: place.page ?? null, x: place.x ?? null, y: place.y ?? null, time: place.time ?? null, body: "" },
    ]);
    setActivePin(key);
    setConfirming(false);
    // Feedback on an approved file takes the approval back (a file is one or the other).
    if (fileReviews[asset.id]?.approved) {
      setFileReviews((current) => unapproveFile(current, asset.id));
      setNotice({ assetId: asset.id, text: "Approval taken back: this file has feedback now." });
    }
    // The new pin's text box takes the focus (after it renders).
    requestAnimationFrame(() => document.getElementById(`pin-text-${key}`)?.focus());
  }

  // A pin picked in the list: its file opens and the pin lights up (and scrolls into view on a PDF).
  function choosePin(key: string, assetId: string) {
    const index = review.assets.findIndex((a) => a.id === assetId);
    if (index >= 0) setActive(index);
    setActivePin(key);
    requestAnimationFrame(() =>
      document.querySelector(`[data-pin-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }

  // A pin picked on the file: its comment lights up in the list.
  function selectOnFile(key: string) {
    setActivePin(key);
    requestAnimationFrame(() => document.getElementById(`pin-item-${key}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  // ---- Files sent back --------------------------------------------------------------------------
  async function upload(list: FileList | null) {
    if (!list?.length) return;
    for (const file of Array.from(list)) {
      if (files.length + uploading.length >= MAX_REVIEW_UPLOADS) break;
      const problem = reviewUploadProblem({ name: file.name, type: file.type, size: file.size });
      const entry = { name: file.name, error: problem ?? undefined };
      setUploading((current) => [...current, entry]);
      if (problem) continue;
      const started = await startReviewUpload(token, { name: file.name, type: file.type, size: file.size });
      if (started.error || !started.path || !started.uploadToken || !started.fileId) {
        setUploading((current) => current.map((u) => (u === entry ? { ...u, error: started.error ?? "Couldn’t upload" } : u)));
        continue;
      }
      const sentFile = await uploadReviewFile(
        createApiContext(createAnonBrowserClient()),
        started.path,
        started.uploadToken,
        file,
      );
      if (sentFile.error !== null) {
        setUploading((current) => current.map((u) => (u === entry ? { ...u, error: "The upload didn’t finish. Try again." } : u)));
        continue;
      }
      const finished = await finishReviewUpload(token, started.fileId);
      if (finished.error || !finished.file) {
        setUploading((current) => current.map((u) => (u === entry ? { ...u, error: finished.error ?? "Couldn’t upload" } : u)));
        continue;
      }
      setFiles((current) => [...current, finished.file!]);
      setUploading((current) => current.filter((u) => u !== entry));
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  // ---- Each file: approve, or feedback -----------------------------------------------------------
  async function toggleApproval(assetId: string) {
    setConfirming(false);
    setError(null);
    if (fileReviews[assetId]?.approved && fileStatus(assetId, work) === "approved") {
      setFileReviews((current) => unapproveFile(current, assetId));
      setNotice(null);
      return;
    }
    // Approving a file with feedback removes that feedback (asked first): a file is one or the other.
    const feedback = feedbackOnFile(assetId, work);
    if (feedback) {
      const parts = [feedback.pins ? plural(feedback.pins, "comment") : null, feedback.note ? "your note" : null].filter(Boolean);
      const ok = await confirm({
        title: "Approve this file?",
        message: `Approving it removes the feedback you left on it (${parts.join(" and ")}). Keep the feedback instead if it needs changes.`,
        confirmLabel: "Approve and remove feedback",
        cancelLabel: "Keep feedback",
        tone: "danger",
      });
      if (!ok) return;
    }
    const next = approveFile({ pins, files: fileReviews }, assetId);
    setPins(next.pins);
    setFileReviews(next.files);
    setNotice(null);
    if (activePin && !next.pins.some((p) => p.key === activePin)) setActivePin(null);
  }

  function changeFileNote(assetId: string, value: string) {
    setConfirming(false);
    setError(null);
    if (fileReviews[assetId]?.approved && value.trim()) {
      setNotice({ assetId, text: "Approval taken back: this file has feedback now." });
    }
    setFileReviews((current) => setFileNote(current, assetId, value));
  }

  const nextIndex = nextUnreviewedIndex(review.assets, work, active);

  function goToSubmit() {
    submitRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    submitRef.current?.focus({ preventScroll: true });
  }

  // ---- The answer -------------------------------------------------------------------------------
  function askToSend() {
    if (problem) {
      setError(problem);
      const blank = pins.find((p) => !p.body.trim());
      if (blank && !tally.left) choosePin(blank.key, blank.assetId);
      return;
    }
    setError(null);
    setConfirming(true);
  }

  function send() {
    if (!decision || problem) return;
    const chosen = decision;
    const progress = JSON.parse(serialized) as ReviewProgress;
    const outcomes = fileOutcomes(review.assets, work);
    start(async () => {
      const result = await submitReviewDecision(
        token,
        chosen,
        note,
        pins.map(({ assetId, page, x, y, time, body }) => ({ assetId, page, x, y, time, body })),
        progress,
      );
      if (result.error) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      if (retryTimer.current) clearTimeout(retryTimer.current);
      setSent({ decision: result.status ?? chosen, note: note.trim() || null, pins: numberedPins(pins), fileResults: outcomes });
      setStatus(result.status ?? chosen);
      setConfirming(false);
      setBrowsing(false);
      window.scrollTo({ top: 0 });
    });
  }

  const header = (
    <ReviewHeader
      review={review}
      logoUrl={logoUrl}
      status={status}
      progress={open && review.assets.length ? reviewedLabel(tally) : null}
      onHowItWorks={() => setReopened(true)}
    />
  );
  const walkthrough = showWalkthrough ? <ReviewWalkthrough onClose={closeWalkthrough} /> : null;

  // ---- Answered: the confirmation (and the files, read-only, on request) --------------------------
  if (!open) {
    const answer: SentAnswer = sent ?? { decision: status, note: review.decisionNote, pins: review.pins, fileResults: review.fileResults };
    const resultOf = new Map((answer.fileResults ?? []).map((r) => [r.assetId, r]));
    return (
      <div className="min-h-screen bg-zinc-100">
        {header}
        {walkthrough}
        {browsing ? (
          <main className="mx-auto grid max-w-7xl gap-4 px-3 py-4 sm:px-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <section aria-label="Files" className="min-w-0 space-y-3">
              <button type="button" onClick={() => setBrowsing(false)} className="btn-ghost h-10 px-2 lg:h-8">
                <ChevronLeft className="size-4" aria-hidden />
                Back to the summary
              </button>
              <FileBrowser
                label="Files in this review"
                assets={review.assets}
                active={active}
                onActive={setActive}
                pins={answer.pins.map((p) => ({ ...p, key: `sent-${p.number}` }))}
                activePin={activePin}
                onSelectPin={selectOnFile}
                fileUrl={fileUrl}
                statusOf={
                  answer.fileResults
                    ? (id) => {
                        const r = resultOf.get(id);
                        return !r ? "unreviewed" : r.pins || r.note ? "feedback" : "approved";
                      }
                    : undefined
                }
              />
            </section>
            <aside aria-label="What you sent" className="space-y-3">
              <div className="rounded-lg border border-zinc-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-zinc-900">Your comments</h2>
                {answer.pins.length ? null : <p className="mt-1 text-xs text-zinc-500">No pinned comments.</p>}
                <PinList
                  pins={answer.pins.map((p) => ({ key: `sent-${p.number}`, number: p.number, assetId: p.assetId, page: p.page, time: p.time, body: p.body }))}
                  assets={review.assets}
                  activePin={activePin}
                  editable={false}
                  onChoose={choosePin}
                />
              </div>
              <SentBackFiles files={files} fileUrl={fileUrl} />
            </aside>
          </main>
        ) : (
          <ReviewConfirmation
            review={review}
            answer={answer}
            files={files}
            fileUrl={fileUrl}
            onBrowse={() => {
              setBrowsing(true);
              window.scrollTo({ top: 0 });
            }}
          />
        )}
      </div>
    );
  }

  // ---- Open: review the files and answer ----------------------------------------------------------
  const greetingName = review.recipientName?.split(/\s+/)[0];
  const blankPin = pins.find((p) => !p.body.trim()) ?? null;
  const statusOf = (id: string) => fileStatus(id, work);
  const current = asset ? statusOf(asset.id) : null;

  return (
    <div className="min-h-screen bg-zinc-100">
      {header}
      {walkthrough}
      <main className="mx-auto grid max-w-7xl gap-4 px-3 pb-56 pt-4 sm:px-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:pb-6">
        <section aria-label="Files" className="min-w-0 space-y-3">
          {stopReason ? (
            <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
              {stopReason} Your latest changes weren’t saved.
            </p>
          ) : null}
          {review.message ? (
            <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-800">
              <p className="whitespace-pre-line">{review.message}</p>
            </div>
          ) : null}
          {review.previous ? <PreviousRoundPanel previous={review.previous} fileUrl={fileUrl} /> : null}
          <FileBrowser
            label="Files to review"
            assets={review.assets}
            active={active}
            onActive={setActive}
            pins={numberedDrafts}
            activePin={activePin}
            onSelectPin={selectOnFile}
            onPick={addPin}
            fileUrl={fileUrl}
            statusOf={statusOf}
            footer={
              asset && current ? (
                <FileReviewPanel
                  key={asset.id}
                  asset={asset}
                  status={current}
                  pinCount={pins.filter((p) => p.assetId === asset.id).length}
                  note={fileReviews[asset.id]?.note ?? ""}
                  onNote={(value) => changeFileNote(asset.id, value)}
                  onToggleApproval={() => void toggleApproval(asset.id)}
                  notice={notice?.assetId === asset.id ? notice.text : null}
                  noteRef={fileNoteRef}
                  nextLabel={
                    nextIndex !== null
                      ? `Next file to review: ${review.assets[nextIndex].name}`
                      : tally.left === 0
                        ? "Every file is reviewed"
                        : null
                  }
                  onNext={nextIndex !== null ? () => setActive(nextIndex) : tally.left === 0 ? goToSubmit : null}
                  allReviewed={tally.left === 0}
                  many={review.assets.length > 1}
                />
              ) : null
            }
          />
        </section>

        <aside aria-label="Your review" className="space-y-3">
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-zinc-900">
              {greetingName ? `${greetingName}, what do you think?` : "What do you think?"}
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Approve each file, or leave feedback on it: click anywhere on a file to pin a numbered comment (on a
              video, pause and use “Comment at”), or write a note under it.
            </p>
            <PinList
              pins={numberedDrafts.map((p) => ({ key: p.key, number: p.number, assetId: p.assetId, page: p.page, time: p.time, body: p.body }))}
              assets={review.assets}
              activePin={activePin}
              editable
              onChoose={choosePin}
              onChange={(key, body) => setPins((current) => current.map((p) => (p.key === key ? { ...p, body } : p)))}
              onRemove={(key) => {
                setPins((current) => current.filter((p) => p.key !== key));
                setConfirming(false);
              }}
            />
            <div className="mt-3">
              <label htmlFor={noteId} className="text-xs font-medium text-zinc-700">
                Overall note <span className="font-normal text-zinc-400">(optional)</span>
              </label>
              <textarea
                id={noteId}
                value={note}
                maxLength={MAX_REVIEW_NOTE}
                rows={3}
                onChange={(e) => {
                  setNote(e.currentTarget.value);
                  setConfirming(false);
                }}
                placeholder="Anything else they should know"
                className="field mt-1 h-auto w-full py-1.5"
              />
            </div>
          </div>

          <SentBackFiles
            files={files}
            fileUrl={fileUrl}
            uploading={uploading}
            onUpload={() => fileInput.current?.click()}
            input={
              <input
                ref={fileInput}
                type="file"
                multiple
                className="sr-only"
                aria-label="Upload files"
                onChange={(e) => void upload(e.currentTarget.files)}
              />
            }
          />

          {/* The answer: a fixed bar at the bottom of small screens, a card in the side column on wide ones. */}
          <div
            aria-label="Your answer"
            role="region"
            className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200 bg-white px-3 pb-3 pt-2.5 shadow-[0_-6px_16px_rgba(24,24,27,0.08)] lg:static lg:z-auto lg:rounded-lg lg:border lg:p-4 lg:shadow-none"
          >
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 max-lg:sr-only">Your answer</h2>
            <AnswerSummary tally={tally} decision={decision} />
            {error ? (
              <p role="alert" className="mt-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}
            {confirming && decision && !problem ? (
              <div className="mt-2 space-y-2 rounded-md bg-zinc-50 p-2.5">
                <p className="text-sm text-zinc-800">
                  {confirmQuestion(review.assets, work)} You can’t change it afterwards.
                </p>
                <div className="flex gap-2">
                  <button type="button" disabled={pending} onClick={send} className="btn-primary h-10 flex-1 px-3">
                    <Check className="size-4" aria-hidden />
                    {pending ? "Sending…" : "Yes, send it"}
                  </button>
                  <button type="button" disabled={pending} onClick={() => setConfirming(false)} className="btn-secondary h-10 px-3">
                    Not yet
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* A disabled button gets no hover: the tooltip sits on its wrapper, the reason under it. */}
                <span className="mt-2 block" data-tooltip={problem ?? undefined}>
                  <button
                    ref={submitRef}
                    type="button"
                    disabled={pending || Boolean(problem)}
                    aria-describedby={problem ? problemId : undefined}
                    onClick={askToSend}
                    className="btn-primary h-10 w-full px-3"
                  >
                    <Send className="size-4" aria-hidden />
                    {submitLabel(decision)}
                  </button>
                </span>
                {problem ? (
                  <p id={problemId} className="mt-1.5 text-xs text-zinc-600">
                    {problem}{" "}
                    {tally.left > 0 && nextIndex !== null ? (
                      <button type="button" onClick={() => setActive(nextIndex)} className="font-medium text-accent-700 hover:underline">
                        Go to the next one
                      </button>
                    ) : !tally.left && blankPin ? (
                      <button type="button" onClick={() => choosePin(blankPin.key, blankPin.assetId)} className="font-medium text-accent-700 hover:underline">
                        Show it
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </>
            )}
            <p className="mt-2 flex flex-wrap items-center justify-between gap-x-2 text-2xs text-zinc-500" aria-live="polite">
              <span className={saveState === "error" || saveState === "stopped" ? "text-amber-700" : ""}>
                {saveState === "saved" ? <Check className="mr-0.5 inline size-3 text-green-600" aria-hidden /> : null}
                {saveStateText(saveState)}
              </span>
              <span className="max-lg:hidden">Link works until {shortDate(review.expiresAt)}</span>
            </p>
          </div>
        </aside>
      </main>
    </div>
  );
}

function ReviewHeader({
  review,
  logoUrl,
  status,
  progress,
  onHowItWorks,
}: {
  review: PublicReview;
  logoUrl: string | null;
  status: ReviewStatus;
  // "2 of 3 reviewed" while the round is open.
  progress: string | null;
  onHowItWorks: () => void;
}) {
  return (
    <header className="border-b border-zinc-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the workspace's public logo
          <img src={logoUrl} alt={review.workspaceName ?? "Logo"} className="h-8 w-auto max-w-40 object-contain" />
        ) : (
          <span className="text-sm font-semibold text-zinc-900">{review.workspaceName ?? "Review"}</span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-zinc-900">{review.taskTitle}</h1>
          <p className="truncate text-xs text-zinc-500">
            {review.senderName ? `${review.senderName} asked for your review` : "Review requested"}
            {review.projectName ? ` · ${review.projectName}` : ""} · {roundLabel(review.round)}
          </p>
        </div>
        {progress ? (
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium tabular-nums text-zinc-700" aria-live="polite">
            {progress}
          </span>
        ) : null}
        <button type="button" onClick={onHowItWorks} className="btn-ghost h-10 px-2 text-xs lg:h-8">
          <CircleHelp className="size-4" aria-hidden />
          How it works
        </button>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            status === "approved"
              ? "bg-green-50 text-green-800"
              : status === "changes_requested"
                ? "bg-amber-50 text-amber-800"
                : status === "pending"
                  ? "bg-accent-50 text-accent-800"
                  : "bg-zinc-100 text-zinc-600"
          }`}
        >
          {status === "approved" ? "You approved this" : status === "changes_requested" ? "Feedback sent" : REVIEW_STATUS_LABELS[status]}
        </span>
      </div>
    </header>
  );
}

// The answer the files add up to, plainly: how many are reviewed, and what will be sent.
function AnswerSummary({ tally, decision }: { tally: ReturnType<typeof reviewTally>; decision: ReturnType<typeof derivedDecision> }) {
  const percent = tally.total ? Math.round((100 * tally.reviewed) / tally.total) : 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium tabular-nums text-zinc-900">{reviewedLabel(tally)}</span>
        {decision === "approved" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800">
            <Check className="size-3.5" aria-hidden />
            Approve
          </span>
        ) : decision === "changes_requested" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
            <MessageSquare className="size-3.5" aria-hidden />
            Request changes
          </span>
        ) : (
          <span className="text-xs text-zinc-500">{tally.left === 1 ? "1 file left" : `${tally.left} files left`}</span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Files reviewed"
        aria-valuemin={0}
        aria-valuemax={tally.total}
        aria-valuenow={tally.reviewed}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100"
      >
        <span className={`block h-full rounded-full ${tally.feedback ? "bg-amber-500" : "bg-green-500"}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-zinc-500 max-lg:sr-only">
        {decision === "approved"
          ? "Every file is approved, so your answer is Approve."
          : decision === "changes_requested"
            ? `${tally.feedback === 1 ? "1 file has" : `${tally.feedback} files have`} feedback, so your answer is Request changes.`
            : "Approve each file or leave feedback on it. All approved sends Approve; any feedback sends Request changes."}
      </p>
    </div>
  );
}

// Under the file on screen: its state, Approve this file (a toggle), a note on this file, and the way to the
// next file nobody reviewed yet (or to Submit once every file is).
function FileReviewPanel({
  asset,
  status,
  pinCount,
  note,
  onNote,
  onToggleApproval,
  notice,
  noteRef,
  nextLabel,
  onNext,
  allReviewed,
  many,
}: {
  asset: ReviewFile;
  status: FileStatus;
  pinCount: number;
  note: string;
  onNote: (value: string) => void;
  onToggleApproval: () => void;
  notice: string | null;
  noteRef: RefObject<HTMLTextAreaElement | null>;
  nextLabel: string | null;
  onNext: (() => void) | null;
  allReviewed: boolean;
  many: boolean;
}) {
  const noteId = useId();
  const approved = status === "approved";
  const detail =
    status === "feedback"
      ? [pinCount ? plural(pinCount, "comment") : null, note.trim() ? "a note" : null].filter(Boolean).join(" and ")
      : null;
  return (
    <div className="space-y-2 border-t border-zinc-100 px-2 py-3 sm:px-3" aria-label={`Your review of ${asset.name}`} role="group">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={approved}
          onClick={onToggleApproval}
          className={`inline-flex h-10 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors lg:h-9 ${
            approved
              ? "border-green-600 bg-green-600 text-white hover:bg-green-700"
              : "border-zinc-300 bg-white text-zinc-800 hover:border-green-500 hover:bg-green-50 hover:text-green-900"
          }`}
        >
          <Check className="size-4" aria-hidden />
          {approved ? "Approved" : "Approve this file"}
        </button>
        <span
          className={`inline-flex items-center gap-1 text-xs ${
            status === "approved" ? "text-green-700" : status === "feedback" ? "text-amber-700" : "text-zinc-500"
          }`}
        >
          <FileStatusMark status={status} />
          {STATUS_WORDS[status]}
          {detail ? ` · ${detail}` : ""}
        </span>
        {onNext && nextLabel ? (
          <button
            type="button"
            onClick={onNext}
            className={`ml-auto inline-flex h-10 max-w-full items-center gap-1 rounded-md px-3 text-sm font-medium lg:h-9 ${
              status === "unreviewed" ? "btn-secondary" : "btn-primary"
            }`}
          >
            <span className="truncate">{allReviewed ? (many ? "All files reviewed: go to Submit" : "Reviewed: go to Submit") : "Next file to review"}</span>
            <ChevronRight className="size-4 shrink-0" aria-hidden />
            <span className="sr-only">{nextLabel}</span>
          </button>
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
          {notice}
        </p>
      ) : null}
      <div>
        <label htmlFor={noteId} className="text-xs font-medium text-zinc-700">
          Note on this file <span className="font-normal text-zinc-400">(counts as feedback)</span>
        </label>
        <textarea
          id={noteId}
          ref={noteRef}
          value={note}
          maxLength={MAX_PIN_TEXT}
          rows={2}
          onChange={(e) => onNote(e.currentTarget.value)}
          placeholder="What should change in this file?"
          className="field mt-1 h-auto w-full py-1.5"
        />
      </div>
    </div>
  );
}

function FileStatusMark({ status, className = "size-3.5" }: { status: FileStatus; className?: string }) {
  if (status === "approved") return <CheckCircle2 className={`${className} shrink-0 text-green-600`} aria-hidden />;
  if (status === "feedback") return <MessageSquare className={`${className} shrink-0 text-amber-600`} aria-hidden />;
  return <Circle className={`${className} shrink-0 text-zinc-300`} aria-hidden />;
}

// One file at a time: "File 2 of 5" with Previous / Next, a list of the files (each with its pin count),
// Full size / Download, and the file itself with its pins.
function FileBrowser({
  label,
  assets,
  active,
  onActive,
  pins,
  activePin,
  onSelectPin,
  onPick,
  fileUrl,
  statusOf,
  footer,
}: {
  label: string;
  assets: ReviewFile[];
  active: number;
  onActive: (index: number) => void;
  pins: { key: string; number: number; assetId: string; page: number | null; x: number | null; y: number | null; time: number | null; body: string }[];
  activePin: string | null;
  onSelectPin: (key: string) => void;
  onPick?: (place: PinPlace) => void;
  fileUrl: (id: string) => string;
  // Nov 1 notes (batch 8): each file's state (a mark in the file list), and the controls under the file.
  statusOf?: (assetId: string) => FileStatus;
  footer?: ReactNode;
}) {
  const asset = assets[active] ?? null;
  const counts = pinCountByAsset(pins);
  if (!asset) {
    return (
      <p className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-500">
        The files of this review aren’t available any more.
      </p>
    );
  }
  const shown: ViewerPin[] = pins
    .filter((p) => p.assetId === asset.id)
    .map(({ key, number, page, x, y, time, body }) => ({ key, number, page, x, y, time, body }));
  const many = assets.length > 1;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-2 py-2 sm:px-3">
        {many ? (
          <button
            type="button"
            disabled={active === 0}
            onClick={() => onActive(active - 1)}
            aria-label="Previous file"
            data-tooltip="Previous file"
            className="btn-icon size-10 lg:size-8"
          >
            <ChevronLeft className="size-4" />
          </button>
        ) : null}
        <p className="min-w-0 flex-1 text-sm text-zinc-800" aria-live="polite">
          <span className="font-medium">File {fileProgressLabel(active, assets.length)}</span>
          {statusOf && !many ? (
            <span className="sr-only">, {STATUS_WORDS[statusOf(asset.id)]}</span>
          ) : null}
          <span className="text-zinc-500"> · </span>
          <span className="break-all">{asset.name}</span>
          {asset.size ? <span className="text-zinc-400"> · {size(asset.size)}</span> : null}
        </p>
        {many ? (
          <button
            type="button"
            disabled={active === assets.length - 1}
            onClick={() => onActive(active + 1)}
            aria-label="Next file"
            data-tooltip="Next file"
            className="btn-icon size-10 lg:size-8"
          >
            <ChevronRight className="size-4" />
          </button>
        ) : null}
        <a
          href={fileUrl(asset.id)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${asset.name} full size`}
          data-tooltip="Open full size"
          className="btn-ghost h-10 px-2 text-xs lg:h-8"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          <span className="max-sm:sr-only">Full size</span>
        </a>
        <a
          href={`${fileUrl(asset.id)}?download=1`}
          aria-label={`Download ${asset.name}`}
          data-tooltip="Download the original"
          className="btn-ghost h-10 px-2 text-xs lg:h-8"
        >
          <Download className="size-3.5" aria-hidden />
          <span className="max-sm:sr-only">Download</span>
        </a>
      </div>
      {many ? (
        <div role="tablist" aria-label={label} className="flex gap-1.5 overflow-x-auto border-b border-zinc-100 px-2 py-2 sm:px-3">
          {assets.map((a, i) => {
            const Icon = fileIcon(a);
            const count = counts.get(a.id) ?? 0;
            const fileState = statusOf?.(a.id) ?? null;
            return (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={i === active}
                aria-label={`File ${i + 1}: ${a.name}${fileState ? `, ${STATUS_WORDS[fileState].toLowerCase()}` : ""}${count ? `, ${plural(count, "comment")}` : ""}`}
                onClick={() => onActive(i)}
                className="inline-flex h-10 max-w-56 shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-sm text-zinc-700 hover:bg-zinc-50 aria-selected:border-accent-400 aria-selected:bg-accent-50 aria-selected:text-accent-900 lg:h-8"
              >
                {fileState ? <FileStatusMark status={fileState} className="size-4" /> : <span className="text-2xs tabular-nums text-zinc-400">{i + 1}</span>}
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{a.name}</span>
                {count ? (
                  <span className="rounded-full bg-accent-600 px-1.5 text-2xs font-semibold tabular-nums text-white">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="bg-zinc-50 p-2 sm:p-3">
        {onPick ? <p className="mb-2 text-xs text-zinc-500">Click the file to pin a comment</p> : null}
        <ReviewViewer
          key={asset.id}
          file={{ id: asset.id, name: asset.name, contentType: asset.contentType, src: fileUrl(asset.id), downloadHref: `${fileUrl(asset.id)}?download=1` }}
          pins={shown}
          activePin={activePin}
          onPick={onPick}
          onSelectPin={onSelectPin}
        />
      </div>
      {footer}
    </div>
  );
}

// The round before (same reviewer, answered): collapsed to one line; open it to see its files with the
// pins they left, and their note.
function PreviousRoundPanel({ previous, fileUrl }: { previous: PreviousRound; fileUrl: (id: string) => string }) {
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const [activePin, setActivePin] = useState<string | null>(null);
  const panelId = useId();
  const pins = previous.pins.map((p) => ({ ...p, key: `prev-${p.number}` }));
  return (
    <section aria-label={`${roundLabel(previous.round)}, what you said last time`} className="rounded-lg border border-zinc-200 bg-white">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((v) => !v)}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-50"
      >
        <History className="size-4 shrink-0 text-zinc-500" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-zinc-900">
            {roundLabel(previous.round)} — what you said last time
          </span>
          <span className="block truncate text-xs text-zinc-500">
            {REVIEW_STATUS_LABELS[previous.status]} · {plural(previous.pins.length, "comment")}
            {previous.decidedAt ? ` · ${shortDate(previous.decidedAt)}` : ""}
          </span>
        </span>
        <ChevronDown className={`size-4 shrink-0 text-zinc-400 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {expanded ? (
        <div id={panelId} className="space-y-3 border-t border-zinc-100 p-3">
          {previous.decisionNote ? (
            <p className="whitespace-pre-line rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
              <span className="font-medium">Your note: </span>
              {previous.decisionNote}
            </p>
          ) : null}
          {previous.fileResults?.length ? <FileOutcomeList results={previous.fileResults} /> : null}
          <FileBrowser
            label={`Files in ${roundLabel(previous.round)}`}
            assets={previous.assets}
            active={active}
            onActive={setActive}
            pins={pins}
            activePin={activePin}
            onSelectPin={setActivePin}
            fileUrl={fileUrl}
          />
          {pins.length ? (
            <PinList
              pins={pins.map((p) => ({ key: p.key, number: p.number, assetId: p.assetId, page: p.page, time: p.time, body: p.body }))}
              assets={previous.assets}
              activePin={activePin}
              editable={false}
              onChoose={(key, assetId) => {
                const index = previous.assets.findIndex((a) => a.id === assetId);
                if (index >= 0) setActive(index);
                setActivePin(key);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SentBackFiles({
  files,
  fileUrl,
  uploading = [],
  onUpload,
  input,
}: {
  files: ReviewFile[];
  fileUrl: (id: string) => string;
  uploading?: { name: string; error?: string }[];
  // Set while the round is open.
  onUpload?: () => void;
  input?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-zinc-900">Files you sent back</h2>
      {files.length || uploading.length ? (
        <ul className="mt-2 space-y-1.5">
          {files.map((f) => {
            const Icon = fileIcon(f);
            return (
              <li key={f.id} className="flex items-center gap-2 text-sm">
                <Icon className="size-4 shrink-0 text-zinc-500" aria-hidden />
                <a href={fileUrl(f.id)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-zinc-800 hover:underline">
                  {f.name}
                </a>
                <span className="shrink-0 text-xs text-zinc-400">{size(f.size)}</span>
              </li>
            );
          })}
          {uploading.map((u, i) => (
            <li key={`${u.name}-${i}`} className={`text-xs ${u.error ? "text-red-700" : "text-zinc-500"}`}>
              {u.error ? `${u.name}: ${u.error}` : `Uploading ${u.name}…`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-zinc-500">
          {onUpload ? "Have a better file? Upload it in full quality (up to 25 MB a file)." : "None."}
        </p>
      )}
      {onUpload ? (
        <>
          {input}
          <button type="button" onClick={onUpload} className="btn-secondary mt-3 h-10 px-3 lg:h-8">
            <Upload className="size-4" aria-hidden />
            Upload files
          </button>
        </>
      ) : null}
    </div>
  );
}

// After the answer (and whenever an answered link is opened again): what was sent, and what happens next.
function ReviewConfirmation({
  review,
  answer,
  files,
  fileUrl,
  onBrowse,
}: {
  review: PublicReview;
  answer: SentAnswer;
  files: ReviewFile[];
  fileUrl: (id: string) => string;
  onBrowse: () => void;
}) {
  const approved = answer.decision === "approved";
  const groups = pinsByFile(answer.pins, review.assets);
  return (
    <main className="mx-auto max-w-2xl px-3 py-8 sm:px-4">
      <div className="rounded-xl border border-zinc-200 bg-white px-5 py-8 text-center shadow-sm sm:px-8">
        <span
          aria-hidden
          className={`mx-auto flex size-14 items-center justify-center rounded-full ${approved ? "bg-green-50 text-green-600" : "bg-amber-50 text-amber-600"}`}
        >
          <CheckCircle2 className="size-8" />
        </span>
        <h2 className="mt-4 text-xl font-semibold text-zinc-900">{confirmationTitle(answer.decision, answer.pins.length)}</h2>
        <p className="mt-2 text-sm text-zinc-600">
          {review.senderName ?? "The team"} has it on their task{review.projectName ? ` in ${review.projectName}` : ""}.{" "}
          {approved ? "Nothing else to do." : "If they send a new round, you’ll get a new email with its own link."}
        </p>
        <button type="button" onClick={onBrowse} className="btn-secondary mt-5 h-10 px-4">
          Look at the files again
        </button>
      </div>

      <section aria-label="What you sent" className="mt-4 space-y-3 rounded-xl border border-zinc-200 bg-white p-5 sm:p-6">
        <h3 className="text-sm font-semibold text-zinc-900">What you sent · {roundLabel(review.round)}</h3>
        <p className="text-sm text-zinc-700">
          <span className="font-medium">{approved ? "Approved" : "Changes requested"}</span>
          {review.decidedAt ? <span className="text-zinc-500"> · {shortDate(review.decidedAt)}</span> : null}
        </p>
        {answer.note ? <p className="whitespace-pre-line rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-800">{answer.note}</p> : null}
        {answer.fileResults?.length ? <FileOutcomeList results={answer.fileResults} /> : null}
        {groups.length ? (
          <ul className="space-y-3">
            {groups.map(({ file, pins }) => (
              <li key={file.id}>
                <p className="text-xs font-medium text-zinc-600">
                  {file.name} · {plural(pins.length, "comment")}
                </p>
                <ol className="mt-1 space-y-1">
                  {pins.map((p) => (
                    <li key={p.number} className="flex gap-2 text-sm text-zinc-800">
                      <span aria-hidden className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-600 text-2xs font-semibold text-white">
                        {p.number}
                      </span>
                      <span className="min-w-0">
                        <span className="sr-only">Comment {p.number}</span>
                        {pinPlace(p) ? <span className="text-zinc-500">{pinPlace(p)}: </span> : null}
                        {p.body}
                      </span>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-500">No pinned comments.</p>
        )}
        {files.length ? (
          <div>
            <p className="text-xs font-medium text-zinc-600">Files you sent back</p>
            <ul className="mt-1 space-y-1">
              {files.map((f) => (
                <li key={f.id} className="text-sm">
                  <a href={fileUrl(f.id)} target="_blank" rel="noopener noreferrer" className="text-accent-700 hover:underline">
                    {f.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </main>
  );
}

// Each file's outcome in an answered round ("poster.png — Approved", "flyer.pdf — Changes requested: 2
// comments and a note"), with the note on that file.
function FileOutcomeList({ results }: { results: ReviewFileResult[] }) {
  return (
    <ul className="space-y-1.5" aria-label="Each file">
      {results.map((r) => {
        const status: FileStatus = r.pins || r.note ? "feedback" : "approved";
        return (
          <li key={r.assetId} className="text-sm text-zinc-800">
            <span className="flex items-start gap-1.5">
              <FileStatusMark status={status} className="mt-0.5 size-4" />
              <span className="min-w-0">
                <span className="break-all font-medium">{r.name}</span>
                <span className={status === "approved" ? "text-green-700" : "text-amber-700"}> — {outcomeLabel(r)}</span>
                {r.note ? <span className="mt-0.5 block whitespace-pre-line text-zinc-600">{r.note}</span> : null}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ReviewClosedNotice({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 px-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center shadow-sm">
        <span aria-hidden className="mx-auto flex size-12 items-center justify-center rounded-full bg-zinc-100 text-zinc-500">
          <X className="size-6" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-zinc-900">This review link can’t be used</h1>
        <p className="mt-2 text-sm text-zinc-600">{message}</p>
      </div>
    </div>
  );
}
