"use client";

import { useRef, useState } from "react";
import { FileText, Image as ImageIcon, Paperclip, Video } from "lucide-react";
import { Thumbnail } from "@/components/task/task-attachments";
import { registerAttachment } from "@/lib/actions/comments";
import { previewKind } from "@/lib/attachment-preview";
import { uploadTaskFile } from "@/lib/api/client/storage";
import { createApiContext } from "@/lib/api/core/context";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_LABEL, attachmentPath } from "@/lib/attachments";
import { reviewMediaKind } from "@/lib/review-checks";
import { createClient } from "@/lib/supabase/client";

// Files picked in a dialog — Send review check (Oct 26 notes, batch 3) and, since Nov 2 notes (batch 15,
// 113), Ready for approval's "Files to approve": thumbnail cards with a tick box, and uploads made right
// there (attached to the task like any upload: the private bucket, then registerAttachment).

export type PickableFile = { id: string; fileName: string; contentType: string | null };
// A file being uploaded from the dialog (or one that couldn't be).
export type FileUpload = { key: string; name: string; error: string | null };

// Uploads files to the task one at a time, in the order picked; `onAttached` gets each attached file.
export function useTaskFileUploads(taskId: string, onAttached: (file: PickableFile) => void) {
  const [uploads, setUploads] = useState<FileUpload[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  async function uploadFiles(list: FileList | File[] | null) {
    const chosen = Array.from(list ?? []);
    if (fileInput.current) fileInput.current.value = "";
    if (!chosen.length) return;
    const ctx = createApiContext(createClient());
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
      const path = attachmentPath(taskId, file.name, crypto.randomUUID());
      const stored = await uploadTaskFile(ctx, path, file);
      if (stored.error !== null) {
        fail("Couldn’t upload. Try again.");
        continue;
      }
      const registered = await registerAttachment({
        taskId,
        storagePath: path,
        fileName: file.name,
        contentType: file.type || null,
        sizeBytes: file.size,
      });
      if (registered.error || !registered.attachmentId) {
        fail(registered.error ?? "Couldn’t attach it to the task");
        continue;
      }
      onAttached({ id: registered.attachmentId, fileName: file.name, contentType: file.type || null });
      setUploads((current) => current.filter((u) => u.key !== key));
    }
  }

  const dismiss = (key: string) => setUploads((current) => current.filter((u) => u.key !== key));
  return { uploads, uploadFiles, dismiss, fileInput, uploading: uploads.some((u) => !u.error) };
}

export function FileKindIcon({ file }: { file: PickableFile }) {
  const kind = reviewMediaKind(file.fileName, file.contentType);
  const className = "size-6";
  if (kind === "image") return <ImageIcon className={className} aria-hidden />;
  if (kind === "video") return <Video className={className} aria-hidden />;
  if (kind === "pdf") return <FileText className={className} aria-hidden />;
  return <Paperclip className={className} aria-hidden />;
}

// One file in "Files attached to this task": a thumbnail (images) or a type tile, a tick box to pick it,
// and its name. Clicking the preview opens images in the pane's lightbox and PDFs / videos in the
// browser's viewer (the same /attachments routes the pane uses); other files have no preview.
export function PickableFileCard({
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
