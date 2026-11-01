"use client";

import { useId, useRef, useState, useTransition, type DragEvent } from "react";
import { AlertCircle, Copy, FileText, Image as ImageIcon, Loader2, Lock, Paperclip, Upload, Video, X } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useNotify } from "@/components/toast";
import { setActivityTab } from "@/components/task/pane-size";
import { ImageLightbox, Thumbnail } from "@/components/task/task-attachments";
import { previewKind } from "@/lib/attachment-preview";
import { registerAttachment } from "@/lib/actions";
import { ATTACHMENTS_BUCKET, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_LABEL, attachmentPath } from "@/lib/attachments";
import type { TaskDetail } from "@/lib/data";
import { MAX_REVIEW_ASSETS, MAX_REVIEW_MESSAGE, reviewMediaKind } from "@/lib/review-checks";
import { sendReviewCheck } from "@/lib/review-actions";
import { createClient } from "@/lib/supabase/client";

// Oct 26 notes (batch 3): "Send review check" — pick the task's files and who reviews them (the form's
// submitter by default), add a message, send. The reviewer gets an email with Approve and Leave feedback.
// When no email could be sent, the link is shown once so it can be passed on by hand.
// Oct 27 notes (batch 5): new files can be uploaded right here (button or drop): each one is attached to
// the task like any upload (private bucket, then registerAttachment) and picked for the review.
// Nov 1 notes (batch 8, item 61): Upload files on the left, big; "Files attached to this task" on the
// right as thumbnails (click to preview: images in the pane's lightbox, PDFs / videos in the browser's
// viewer); the reviewer's email is the requester's, read-only; their name comes from the form.

type PickableFile = { id: string; fileName: string; contentType: string | null };
// A file being uploaded from the dialog (or one that couldn't be).
type Upload = { key: string; name: string; error: string | null };

// The files the dialog lists: the task's attachments, then ones uploaded here that the task (refreshed
// after each upload) doesn't list yet.
export function reviewFileList(attachments: PickableFile[], uploaded: PickableFile[]): PickableFile[] {
  const known = new Set(attachments.map((a) => a.id));
  return [...attachments, ...uploaded.filter((u) => !known.has(u.id))];
}

// Ticks one more file unless the review already has as many as it can take.
export function pickWithLimit(picked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(picked);
  if (next.size < MAX_REVIEW_ASSETS) next.add(id);
  return next;
}

function FileKindIcon({ file }: { file: PickableFile }) {
  const kind = reviewMediaKind(file.fileName, file.contentType);
  const className = "size-6";
  if (kind === "image") return <ImageIcon className={className} aria-hidden />;
  if (kind === "video") return <Video className={className} aria-hidden />;
  if (kind === "pdf") return <FileText className={className} aria-hidden />;
  return <Paperclip className={className} aria-hidden />;
}

export function SendReviewDialog({
  task,
  onClose,
  initialMessage = "",
  onSent,
}: {
  task: TaskDetail;
  onClose: () => void;
  // Nov 1 notes (batch 8, item 60): "Send for review" in the comment box passes what was typed there.
  initialMessage?: string;
  onSent?: () => void;
}) {
  const notify = useNotify();
  const ids = useId();
  const [uploaded, setUploaded] = useState<PickableFile[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const files = reviewFileList(task.attachments, uploaded);
  // Files that can be looked at in the browser are picked to start with.
  const [picked, setPicked] = useState<Set<string>>(
    () =>
      new Set(
        task.attachments
          .filter((f) => reviewMediaKind(f.fileName, f.contentType))
          .slice(0, MAX_REVIEW_ASSETS)
          .map((f) => f.id),
      ),
  );
  // Item 61: the reviewer is the requester (the form's submitter), shown read-only; a task that didn't
  // come from a form takes a typed address.
  const requesterEmail = task.submission?.email ?? null;
  const [email, setEmail] = useState("");
  const recipient = (requesterEmail ?? email).trim();
  const [name, setName] = useState(task.submission?.name ?? "");
  const [message, setMessage] = useState(initialMessage.slice(0, MAX_REVIEW_MESSAGE));
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [suppressed, setSuppressed] = useState(false);
  const [pending, start] = useTransition();
  const uploading = uploads.some((u) => !u.error);

  function toggle(id: string) {
    setPicked((current) => {
      if (current.has(id)) {
        const next = new Set(current);
        next.delete(id);
        return next;
      }
      return pickWithLimit(current, id);
    });
  }

  async function uploadFiles(list: FileList | File[] | null) {
    const chosen = Array.from(list ?? []);
    if (fileInput.current) fileInput.current.value = "";
    if (!chosen.length) return;
    const supabase = createClient();
    // One at a time, in the order picked, so the review lists them that way.
    for (const file of chosen) {
      const key = `${file.name}-${crypto.randomUUID()}`;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setUploads((current) => [...current, { key, name: file.name, error: `Larger than ${MAX_ATTACHMENT_LABEL}` }]);
        continue;
      }
      if (file.size === 0) {
        setUploads((current) => [...current, { key, name: file.name, error: "The file is empty" }]);
        continue;
      }
      setUploads((current) => [...current, { key, name: file.name, error: null }]);
      const fail = (message: string) =>
        setUploads((current) => current.map((u) => (u.key === key ? { ...u, error: message } : u)));
      const path = attachmentPath(task.id, file.name, crypto.randomUUID());
      const stored = await supabase.storage
        .from(ATTACHMENTS_BUCKET)
        .upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (stored.error) {
        fail("Couldn’t upload. Try again.");
        continue;
      }
      const registered = await registerAttachment({
        taskId: task.id,
        storagePath: path,
        fileName: file.name,
        contentType: file.type || null,
        sizeBytes: file.size,
      });
      if (registered.error || !registered.attachmentId) {
        fail(registered.error ?? "Couldn’t attach it to the task");
        continue;
      }
      const attachmentId = registered.attachmentId;
      setUploaded((current) => [...current, { id: attachmentId, fileName: file.name, contentType: file.type || null }]);
      setPicked((current) => pickWithLimit(current, attachmentId));
      setUploads((current) => current.filter((u) => u.key !== key));
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
  }

  function send() {
    setError(null);
    start(async () => {
      const result = await sendReviewCheck({
        taskId: task.id,
        attachmentIds: files.filter((f) => picked.has(f.id)).map((f) => f.id),
        recipientEmail: recipient,
        recipientName: name,
        message,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setActivityTab("reviews");
      onSent?.();
      if (result.emailed) {
        notify(`Round ${result.round ?? 1} sent to ${recipient}`);
        onClose();
      } else {
        setLink(result.link ?? null);
        setSuppressed(Boolean(result.suppressed));
      }
    });
  }

  if (link) {
    return (
      <Dialog title="Review check created" onClose={onClose}>
        <p className="text-sm text-zinc-700">
          {suppressed
            ? `${recipient} bounced or marked an earlier email as spam, so no email was sent (Admin console → Email).`
            : "No email could be sent from here."}{" "}
          Send this link to {recipient} yourself. It’s shown only now, and anyone with it can respond.
        </p>
        <div className="mt-3 flex gap-2">
          <input readOnly value={link} aria-label="Review link" className="field h-9 min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <button
            type="button"
            className="btn-secondary h-9 px-3"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(
                () => notify("Review link copied"),
                () => notify("Couldn’t copy. Select the link and copy it instead."),
              );
            }}
          >
            <Copy className="size-4" aria-hidden />
            Copy
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </Dialog>
    );
  }

  const images = files.filter((f) => previewKind(f.fileName, f.contentType) === "image");
  const openImage = lightboxIndex === null ? null : (images[lightboxIndex] ?? null);
  const pickedFiles = files.filter((f) => picked.has(f.id));

  return (
    <Dialog
      title="Send review check"
      description="The reviewer gets an email with large previews and Approve / Leave feedback. They approve each file or pin comments on it, and can send files back."
      onClose={onClose}
      width="max-w-4xl"
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-5 md:grid-cols-[16rem_minmax(0,1fr)]">
          {/* Upload: first and prominent (Nov 1 notes, batch 8, item 61). */}
          <section aria-labelledby={`${ids}-upload`} className="flex flex-col gap-2">
            <h3 id={`${ids}-upload`} className="text-sm font-semibold text-zinc-900">
              Upload files
            </h3>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => void uploadFiles(e.currentTarget.files)}
            />
            <button
              type="button"
              data-autofocus
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => {
                if (!Array.from(e.dataTransfer.types).includes("Files")) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setDragging(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
              }}
              onDrop={onDrop}
              className={`flex min-h-44 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
                dragging
                  ? "border-accent-400 bg-accent-50"
                  : "border-accent-200 bg-accent-50/40 hover:border-accent-400 hover:bg-accent-50"
              }`}
            >
              <span className="flex size-11 items-center justify-center rounded-full bg-accent-600 text-white">
                <Upload className="size-5" aria-hidden />
              </span>
              <span className="text-sm font-semibold text-accent-800">Upload files</span>
              <span className="text-xs text-zinc-600">{dragging ? "Drop to upload" : "Drop files here, or click to choose them"}</span>
              <span className="text-2xs text-zinc-500">
                They’re attached to the task and picked for this review (up to {MAX_ATTACHMENT_LABEL} each).
              </span>
            </button>
            {uploads.length ? (
              <ul className="flex flex-col gap-1">
                {uploads.map((u) => (
                  <li
                    key={u.key}
                    role={u.error ? "alert" : "status"}
                    className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${u.error ? "text-red-700" : "text-zinc-500"}`}
                  >
                    {u.error ? (
                      <AlertCircle className="size-4 shrink-0" aria-hidden />
                    ) : (
                      <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {u.name}
                      {u.error ? `: ${u.error}` : " — uploading…"}
                    </span>
                    {u.error ? (
                      <button
                        type="button"
                        onClick={() => setUploads((current) => current.filter((x) => x.key !== u.key))}
                        aria-label={`Dismiss ${u.name}`}
                        data-tooltip="Dismiss"
                        className="btn-icon size-6"
                      >
                        <X className="size-3.5" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section aria-labelledby={`${ids}-files`} className="flex min-w-0 flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <h3 id={`${ids}-files`} className="min-w-0 flex-1 text-sm font-semibold text-zinc-900">
                Files attached to this task
              </h3>
              <span className="shrink-0 text-xs text-zinc-500">
                {picked.size} of {MAX_REVIEW_ASSETS} picked
              </span>
            </div>
            {files.length === 0 ? (
              <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center text-sm text-zinc-500">
                No files on this task yet. Upload them on the left.
              </p>
            ) : (
              <ul className="grid max-h-[22rem] grid-cols-2 gap-2 overflow-y-auto overscroll-contain p-0.5 sm:grid-cols-3">
                {files.map((f) => (
                  <ReviewFileCard
                    key={f.id}
                    file={f}
                    picked={picked.has(f.id)}
                    full={!picked.has(f.id) && picked.size >= MAX_REVIEW_ASSETS}
                    onToggle={() => toggle(f.id)}
                    onPreviewImage={() => setLightboxIndex(images.findIndex((i) => i.id === f.id))}
                  />
                ))}
              </ul>
            )}
            <p className="text-2xs text-zinc-500">Tick the files to send. Click a preview to look at it.</p>
          </section>
        </div>

        <div className="grid gap-3 border-t border-zinc-100 pt-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${ids}-email`} className="text-xs font-medium text-zinc-700">
              Reviewer’s email
            </label>
            {requesterEmail ? (
              <>
                <div className="relative mt-1">
                  <input
                    id={`${ids}-email`}
                    type="email"
                    value={requesterEmail}
                    readOnly
                    aria-describedby={`${ids}-email-note`}
                    className="field h-9 w-full bg-zinc-50 pr-8 text-zinc-700"
                  />
                  <Lock className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
                </div>
                <p id={`${ids}-email-note`} className="mt-1 text-2xs text-zinc-500">
                  The person who submitted the request. Review checks go to them.
                </p>
              </>
            ) : (
              <>
                <input
                  id={`${ids}-email`}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  placeholder="name@example.com"
                  aria-describedby={`${ids}-email-note`}
                  className="field mt-1 h-9 w-full"
                />
                <p id={`${ids}-email-note`} className="mt-1 text-2xs text-zinc-500">
                  This task didn’t come from a form, so enter who should review it.
                </p>
              </>
            )}
          </div>
          <div>
            <label htmlFor={`${ids}-name`} className="text-xs font-medium text-zinc-700">
              Their name
            </label>
            <input
              id={`${ids}-name`}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. Jordan"
              className="field mt-1 h-9 w-full"
            />
            {task.submission?.name && name.trim() === task.submission.name ? (
              <p className="mt-1 text-2xs text-zinc-500">From the request form</p>
            ) : null}
          </div>
        </div>
        <div>
          <label htmlFor={`${ids}-message`} className="text-xs font-medium text-zinc-700">
            Message <span className="font-normal text-zinc-400">(optional)</span>
          </label>
          <textarea
            id={`${ids}-message`}
            value={message}
            maxLength={MAX_REVIEW_MESSAGE}
            rows={3}
            onChange={(e) => setMessage(e.currentTarget.value)}
            placeholder="Here’s the first draft. Let us know what you think."
            className="field mt-1 h-auto w-full py-1.5"
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-zinc-500">
            {uploading
              ? "Waiting for uploads to finish…"
              : pickedFiles.length
                ? `${pickedFiles.length} ${pickedFiles.length === 1 ? "file" : "files"} to ${recipient || "the reviewer"}`
                : "Pick at least one file"}
          </span>
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={send}
            disabled={pending || uploading || picked.size === 0 || !recipient}
            className="btn-primary"
          >
            {pending ? "Sending…" : "Send review check"}
          </button>
        </div>
      </div>
      {openImage && lightboxIndex !== null ? (
        <ImageLightbox
          image={openImage}
          position={lightboxIndex + 1}
          total={images.length}
          onPrevious={() => setLightboxIndex((i) => (i === null ? i : (i - 1 + images.length) % images.length))}
          onNext={() => setLightboxIndex((i) => (i === null ? i : (i + 1) % images.length))}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </Dialog>
  );
}

// One file in "Files attached to this task": a thumbnail (images) or a type tile, a tick box to pick it,
// and its name. Clicking the preview opens images in the pane's lightbox and PDFs / videos in the
// browser's viewer (the same /attachments routes the pane uses); other files have no preview.
function ReviewFileCard({
  file,
  picked,
  full,
  onToggle,
  onPreviewImage,
}: {
  file: PickableFile;
  picked: boolean;
  full: boolean;
  onToggle: () => void;
  onPreviewImage: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const kind = reviewMediaKind(file.fileName, file.contentType);
  const inline = previewKind(file.fileName, file.contentType);
  const ext = file.fileName.match(/\.([A-Za-z0-9]{1,6})$/)?.[1]?.toUpperCase() ?? "FILE";
  const tile = (
    <span className="flex size-full flex-col items-center justify-center gap-1 bg-zinc-50 text-zinc-500">
      <FileKindIcon file={file} />
      <span className="text-2xs font-semibold tracking-wide">{ext}</span>
    </span>
  );
  const thumb = inline === "image" && !broken ? <Thumbnail src={`/attachments/${file.id}?preview=1`} onBroken={() => setBroken(true)} /> : tile;
  const previewHref = kind === "pdf" ? `/attachments/${file.id}?preview=1` : kind === "video" ? `/attachments/${file.id}?media=1` : null;
  const frame = `block aspect-[4/3] w-full overflow-hidden rounded-t-lg`;
  return (
    <li
      className={`relative flex flex-col rounded-lg border bg-white ${
        picked ? "border-accent-400 ring-1 ring-accent-300" : "border-zinc-200"
      } ${full ? "opacity-60" : ""}`}
    >
      {inline === "image" ? (
        <button type="button" onClick={onPreviewImage} aria-label={`Preview ${file.fileName}`} data-tooltip="Preview" className={frame}>
          {thumb}
        </button>
      ) : previewHref ? (
        <a href={previewHref} target="_blank" rel="noreferrer" aria-label={`Preview ${file.fileName} (opens in a new tab)`} data-tooltip="Preview" className={frame}>
          {thumb}
        </a>
      ) : (
        <span className={frame} data-tooltip="No preview for this file type">
          {thumb}
        </span>
      )}
      <label className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-xs text-zinc-800">
        <input
          type="checkbox"
          checked={picked}
          disabled={full}
          onChange={onToggle}
          className="size-3.5 shrink-0 accent-accent-600"
        />
        <span className="min-w-0 flex-1 truncate" title={file.fileName}>
          {file.fileName}
        </span>
        {kind ? null : <span className="shrink-0 text-2xs text-zinc-400">download only</span>}
      </label>
    </li>
  );
}
