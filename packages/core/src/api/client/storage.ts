// Big move 1: uploads that go straight from the browser to Supabase Storage (never through a Server
// Action: Vercel caps request bodies, and the Storage policies decide who may put a file where).
// Browser-safe: no Next.js, no server-only; the caller hands in a context over the client it uploads
// with — the person's own browser client for task files, Asana exports, and the workspace logo, the
// cookie-less anon client for public form files and review uploads — and the object path it built.
//
// Each answers { error } with Storage's message (null = stored), like the calls it replaces; a thrown
// network failure is left to the caller, which says so in its own words.
import type { ApiContext } from "../core/context";
import { ATTACHMENTS_BUCKET } from "../../attachments";
import { IMPORTS_BUCKET } from "../../imports-shared";
import { WORKSPACE_ASSETS_BUCKET } from "../../workspace";

export type UploadOutcome = { error: string | null };

async function uploadNew(
  ctx: ApiContext,
  bucket: string,
  path: string,
  file: File,
  contentType: string | undefined,
): Promise<UploadOutcome> {
  const { error } = await ctx.db.storage.from(bucket).upload(path, file, { contentType, upsert: false });
  return { error: error ? error.message : null };
}

// A file for a task, into the private attachments bucket at <task id>/<uuid>-<name> (Editors; the
// Storage policy decides); the caller then records it with registerAttachment.
export async function uploadTaskFile(ctx: ApiContext, path: string, file: File): Promise<UploadOutcome> {
  return uploadNew(ctx, ATTACHMENTS_BUCKET, path, file, file.type || undefined);
}

// An Asana export, into the private `imports` bucket at <project id>/<uploader id>/<uuid>-<name> (own
// folder, Admin+ of the project).
export async function uploadImportFile(ctx: ApiContext, path: string, file: File): Promise<UploadOutcome> {
  return uploadNew(ctx, IMPORTS_BUCKET, path, file, file.type || undefined);
}

// The workspace logo, into the public `workspace-assets` bucket (workspace admins of that folder); the
// caller has already checked it's one of the logo types.
export async function uploadWorkspaceLogo(ctx: ApiContext, path: string, file: File): Promise<UploadOutcome> {
  return uploadNew(ctx, WORKSPACE_ASSETS_BUCKET, path, file, file.type);
}

// A public form submitter's file (Real features 1), uploaded as anon into the response's future task
// folder (<key>/<form id>/<uuid>-<name>); the form-upload Storage policy decides.
export async function uploadFormFile(ctx: ApiContext, path: string, file: File): Promise<UploadOutcome> {
  return uploadNew(ctx, ATTACHMENTS_BUCKET, path, file, file.type || undefined);
}

// A file a reviewer sends back from the public review page (Oct 26 notes, batch 3): to the signed upload
// link the review link's token earned (review_check_upload_start), as anon.
export async function uploadReviewFile(
  ctx: ApiContext,
  path: string,
  uploadToken: string,
  file: File,
): Promise<UploadOutcome> {
  const { error } = await ctx.db.storage
    .from(ATTACHMENTS_BUCKET)
    .uploadToSignedUrl(path, uploadToken, file, { contentType: file.type || undefined });
  return { error: error ? error.message : null };
}
