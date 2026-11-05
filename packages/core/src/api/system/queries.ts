// Big move 1: the background work's reads (packages/core/src/api/system/). Called with the context the adapter
// chose — the service role in the outbox drains and the cron route — and never to serve a person's
// request. No Next.js here.
import type { ApiContext } from "../core/context";
import type {
  ApprovalRoundFile,
  DbAnswer,
  DigestEmailContents,
  StorageListEntry,
} from "./model";
import { ATTACHMENTS_BUCKET } from "../../attachments";
import { isUuid } from "../../ids";
import { thumbnailPath } from "../../review-thumbnail-shared";

// The workspace's email sender name (Settings → Workspace → Email); null when unset or unreadable.
export async function emailSenderName(ctx: ApiContext): Promise<string | null> {
  const { data } = await ctx.db
    .from("workspaces")
    .select("email_sender_name")
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  return data?.email_sender_name ?? null;
}

// The reply thread's token for a response to a form's submitter (submitter_reply_token, service role);
// null when there is none or the database refused.
export async function submitterReplyToken(ctx: ApiContext, emailId: string): Promise<string | null> {
  const { data, error } = await ctx.db.rpc("submitter_reply_token", { target_email: emailId });
  return error || typeof data !== "string" ? null : data;
}

// A digest's items and tasks, read now with the recipient's own access.
export async function digestEmailContents(ctx: ApiContext, emailId: string): Promise<DigestEmailContents> {
  const [items, tasks] = await Promise.all([
    ctx.db.rpc("digest_email_items", { target_email: emailId }),
    ctx.db.rpc("digest_email_tasks", { target_email: emailId }),
  ]);
  if (items.error) return { failed: "items" };
  // Nov 1 notes (batch 11): the tasks due or overdue (none on a database without the update).
  if (tasks.error && tasks.error.code !== "PGRST202") return { failed: "tasks" };
  return { items: items.data ?? [], tasks: tasks.error ? [] : (tasks.data ?? []) };
}

// The email's design context (email_design_context, service role): null when the database can't say (a
// database without the email designs update) or answered something that isn't an object.
export async function emailDesignContext(ctx: ApiContext, emailId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await ctx.db.rpc("email_design_context", { target_email: emailId });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

// Nov 4 notes (batch 25, 160): the files of the round an approval request is about — the approval's
// round's files on that task, in the round's order — and for the first `signFirst` only an already-drawn
// thumbnail (never the file itself) signed for `expiresIn` seconds.
export async function approvalRoundFiles(
  ctx: ApiContext,
  approvalId: string,
  options: { signFirst: number; expiresIn: number },
): Promise<ApprovalRoundFile[]> {
  const admin = ctx.db;
  const request = await admin.from("approval_requests").select("task_id, round_id").eq("id", approvalId).maybeSingle();
  const roundId = request.data?.round_id;
  if (!request.data || !roundId) return [];
  const round = await admin.from("approval_rounds").select("task_id, attachment_ids").eq("id", roundId).maybeSingle();
  if (!round.data || round.data.task_id !== request.data.task_id) return [];
  const taskId = round.data.task_id;
  const ids = (round.data.attachment_ids ?? []).filter(isUuid);
  if (ids.length === 0) return [];
  const files = await admin
    .from("task_attachments")
    .select("id, file_name, content_type")
    .in("id", ids)
    .eq("task_id", taskId)
    .is("deleted_at", null);
  const byId = new Map((files.data ?? []).map((f) => [f.id, f] as const));
  const ordered = ids.flatMap((id) => {
    const f = byId.get(id);
    return f ? [f] : [];
  });
  return await Promise.all(
    ordered.map(async (f, i) => {
      // Only the first ones the email shows are signed.
      const signed =
        i < options.signFirst
          ? await admin.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(thumbnailPath(taskId, f.id), options.expiresIn)
          : null;
      return {
        id: f.id,
        fileName: f.file_name,
        contentType: f.content_type,
        signedUrl: signed && !signed.error ? (signed.data?.signedUrl ?? null) : null,
      };
    }),
  );
}

// Public form uploads no response kept, a day after they were uploaded (list_stale_form_uploads,
// service role).
export async function listStaleFormUploads(ctx: ApiContext, max: number): Promise<DbAnswer<string[]>> {
  return await ctx.db.rpc("list_stale_form_uploads", { max_items: max });
}

// One page of a Storage folder's listing; null when Storage refused.
export async function listStorageFolderPage(
  ctx: ApiContext,
  bucket: string,
  folder: string,
  page: { limit: number; offset: number },
): Promise<StorageListEntry[] | null> {
  const { data, error } = await ctx.db.storage.from(bucket).list(folder, { limit: page.limit, offset: page.offset });
  if (error) return null;
  return data ?? [];
}
