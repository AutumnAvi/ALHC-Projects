import "server-only";
import { randomUUID } from "node:crypto";
import { ATTACHMENTS_BUCKET, MAX_ATTACHMENT_BYTES, attachmentPath } from "@/lib/attachments";
import type { createAdminClient } from "@/lib/supabase/admin";

// Forward emails to create tasks (Real features 1) and a form submitter's emailed reply (Email designs):
// after post_email_forward() made the task, or post_submitter_reply() posted the reply, the inbound email
// route copies the email's attachments into the task's folder of the private
// task-attachments bucket and records each through attach_forwarded_file() (as the person). Resend's
// webhook only carries attachment metadata; the files come from its Receiving API as short-lived
// download links. Background work of the verified webhook, so the service role is fine here. Nothing
// logs a file name, an address, or a link.

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export const MAX_FORWARDED_ATTACHMENTS = 10;

type ReceivedAttachment = {
  id?: unknown;
  filename?: unknown;
  size?: unknown;
  content_type?: unknown;
  content_disposition?: unknown;
  content_id?: unknown;
  download_url?: unknown;
};

const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

// Inline images (signature logos, tracking pixels) aren't attachments anyone forwarded on purpose.
function isInlineImage(a: ReceivedAttachment): boolean {
  return a.content_disposition === "inline" && typeof a.content_type === "string" && a.content_type.startsWith("image/");
}

async function listAttachments(apiKey: string, emailId: string): Promise<ReceivedAttachment[]> {
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments?limit=100`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
  const body = (await response.json()) as { data?: unknown };
  return Array.isArray(body.data) ? (body.data as ReceivedAttachment[]) : [];
}

type Downloaded = { bytes: ArrayBuffer } | { tooLarge: true } | null;

async function download(url: string): Promise<Downloaded> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), cache: "no-store", redirect: "follow" });
  if (!response.ok) return null;
  if (Number(response.headers.get("content-length") ?? "0") > MAX_ATTACHMENT_BYTES) return { tooLarge: true };
  const bytes = await response.arrayBuffer();
  return bytes.byteLength > MAX_ATTACHMENT_BYTES ? { tooLarge: true } : { bytes };
}

export type SkippedFile = { name: string; reason: "too_large" | "too_many" | "failed" };

// Copies a received email's attachments (up to 10 of 25 MB each; inline images left out) into the task's
// folder and records each through `record` (which returns false when the database refused it; the file
// is then removed again). Returns how many were added and which ones weren't, with why.
export async function copyReceivedAttachments(
  admin: Admin,
  apiKey: string,
  options: {
    emailId: string;
    taskId: string;
    record: (file: { path: string; name: string; type: string | null; size: number }) => Promise<boolean>;
  },
): Promise<{ added: number; skipped: SkippedFile[] }> {
  let added = 0;
  const skipped: SkippedFile[] = [];
  const all = await listAttachments(apiKey, options.emailId);
  const wanted = all.filter((a) => !isInlineImage(a));
  for (const item of wanted) {
    const fileName =
      typeof item.filename === "string" && item.filename.trim() ? item.filename.trim().slice(0, 255) : "attachment";
    if (added >= MAX_FORWARDED_ATTACHMENTS) {
      skipped.push({ name: fileName, reason: "too_many" });
      continue;
    }
    const url = typeof item.download_url === "string" ? item.download_url : null;
    const size = typeof item.size === "number" ? item.size : null;
    if (size !== null && size > MAX_ATTACHMENT_BYTES) {
      skipped.push({ name: fileName, reason: "too_large" });
      continue;
    }
    if (!url || !url.startsWith("https://")) {
      skipped.push({ name: fileName, reason: "failed" });
      continue;
    }
    const contentType =
      typeof item.content_type === "string" && CONTENT_TYPE.test(item.content_type) ? item.content_type.slice(0, 255) : null;
    try {
      const downloaded = await download(url);
      if (!downloaded || "tooLarge" in downloaded) {
        skipped.push({ name: fileName, reason: downloaded ? "too_large" : "failed" });
        continue;
      }
      const path = attachmentPath(options.taskId, fileName, randomUUID());
      const uploaded = await admin.storage
        .from(ATTACHMENTS_BUCKET)
        .upload(path, downloaded.bytes, { contentType: contentType ?? undefined, upsert: false });
      if (uploaded.error) {
        skipped.push({ name: fileName, reason: "failed" });
        continue;
      }
      const recorded = await options.record({ path, name: fileName, type: contentType, size: downloaded.bytes.byteLength });
      if (!recorded) {
        // Not recorded (e.g. the 10-file limit): don't leave the file behind in the task's folder.
        await admin.storage.from(ATTACHMENTS_BUCKET).remove([path]);
        skipped.push({ name: fileName, reason: "failed" });
        continue;
      }
      added += 1;
    } catch {
      skipped.push({ name: fileName, reason: "failed" });
    }
  }
  return { added, skipped };
}

// Forwarded emails: up to 10 attachments, each recorded through attach_forwarded_file (as the person).
export async function copyForwardedAttachments(
  admin: Admin,
  apiKey: string,
  options: { emailId: string; forwardId: string; taskId: string },
): Promise<{ added: number; skipped: number }> {
  const result = await copyReceivedAttachments(admin, apiKey, {
    emailId: options.emailId,
    taskId: options.taskId,
    record: async (file) =>
      !(
        await admin.rpc("attach_forwarded_file", {
          target_forward: options.forwardId,
          file_path: file.path,
          file_name: file.name,
          file_type: file.type,
          file_size: file.size,
        })
      ).error,
  });
  return { added: result.added, skipped: result.skipped.length };
}

// A form submitter's emailed reply (Email designs follow-ups): its files go to the request's task,
// linked to the reply comment (attach_reply_file), and the ones left out are noted on the comment.
export async function copyReplyAttachments(
  admin: Admin,
  apiKey: string,
  options: { emailId: string; commentId: string; taskId: string },
): Promise<{ added: number; skipped: number }> {
  const result = await copyReceivedAttachments(admin, apiKey, {
    emailId: options.emailId,
    taskId: options.taskId,
    record: async (file) =>
      !(
        await admin.rpc("attach_reply_file", {
          target_comment: options.commentId,
          file_path: file.path,
          file_name: file.name,
          file_type: file.type,
          file_size: file.size,
        })
      ).error,
  });
  if (result.skipped.length) {
    await admin.rpc("note_reply_skipped_files", { target_comment: options.commentId, files: result.skipped });
  }
  return { added: result.added, skipped: result.skipped.length };
}
