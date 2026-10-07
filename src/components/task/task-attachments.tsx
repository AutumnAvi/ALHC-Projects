"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Paperclip, Trash2, X } from "lucide-react";
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

export function TaskAttachments({
  taskId,
  attachments,
  links = [],
}: {
  taskId: string;
  attachments: TaskAttachment[];
  // Imported attachments that stayed in Asana: name + link only (files aren't copied).
  links?: TaskAttachmentLink[];
}) {
  const [, run] = useServerAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Thumbnails that failed to load (e.g. the route downloaded instead) fall back to the file icon.
  const [brokenIds, setBrokenIds] = useState<ReadonlySet<string>>(() => new Set());
  // Index into `images` of the attachment shown in the lightbox (null = closed).
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const thumbRefs = useRef(new Map<string, HTMLButtonElement>());

  const kinds = new Map(attachments.map((a) => [a.id, previewKind(a.fileName, a.contentType)]));
  const images = attachments.filter((a) => kinds.get(a.id) === "image" && !brokenIds.has(a.id));
  const openImage = lightboxIndex === null ? null : (images[lightboxIndex] ?? null);

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

  return (
    <section className="mt-6" aria-labelledby="attachments-heading">
      <div className="flex items-baseline justify-between">
        <h3 id="attachments-heading" className="text-sm font-semibold text-zinc-900">
          Attachments
        </h3>
        <span className="text-xs text-zinc-400">Up to 25 MB each</span>
      </div>

      {attachments.length > 0 ? (
        <ul className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-200">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="group flex items-center gap-2.5 px-3 py-2">
              {kinds.get(attachment.id) === "image" && !brokenIds.has(attachment.id) ? (
                <button
                  type="button"
                  ref={(el) => {
                    if (el) thumbRefs.current.set(attachment.id, el);
                    else thumbRefs.current.delete(attachment.id);
                  }}
                  onClick={() => setLightboxIndex(images.findIndex((a) => a.id === attachment.id))}
                  aria-label={`Preview ${attachment.fileName}`}
                  className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated redirect to a short-lived signed URL; next/image can't optimise it */}
                  <img
                    src={`/attachments/${attachment.id}?preview=1`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={40}
                    height={40}
                    onError={() => setBrokenIds((prev) => new Set(prev).add(attachment.id))}
                    className="size-10 rounded-md border border-zinc-200 bg-zinc-50 object-cover"
                  />
                </button>
              ) : (
                <FileText className="size-4 shrink-0 text-zinc-400" aria-hidden />
              )}
              <a
                href={`/attachments/${attachment.id}`}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sm text-zinc-800 hover:underline"
              >
                {attachment.fileName}
              </a>
              {kinds.get(attachment.id) === "pdf" ? (
                <a
                  href={`/attachments/${attachment.id}?preview=1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${attachment.fileName} in a new tab`}
                  className="btn-ghost h-6 px-1.5 text-xs"
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  Open
                </a>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                {formatBytes(attachment.sizeBytes)} · <Timestamp iso={attachment.createdAt} />
              </span>
              <button
                type="button"
                aria-label={`Remove attachment ${attachment.fileName}`}
                onClick={() => {
                  if (window.confirm(`Remove “${attachment.fileName}” from this task?`)) {
                    run(() => deleteAttachment(attachment.id));
                  }
                }}
                className="rounded p-1 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {links.length > 0 ? (
        <ul className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-200" aria-label="Linked attachments">
          {links.map((link) => (
            <li key={link.id} className="flex items-center gap-2.5 px-3 py-2">
              <ExternalLink className="size-4 shrink-0 text-zinc-400" aria-hidden />
              {link.attachmentId ? (
                // A duplicated task's attachment: the original file, through the same access-checked route.
                <a
                  href={`/attachments/${link.attachmentId}`}
                  className="min-w-0 flex-1 truncate text-sm text-zinc-800 hover:underline"
                >
                  {link.name}
                </a>
              ) : link.url ? (
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="min-w-0 flex-1 truncate text-sm text-zinc-800 hover:underline"
                >
                  {link.name}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-800">{link.name}</span>
              )}
              <span className="shrink-0 text-xs text-zinc-400">
                {link.attachmentId ? "Linked from the original task" : link.source === "asana" ? "In Asana · not copied" : "Link"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-within:ring-2 focus-within:ring-accent-100">
        <Paperclip className="size-4" aria-hidden />
        {uploading > 0 ? `Uploading ${uploading}…` : "Attach files"}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => e.currentTarget.files && void upload(e.currentTarget.files)}
        />
      </label>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
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

const LIGHTBOX_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-200 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white";

// Full-size image viewer: modal dialog over the page (portalled to <body> so the pane's stacking
// context doesn't clip it). Esc / Close closes, ←/→ and the side buttons step through the task's
// images, Tab stays inside. Keys are caught in the capture phase so the pane's own Escape (close
// the pane) and the list shortcuts don't also fire.
function ImageLightbox({
  image,
  position,
  total,
  onPrevious,
  onNext,
  onClose,
}: {
  image: TaskAttachment;
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
