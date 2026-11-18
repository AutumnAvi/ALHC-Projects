"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, SquareCheck, X } from "lucide-react";
import { useClosesPopovers } from "@/components/overlay-registry";
import { FileTypeIcon } from "@/components/task/file-type-icon";
import { formatBytes } from "@alhc/core/attachments";
import { reviewMediaKind } from "@alhc/core/review-checks";

// Nov 18 notes (batch 44, item 7): a file opens right where it's clicked, in an overlay over the page —
// never a new tab. Images, PDFs (the browser's own viewer), and videos (the browser's player) show
// inline through the same RLS-checked /attachments/<id> route as everywhere else; any other file gets a
// card with its name, size, and a Download button. ← / → move between the files, Esc closes, and focus
// goes back to whatever opened it.

export type PreviewFile = {
  id: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number | null;
  // Where the file belongs (the Files page: its task), shown as a link in the header.
  context?: { label: string; href: string } | null;
};

// The app's own route for every file (RLS-checked, short-lived signed links).
const fileUrl = (id: string, mode: "preview" | "media" | "download") =>
  mode === "download" ? `/attachments/${id}?download` : mode === "media" ? `/attachments/${id}?media=1` : `/attachments/${id}?preview=1`;

const BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-200 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white";

// Which way an arrow key moves through `total` files from `index` (wrapping), or null for other keys.
export function previewStep(key: string, index: number, total: number): number | null {
  if (total < 2) return null;
  if (key === "ArrowLeft") return (index - 1 + total) % total;
  if (key === "ArrowRight") return (index + 1) % total;
  return null;
}

export function FilePreviewOverlay({
  files,
  index,
  onIndex,
  onClose,
}: {
  files: PreviewFile[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const handlers = useRef({ onIndex, onClose, index, total: files.length });
  useEffect(() => {
    handlers.current = { onIndex, onClose, index, total: files.length };
  });
  useClosesPopovers();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onClose();
        return;
      }
      // A focused video keeps its own arrow keys (seeking).
      if (e.target instanceof HTMLVideoElement) return;
      const next = previewStep(e.key, handlers.current.index, handlers.current.total);
      if (next !== null) {
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onIndex(next);
        return;
      }
      if (e.key === "Tab") {
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), video[controls]"));
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
      opener?.focus({ preventScroll: true });
    };
  }, []);

  const file = files[Math.min(Math.max(index, 0), files.length - 1)];
  if (!file) return null;
  const several = files.length > 1;
  const kind = reviewMediaKind(file.fileName, file.contentType);

  return createPortal(
    <div className="ui-anim-fade-in fixed inset-0 z-50 flex flex-col bg-zinc-950/90" onMouseDown={onClose} data-file-preview="">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={several ? `${titleId}-position` : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex h-bar shrink-0 items-center gap-2 px-3 text-sm text-zinc-200 sm:px-4">
          <FileTypeIcon fileName={file.fileName} contentType={file.contentType} className="size-4 shrink-0 text-zinc-400" />
          <h2 id={titleId} className="min-w-0 flex-1 truncate font-medium text-white">
            {file.fileName}
          </h2>
          {several ? (
            <span id={`${titleId}-position`} className="shrink-0 text-xs tabular-nums text-zinc-400" aria-live="polite">
              {index + 1} of {files.length}
            </span>
          ) : null}
          {file.context ? (
            <Link
              href={file.context.href}
              onClick={onClose}
              className="hidden h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 text-zinc-200 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white sm:inline-flex"
              data-tooltip="Open the task"
            >
              <SquareCheck className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{file.context.label}</span>
            </Link>
          ) : null}
          <a
            href={fileUrl(file.id, "download")}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-zinc-200 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
          >
            <Download className="size-4" aria-hidden />
            <span className="max-sm:sr-only">Download</span>
          </a>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close preview" data-tooltip="Close (Esc)" className={BUTTON}>
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center gap-1 px-1 pb-3 sm:gap-2 sm:px-4 sm:pb-4">
          {several ? (
            <button type="button" onClick={() => onIndex((index - 1 + files.length) % files.length)} aria-label="Previous file" data-tooltip="Previous (←)" className={BUTTON}>
              <ChevronLeft className="size-6" aria-hidden />
            </button>
          ) : null}
          <div
            className="flex h-full min-w-0 flex-1 items-center justify-center"
            onMouseDown={(e) => {
              // The dark area around the file closes, like an overlay.
              if (e.target === e.currentTarget) onClose();
            }}
            data-file-preview-kind={kind ?? "other"}
          >
            <PreviewBody
              key={file.id}
              file={file}
              kind={kind}
              // A click in a PDF gives the browser's viewer (another document) the keys, so Esc and the arrows
              // wouldn't reach the overlay; once the pointer leaves the PDF they come back here.
              onLeaveFrame={(frame) => {
                if (document.activeElement === frame) closeRef.current?.focus({ preventScroll: true });
              }}
            />
          </div>
          {several ? (
            <button type="button" onClick={() => onIndex((index + 1) % files.length)} aria-label="Next file" data-tooltip="Next (→)" className={BUTTON}>
              <ChevronRight className="size-6" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PreviewBody({
  file,
  kind,
  onLeaveFrame,
}: {
  file: PreviewFile;
  kind: ReturnType<typeof reviewMediaKind>;
  onLeaveFrame: (frame: HTMLIFrameElement) => void;
}) {
  const [broken, setBroken] = useState(false);
  if (kind === "image" && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- auth-gated redirect to a short-lived signed URL
      <img
        src={fileUrl(file.id, "preview")}
        alt={file.fileName}
        onError={() => setBroken(true)}
        className="max-h-full max-w-full rounded object-contain"
      />
    );
  }
  if (kind === "pdf") {
    return (
      <iframe
        title={file.fileName}
        src={fileUrl(file.id, "preview")}
        // Out of the Tab order (Tab stays on the overlay's controls); a click still scrolls and zooms it.
        tabIndex={-1}
        onMouseLeave={(e) => onLeaveFrame(e.currentTarget)}
        className="h-full w-full max-w-5xl rounded bg-white"
      />
    );
  }
  if (kind === "video" && !broken) {
    return (
      <video
        src={fileUrl(file.id, "media")}
        controls
        playsInline
        onError={() => setBroken(true)}
        className="max-h-full max-w-full rounded bg-black"
      />
    );
  }
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg bg-white px-6 py-8 text-center shadow-xl" data-file-preview-card="">
      <span className="inline-flex size-14 items-center justify-center rounded-xl bg-zinc-100 text-zinc-500">
        <FileTypeIcon fileName={file.fileName} contentType={file.contentType} className="size-7" />
      </span>
      <div className="min-w-0 max-w-full">
        <p className="truncate text-sm font-semibold text-zinc-900" title={file.fileName}>
          {file.fileName}
        </p>
        <p className="mt-0.5 text-xs text-zinc-500">
          {file.sizeBytes !== null ? formatBytes(file.sizeBytes) : null}
          {file.sizeBytes !== null ? " · " : ""}
          {broken ? "This file couldn’t be shown here." : "No preview for this kind of file."}
        </p>
      </div>
      <a href={fileUrl(file.id, "download")} className="btn-primary h-9 px-4">
        <Download className="size-4" aria-hidden />
        Download
      </a>
    </div>
  );
}
