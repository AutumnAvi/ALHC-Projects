"use client";

import { useId, useRef, useState, useTransition, type DragEvent } from "react";
import { AlertCircle, Copy, FileText, Image as ImageIcon, Loader2, Paperclip, Upload, Video, X } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useNotify } from "@/components/toast";
import { setActivityTab } from "@/components/task/pane-size";
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

function iconFor(file: PickableFile) {
  const kind = reviewMediaKind(file.fileName, file.contentType);
  return kind === "image" ? ImageIcon : kind === "video" ? Video : kind === "pdf" ? FileText : Paperclip;
}

export function SendReviewDialog({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
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
  const [email, setEmail] = useState(task.submission?.email ?? "");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
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
        recipientEmail: email,
        recipientName: name,
        message,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setActivityTab("reviews");
      if (result.emailed) {
        notify(`Round ${result.round ?? 1} sent to ${email.trim()}`);
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
            ? `${email.trim()} bounced or marked an earlier email as spam, so no email was sent (Admin console → Email).`
            : "No email could be sent from here."}{" "}
          Send this link to {email.trim()} yourself. It’s shown only now, and anyone with it can respond.
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

  return (
    <Dialog
      title="Send review check"
      description="They get an email with Approve and Leave feedback, and can pin comments on the files and send files back."
      onClose={onClose}
      width="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        <div
          role="group"
          aria-labelledby={`${ids}-files`}
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
          className={`rounded-lg transition-colors ${dragging ? "bg-accent-50 ring-2 ring-accent-300" : ""}`}
        >
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-xs font-medium text-zinc-700">
              <span id={`${ids}-files`}>Files to review</span>{" "}
              <span className="font-normal text-zinc-400">
                {picked.size} of {MAX_REVIEW_ASSETS} picked
              </span>
            </p>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => void uploadFiles(e.currentTarget.files)}
            />
            <button type="button" onClick={() => fileInput.current?.click()} className="btn-secondary h-7 px-2.5 text-xs">
              <Upload className="size-3.5" aria-hidden />
              Upload files
            </button>
          </div>
          {files.length === 0 && uploads.length === 0 ? (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="mt-1.5 flex w-full flex-col items-center gap-1 rounded-md border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50"
            >
              <Upload className="size-5 text-zinc-400" aria-hidden />
              Drop files here, or click to upload them
              <span className="text-2xs text-zinc-500">They’re attached to the task too (up to {MAX_ATTACHMENT_LABEL} each).</span>
            </button>
          ) : (
            <ul className="mt-1.5 max-h-56 space-y-1 overflow-y-auto rounded-md border border-zinc-200 p-1.5">
              {files.map((f) => {
                const kind = reviewMediaKind(f.fileName, f.contentType);
                const Icon = iconFor(f);
                const full = !picked.has(f.id) && picked.size >= MAX_REVIEW_ASSETS;
                return (
                  <li key={f.id}>
                    <label
                      className={`flex items-center gap-2 rounded px-1.5 py-1 text-sm text-zinc-800 hover:bg-zinc-50 ${full ? "opacity-60" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={picked.has(f.id)}
                        disabled={full}
                        onChange={() => toggle(f.id)}
                        className="size-3.5 accent-accent-600"
                      />
                      <Icon className="size-4 shrink-0 text-zinc-500" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{f.fileName}</span>
                      {kind ? null : <span className="shrink-0 text-2xs text-zinc-400">download only</span>}
                    </label>
                  </li>
                );
              })}
              {uploads.map((u) => (
                <li
                  key={u.key}
                  role={u.error ? "alert" : "status"}
                  className={`flex items-center gap-2 rounded px-1.5 py-1 text-sm ${u.error ? "text-red-700" : "text-zinc-500"}`}
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
          )}
          {files.length > 0 || uploads.length > 0 ? (
            <p className="mt-1 text-2xs text-zinc-500">
              {dragging ? "Drop to upload and attach to the task." : "Drop files here to upload them; they’re attached to the task too."}
            </p>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${ids}-email`} className="text-xs font-medium text-zinc-700">
              Reviewer’s email
            </label>
            <input
              id={`${ids}-email`}
              type="email"
              value={email}
              data-autofocus
              onChange={(e) => setEmail(e.currentTarget.value)}
              placeholder="name@example.com"
              className="field mt-1 h-9 w-full"
            />
            {task.submission?.email && email.trim().toLowerCase() === task.submission.email.toLowerCase() ? (
              <p className="mt-1 text-2xs text-zinc-500">The person who submitted the request</p>
            ) : null}
          </div>
          <div>
            <label htmlFor={`${ids}-name`} className="text-xs font-medium text-zinc-700">
              Their name <span className="font-normal text-zinc-400">(optional)</span>
            </label>
            <input
              id={`${ids}-name`}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.currentTarget.value)}
              className="field mt-1 h-9 w-full"
            />
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
        <div className="flex items-center justify-end gap-2">
          {uploading ? <span className="mr-auto text-xs text-zinc-500">Waiting for uploads to finish…</span> : null}
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={send}
            disabled={pending || uploading || picked.size === 0 || !email.trim()}
            className="btn-primary"
          >
            {pending ? "Sending…" : "Send review check"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
