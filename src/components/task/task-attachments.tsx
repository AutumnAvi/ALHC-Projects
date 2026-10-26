"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Paperclip, Trash2, X } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { deleteAttachment, registerAttachment } from "@/lib/actions";
import { previewKind } from "@/lib/attachment-preview";
import {
  ATTACHMENTS_BUCKET,
  MAX_ATTACHMENT_BYTES,
  attachmentPath,
  formatBytes,
} from "@/lib/attachments";
import type { TaskAttachment, TaskAttachmentLink } from "@/lib/data";
import { createClient } from "@/lib/supabase/client";

// Uploading files to a task: one hidden file input, opened by the pane header's paperclip and the
// Attachments section's "Attach" card. Files go straight to the private bucket, then registerAttachment
// records them (Editors; RLS and the Storage policy decide).
export function useAttachmentUpload(taskId: string) {
  const [, run] = useServerAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList) {
    setError(null);
    const supabase = createClient();
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is larger than 25 MB.`);
        continue;
      }
      setUploading((n) => n + 1);
      const path = attachmentPath(taskId, file.name, crypto.randomUUID());
      const { error: uploadError } = await supabase.storage
        .from(ATTACHMENTS_BUCKET)
        .upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (uploadError) {
        setError(`Couldn’t upload ${file.name}: ${uploadError.message}`);
      } else {
        run(() =>
          registerAttachment({
            taskId,
            storagePath: path,
            fileName: file.name,
            contentType: file.type || null,
            sizeBytes: file.size,
          }),
        );
      }
      setUploading((n) => n - 1);
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      tabIndex={-1}
      aria-hidden
      className="sr-only"
      onChange={(e) => e.currentTarget.files && void upload(e.currentTarget.files)}
    />
  );
  return { input, pick: () => inputRef.current?.click(), uploading, error };
}

export type AttachmentUpload = ReturnType<typeof useAttachmentUpload>;

const CARD = "group relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white transition hover:border-zinc-300 hover:shadow-sm";
const CARD_PREVIEW = "flex h-20 w-full shrink-0 items-center justify-center bg-zinc-50 text-zinc-400";

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot > name.length - 7 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

// The pane's Attachments (Asana parity, batch 3): cards with an image thumbnail (or the file type), the
// name, size, and age; images open in a lightbox, PDFs in the browser's viewer, the rest download.
// Shown once a task has files (the header's paperclip adds the first).
export function TaskAttachments({
  attachments,
  links = [],
  upload,
  canEdit,
}: {
  attachments: TaskAttachment[];
  // Imported attachments that stayed in Asana: name + link only (files aren't copied).
  links?: TaskAttachmentLink[];
  upload: AttachmentUpload;
  canEdit: boolean;
}) {
  const [, run] = useServerAction();
  const confirm = useConfirm();
  // Thumbnails that failed to load (e.g. the route downloaded instead) fall back to the file icon.
  const [brokenIds, setBrokenIds] = useState<ReadonlySet<string>>(() => new Set());
  // Index into `images` of the attachment shown in the lightbox (null = closed).
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const thumbRefs = useRef(new Map<string, HTMLButtonElement>());

  const kinds = new Map(attachments.map((a) => [a.id, previewKind(a.fileName, a.contentType)]));
  const images = attachments.filter((a) => kinds.get(a.id) === "image" && !brokenIds.has(a.id));
  const openImage = lightboxIndex === null ? null : (images[lightboxIndex] ?? null);

  if (attachments.length === 0 && links.length === 0 && upload.uploading === 0 && !upload.error) return null;

  return (
    <section className="mt-6" aria-labelledby="attachments-heading">
      <div className="flex items-baseline justify-between">
        <h3 id="attachments-heading" className="text-sm font-semibold text-zinc-900">
          Attachments
        </h3>
        <span className="text-xs text-zinc-500">Up to 25 MB each</span>
      </div>

      <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2" aria-label="Attached files">
        {attachments.map((attachment) => {
          const kind = kinds.get(attachment.id);
          const thumbnail = kind === "image" && !brokenIds.has(attachment.id);
          return (
            <li key={attachment.id} className={CARD}>
              {thumbnail ? (
                <button
                  type="button"
                  ref={(el) => {
                    if (el) thumbRefs.current.set(attachment.id, el);
                    else thumbRefs.current.delete(attachment.id);
                  }}
                  onClick={() => setLightboxIndex(images.findIndex((a) => a.id === attachment.id))}
                  aria-label={`Preview ${attachment.fileName}`}
                  className={`${CARD_PREVIEW} focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500`}
                >
                  <Thumbnail
                    src={`/attachments/${attachment.id}?preview=1`}
                    onBroken={() => setBrokenIds((prev) => new Set(prev).add(attachment.id))}
                  />
                </button>
              ) : (
                <a
                  href={kind === "pdf" ? `/attachments/${attachment.id}?preview=1` : `/attachments/${attachment.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  tabIndex={-1}
                  aria-hidden
                  className={CARD_PREVIEW}
                >
                  <span className="flex flex-col items-center gap-1">
                    <FileText className="size-6" />
                    <span className="text-2xs font-semibold tracking-wide text-zinc-500">{extensionOf(attachment.fileName)}</span>
                  </span>
                </a>
              )}
              <div className="min-w-0 px-2 py-1.5">
                <a
                  href={kind === "pdf" ? `/attachments/${attachment.id}?preview=1` : `/attachments/${attachment.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={attachment.fileName}
                  className="block truncate text-xs font-medium text-zinc-800 hover:underline"
                >
                  {attachment.fileName}
                </a>
                <p className="truncate text-2xs tabular-nums text-zinc-500">
                  {formatBytes(attachment.sizeBytes)} · <Timestamp iso={attachment.createdAt} />
                </p>
              </div>
              <span className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                <a
                  href={`/attachments/${attachment.id}?download`}
                  aria-label={`Download ${attachment.fileName}`}
                  data-tooltip="Download"
                  className="rounded bg-white/90 p-1 text-zinc-500 shadow-sm hover:text-zinc-900"
                >
                  <Download className="size-3.5" />
                </a>
                {canEdit ? (
                  <button
                    type="button"
                    aria-label={`Remove attachment ${attachment.fileName}`}
                    data-tooltip="Remove"
                    onClick={async () => {
                      if (await confirm({ title: `Remove “${attachment.fileName}” from this task?`, confirmLabel: "Remove", tone: "danger" })) {
                        run(() => deleteAttachment(attachment.id));
                      }
                    }}
                    className="rounded bg-white/90 p-1 text-zinc-500 shadow-sm hover:text-red-600"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
        {links.map((link) => {
          const href = link.attachmentId ? `/attachments/${link.attachmentId}` : link.url;
          const note = link.attachmentId ? "Linked from the original task" : link.source === "asana" ? "In Asana · not copied" : "Link";
          return (
            <li key={link.id} className={CARD}>
              <span className={CARD_PREVIEW} aria-hidden>
                <ExternalLink className="size-6" />
              </span>
              <div className="min-w-0 px-2 py-1.5">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={link.name}
                    className="block truncate text-xs font-medium text-zinc-800 hover:underline"
                  >
                    {link.name}
                  </a>
                ) : (
                  <span title={link.name} className="block truncate text-xs font-medium text-zinc-800">
                    {link.name}
                  </span>
                )}
                <p className="truncate text-2xs text-zinc-500">{note}</p>
              </div>
            </li>
          );
        })}
        {upload.uploading > 0 ? (
          <li className={`${CARD} items-center justify-center p-3 text-xs text-zinc-500`} aria-live="polite">
            Uploading {upload.uploading}…
          </li>
        ) : null}
        {canEdit ? (
          <li className="print:hidden">
            <button
              type="button"
              onClick={upload.pick}
              className="flex h-full min-h-[7.5rem] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-zinc-300 text-xs text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900"
            >
              <Paperclip className="size-4" aria-hidden />
              Attach files
            </button>
          </li>
        ) : null}
      </ul>
      {upload.error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {upload.error}
        </p>
      ) : null}

      {openImage && lightboxIndex !== null ? (
        <ImageLightbox
          image={openImage}
          position={lightboxIndex + 1}
          total={images.length}
          onPrevious={() => setLightboxIndex((i) => (i === null ? i : (i - 1 + images.length) % images.length))}
          onNext={() => setLightboxIndex((i) => (i === null ? i : (i + 1) % images.length))}
          onClose={() => {
            const returnTo = thumbRefs.current.get(openImage.id);
            setLightboxIndex(null);
            returnTo?.focus();
          }}
        />
      ) : null}
    </section>
  );
}

// An image card's thumbnail. A load that failed before the page hydrated never reaches onError, so the
// mount check catches it too; either way the card falls back to the file icon.
export function Thumbnail({ src, onBroken }: { src: string; onBroken: () => void }) {
  const ref = useRef<HTMLImageElement>(null);
  const brokenRef = useRef(onBroken);
  useEffect(() => {
    brokenRef.current = onBroken;
  }, [onBroken]);
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) brokenRef.current();
  }, []);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- auth-gated redirect to a short-lived signed URL; next/image can't optimise it
    <img ref={ref} src={src} alt="" loading="lazy" decoding="async" onError={onBroken} className="size-full object-cover" />
  );
}

const LIGHTBOX_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-200 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white";

// Full-size image viewer: modal dialog over the page (portalled to <body> so the pane's stacking
// context doesn't clip it). Esc / Close closes, ←/→ and the side buttons step through the task's
// images, Tab stays inside. Keys are caught in the capture phase so the pane's own Escape (close
// the pane) and the list shortcuts don't also fire. Also used for a reply's images (comment-parts.tsx).
export function ImageLightbox({
  image,
  position,
  total,
  onPrevious,
  onNext,
  onClose,
}: {
  image: Pick<TaskAttachment, "id" | "fileName">;
  position: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const handlers = useRef({ onPrevious, onNext, onClose });

  useEffect(() => {
    handlers.current = { onPrevious, onNext, onClose };
  }, [onPrevious, onNext, onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onClose();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "ArrowLeft") handlers.current.onPrevious();
        else handlers.current.onNext();
      } else if (e.key === "Tab") {
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!dialog.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
    };
  }, []);

  const several = total > 1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/90" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={several ? `${titleId}-position` : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex h-bar shrink-0 items-center gap-2 px-4 text-sm text-zinc-200">
          <h2 id={titleId} className="min-w-0 flex-1 truncate font-medium text-white">
            {image.fileName}
          </h2>
          {several ? (
            <span id={`${titleId}-position`} className="shrink-0 text-xs tabular-nums text-zinc-400">
              {position} of {total}
            </span>
          ) : null}
          <a
            href={`/attachments/${image.id}?download`}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-zinc-200 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
          >
            <Download className="size-4" aria-hidden />
            Download
          </a>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close preview" className={LIGHTBOX_BUTTON}>
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center gap-2 px-2 pb-4 sm:px-4">
          {several ? (
            <button type="button" onClick={onPrevious} aria-label="Previous image" className={LIGHTBOX_BUTTON}>
              <ChevronLeft className="size-6" aria-hidden />
            </button>
          ) : null}
          <div
            className="flex h-full min-w-0 flex-1 items-center justify-center"
            onMouseDown={(e) => {
              // Clicking the dark area around the image closes, like an overlay.
              if (e.target === e.currentTarget) onClose();
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated redirect to a short-lived signed URL */}
            <img
              key={image.id}
              src={`/attachments/${image.id}?preview=1`}
              alt={image.fileName}
              className="max-h-full max-w-full rounded object-contain"
            />
          </div>
          {several ? (
            <button type="button" onClick={onNext} aria-label="Next image" className={LIGHTBOX_BUTTON}>
              <ChevronRight className="size-6" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
