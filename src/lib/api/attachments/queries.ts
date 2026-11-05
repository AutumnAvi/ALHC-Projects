// Big move 1: the attachments area's reads — task attachments' metadata and the private task-attachments
// bucket (Storage reads are data access too). Every function reads only through ctx.db, so the caller's
// own client decides what it sees: the person's session (RLS, and Storage's own policies on the bucket),
// or — for the public review page only — the service role signing a link to exactly the object the
// database returned for the link's token. No Next.js here.
import type { AttachmentFileRow, StoredFile } from "@/lib/api/attachments/model";
import type { ApiContext } from "@/lib/api/core/context";
import { previewKind } from "@/lib/attachment-preview";
import { ATTACHMENTS_BUCKET } from "@/lib/attachments";
import { reviewMediaKind } from "@/lib/review-checks";

// ---------------------------------------------------------------------------------------------
// Metadata rows
// ---------------------------------------------------------------------------------------------

// An attachment's file (RLS: Viewer+ on the task), not removed. Null when it's missing, unreadable, or the
// read failed (the route answers 404 for all of them).
export async function getAttachmentFile(ctx: ApiContext, attachmentId: string): Promise<StoredFile | null> {
  const { data: attachment, error } = await ctx.db
    .from("task_attachments")
    .select("storage_path, file_name, content_type")
    .eq("id", attachmentId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !attachment) return null;
  return { storagePath: attachment.storage_path, fileName: attachment.file_name, contentType: attachment.content_type };
}

// These attachments' files, read through RLS (unreadable ones simply aren't there; a failed read = none).
export async function listAttachmentFiles(ctx: ApiContext, attachmentIds: string[]): Promise<AttachmentFileRow[]> {
  const { data } = await ctx.db
    .from("task_attachments")
    .select("id, file_name, content_type, storage_path, size_bytes")
    .in("id", attachmentIds);
  return data ?? [];
}

// ---------------------------------------------------------------------------------------------
// The private bucket
// ---------------------------------------------------------------------------------------------

// The content type Storage will serve the object with (null when it can't be read).
export async function storedContentType(ctx: ApiContext, objectPath: string): Promise<string | null> {
  const { data: info, error } = await ctx.db.storage.from(ATTACHMENTS_BUCKET).info(objectPath);
  const storedType = info?.contentType;
  if (error || !storedType) return null;
  return storedType;
}

// A signed link to one object (null when Storage refuses it).
export async function signedObjectUrl(
  ctx: ApiContext,
  objectPath: string,
  seconds: number,
  options?: { download?: string },
): Promise<string | null> {
  const { data, error } = await ctx.db.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(objectPath, seconds, options);
  return error || !data?.signedUrl ? null : data.signedUrl;
}

// One object's bytes (null when it can't be read).
export async function downloadObject(ctx: ApiContext, objectPath: string): Promise<Blob | null> {
  const { data, error } = await ctx.db.storage.from(ATTACHMENTS_BUCKET).download(objectPath);
  return error || !data ? null : data;
}

// A link that opens a file in the browser when that's safe, else downloads it under its own name:
// `download` = always a download; `media` = videos play too (reviewMediaKind), else only previewable files
// (previewKind: PNG, JPEG, GIF, WebP, PDF). Null when Storage won't sign it.
export async function signedFileUrl(
  ctx: ApiContext,
  file: StoredFile,
  options: { download: boolean; media: boolean; seconds: number },
): Promise<string | null> {
  const inline = !options.download && (await servableInline(ctx, file, options.media));
  return signedObjectUrl(ctx, file.storagePath, options.seconds, { download: inline ? undefined : file.fileName });
}

// Inline only when the file name, the recorded content type, the storage path, and the content type
// Storage will actually serve all agree on a previewable kind. The name and recorded type come from
// the uploader's browser, so the stored object's own type is checked too; any doubt means download.
async function servableInline(ctx: ApiContext, file: StoredFile, media: boolean): Promise<boolean> {
  const kindOf = media ? reviewMediaKind : previewKind;
  const kind = kindOf(file.fileName, file.contentType);
  if (!kind || kindOf(file.storagePath, file.contentType) !== kind) return false;
  const storedType = await storedContentType(ctx, file.storagePath);
  if (!storedType) return false;
  return kindOf(file.storagePath, storedType) === kind;
}
