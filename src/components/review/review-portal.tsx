"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { Check, CheckCircle2, Download, FileText, Image as ImageIcon, MessageSquare, Paperclip, Upload, Video, X } from "lucide-react";
import { PinList } from "@/components/review/pin-list";
import { ReviewViewer, type PinPlace, type ViewerPin } from "@/components/review/review-viewer";
import { ATTACHMENTS_BUCKET } from "@/lib/attachments";
import {
  MAX_REVIEW_NOTE,
  MAX_REVIEW_PINS,
  MAX_REVIEW_UPLOADS,
  REVIEW_STATUS_LABELS,
  reviewMediaKind,
  reviewUploadProblem,
  type PublicReview,
  type ReviewFile,
  type ReviewStatus,
} from "@/lib/review-checks";
import { finishReviewUpload, startReviewUpload, submitReviewDecision, type DraftPin } from "@/lib/review-public-actions";
import { createAnonBrowserClient } from "@/lib/supabase/anon-browser";

// Oct 26 notes (batch 3): the public review page (no sign-in; the link's token is the only key). The
// files in full quality, click to pin numbered comments (images, PDF pages, video moments), send files
// back, then Approve or Send feedback. Everything goes through the token-checked Server Actions.

type Draft = DraftPin & { key: string };

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

export function ReviewPortal({
  token,
  review,
  logoUrl,
  initialAction,
}: {
  token: string;
  review: PublicReview;
  logoUrl: string | null;
  initialAction: "approve" | "feedback" | null;
}) {
  const fileUrl = (id: string) => `/review/${token}/file/${id}`;
  const [status, setStatus] = useState<ReviewStatus>(review.status);
  const open = status === "pending";
  const [active, setActive] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<ReviewFile[]>(review.files);
  const [uploading, setUploading] = useState<{ name: string; error?: string }[]>([]);
  const [confirming, setConfirming] = useState(initialAction === "approve" && open);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const noteId = useId();

  useEffect(() => {
    if (initialAction === "feedback" && open) noteRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival from the email's button
  }, []);

  const asset = review.assets[active] ?? null;
  // Pins on this file: the drafts while open, else the ones the reviewer sent.
  const shownPins: ViewerPin[] = useMemo(() => {
    if (!asset) return [];
    if (open) {
      return drafts
        .map((d, i) => ({ d, number: i + 1 }))
        .filter(({ d }) => d.assetId === asset.id)
        .map(({ d, number }) => ({ key: d.key, number, page: d.page ?? null, x: d.x ?? null, y: d.y ?? null, time: d.time ?? null, body: d.body }));
    }
    return review.pins
      .filter((p) => p.assetId === asset.id)
      .map((p) => ({ key: `sent-${p.number}`, number: p.number, page: p.page, x: p.x, y: p.y, time: p.time, body: p.body }));
  }, [asset, open, drafts, review.pins]);

  function addPin(place: PinPlace) {
    if (!asset || drafts.length >= MAX_REVIEW_PINS) return;
    const key = `pin-${Date.now()}-${drafts.length}`;
    setDrafts((current) => [...current, { key, assetId: asset.id, page: place.page ?? null, x: place.x ?? null, y: place.y ?? null, time: place.time ?? null, body: "" }]);
    setActivePin(key);
    // The new pin's text box takes the focus (after it renders).
    requestAnimationFrame(() => document.getElementById(`pin-text-${key}`)?.focus());
  }

  function choosePin(key: string, assetId: string) {
    const index = review.assets.findIndex((a) => a.id === assetId);
    if (index >= 0) setActive(index);
    setActivePin(key);
  }

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
      const sent = await createAnonBrowserClient()
        .storage.from(ATTACHMENTS_BUCKET)
        .uploadToSignedUrl(started.path, started.uploadToken, file, { contentType: file.type || undefined });
      if (sent.error) {
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

  function decide(decision: "approved" | "changes_requested") {
    setError(null);
    const pins = drafts.filter((d) => d.body.trim());
    if (decision === "changes_requested" && !note.trim() && !pins.length) {
      setError("Add a note or pin at least one comment so they know what to change.");
      noteRef.current?.focus();
      return;
    }
    if (drafts.some((d) => !d.body.trim())) {
      setError("Some pins have no comment yet. Write one, or remove the pin.");
      return;
    }
    start(async () => {
      const result = await submitReviewDecision(token, decision, note, pins);
      if (result.error) setError(result.error);
      else {
        setStatus(result.status ?? decision);
        setConfirming(false);
      }
    });
  }

  const greetingName = review.recipientName?.split(/\s+/)[0];

  return (
    <div className="min-h-screen bg-zinc-100">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
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
              {review.projectName ? ` · ${review.projectName}` : ""} · Version {review.round}
            </p>
          </div>
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

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-label="Files" className="min-w-0 space-y-3">
          {review.message ? (
            <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-800">
              <p className="whitespace-pre-line">{review.message}</p>
            </div>
          ) : null}
          {review.assets.length > 1 ? (
            <div role="tablist" aria-label="Files to review" className="flex flex-wrap gap-1.5">
              {review.assets.map((a, i) => {
                const Icon = fileIcon(a);
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="tab"
                    aria-selected={i === active}
                    onClick={() => setActive(i)}
                    className="inline-flex max-w-64 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 aria-selected:border-accent-400 aria-selected:bg-accent-50 aria-selected:text-accent-900"
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">{a.name}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {asset ? (
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
                <span className="min-w-0 flex-1 truncate">
                  {asset.name} {asset.size ? `· ${size(asset.size)}` : ""}
                </span>
                {open ? <span>Click the file to pin a comment</span> : null}
                <a href={`${fileUrl(asset.id)}?download=1`} className="btn-ghost h-7 px-2 text-xs">
                  <Download className="size-3.5" aria-hidden />
                  Download
                </a>
              </div>
              <ReviewViewer
                file={{ id: asset.id, name: asset.name, contentType: asset.contentType, src: fileUrl(asset.id), downloadHref: `${fileUrl(asset.id)}?download=1` }}
                pins={shownPins}
                activePin={activePin}
                onPick={open ? addPin : undefined}
                onSelectPin={(key) => setActivePin(key)}
              />
            </div>
          ) : (
            <p className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-500">
              The files of this review aren’t available any more.
            </p>
          )}
        </section>

        <aside aria-label="Your review" className="space-y-3">
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            {open ? (
              <>
                <h2 className="text-sm font-semibold text-zinc-900">
                  {greetingName ? `${greetingName}, what do you think?` : "What do you think?"}
                </h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Click anywhere on a file to pin a numbered comment. On a video, pause and use “Comment at”.
                </p>
              </>
            ) : (
              <>
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
                  {status === "approved" ? <CheckCircle2 className="size-4 text-green-600" aria-hidden /> : null}
                  {status === "approved"
                    ? "Approved — thank you!"
                    : status === "changes_requested"
                      ? "Thanks — your feedback was sent"
                      : status === "superseded"
                        ? "A newer version was sent for review"
                        : "This review was withdrawn"}
                </h2>
                <p className="mt-1 text-xs text-zinc-500">
                  {status === "superseded" || status === "cancelled"
                    ? "Check your email for the latest link."
                    : "The team has it on their task. You can still look at the files here."}
                </p>
                {review.decisionNote ? (
                  <p className="mt-2 whitespace-pre-line rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-700">{review.decisionNote}</p>
                ) : null}
              </>
            )}

            <PinList
              pins={
                open
                  ? drafts.map((d, i) => ({ key: d.key, number: i + 1, assetId: d.assetId, page: d.page ?? null, time: d.time ?? null, body: d.body }))
                  : review.pins.map((p) => ({ key: `sent-${p.number}`, number: p.number, assetId: p.assetId, page: p.page, time: p.time, body: p.body }))
              }
              assets={review.assets}
              activePin={activePin}
              editable={open}
              onChoose={choosePin}
              onChange={(key, body) => setDrafts((current) => current.map((d) => (d.key === key ? { ...d, body } : d)))}
              onRemove={(key) => setDrafts((current) => current.filter((d) => d.key !== key))}
            />

            {open ? (
              <div className="mt-3">
                <label htmlFor={noteId} className="text-xs font-medium text-zinc-700">
                  Overall note <span className="font-normal text-zinc-400">(optional with Approve)</span>
                </label>
                <textarea
                  id={noteId}
                  ref={noteRef}
                  value={note}
                  maxLength={MAX_REVIEW_NOTE}
                  rows={3}
                  onChange={(e) => setNote(e.currentTarget.value)}
                  placeholder="Anything else they should know"
                  className="field mt-1 h-auto w-full py-1.5"
                />
              </div>
            ) : null}
          </div>

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
                {open ? "Have a better version? Upload it in full quality (up to 25 MB a file)." : "None."}
              </p>
            )}
            {open ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="sr-only"
                  aria-label="Upload files"
                  onChange={(e) => void upload(e.currentTarget.files)}
                />
                <button type="button" onClick={() => fileInput.current?.click()} className="btn-secondary mt-3 h-8 px-3">
                  <Upload className="size-4" aria-hidden />
                  Upload files
                </button>
              </>
            ) : null}
          </div>

          {open ? (
            <div className="rounded-lg border border-zinc-200 bg-white p-4">
              {error ? (
                <p role="alert" className="mb-2 text-sm text-red-700">
                  {error}
                </p>
              ) : null}
              {confirming ? (
                <div className="space-y-2">
                  <p className="text-sm text-zinc-800">Approve {review.assets.length === 1 ? "this file" : "these files"}?</p>
                  <div className="flex gap-2">
                    <button type="button" disabled={pending} onClick={() => decide("approved")} className="btn-primary h-9 flex-1 px-3">
                      <Check className="size-4" aria-hidden />
                      {pending ? "Sending…" : "Yes, approve"}
                    </button>
                    <button type="button" disabled={pending} onClick={() => setConfirming(false)} className="btn-secondary h-9 px-3">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <button type="button" disabled={pending} onClick={() => setConfirming(true)} className="btn-primary h-9 px-3">
                    <Check className="size-4" aria-hidden />
                    Approve
                  </button>
                  <button type="button" disabled={pending} onClick={() => decide("changes_requested")} className="btn-secondary h-9 px-3">
                    <MessageSquare className="size-4" aria-hidden />
                    {pending ? "Sending…" : "Send feedback"}
                  </button>
                </div>
              )}
              <p className="mt-2 text-2xs text-zinc-400">This link works until {new Date(review.expiresAt).toLocaleDateString()}.</p>
            </div>
          ) : null}
        </aside>
      </main>
    </div>
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
