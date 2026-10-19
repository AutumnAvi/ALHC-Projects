import "server-only";
import { randomUUID } from "node:crypto";
import { ATTACHMENTS_BUCKET, MAX_ATTACHMENT_BYTES, attachmentPath } from "@/lib/attachments";
import { MAX_RECEIVED_ATTACHMENTS, type ReceivedFile, type ReceivedFilePlan, type SkippedFile } from "@/lib/reply-attachments";
import { safeDownload } from "@/lib/safe-fetch";
import type { createAdminClient } from "@/lib/supabase/admin";

// Forward emails to create tasks (Real features 1) and a form submitter's emailed reply (Email designs):
// after post_email_forward() made the task, or post_submitter_reply() posted the reply, the inbound email
// route copies the email's attachments into the task's folder of the private
// task-attachments bucket and records each through attach_forwarded_file() (as the person) or
// attach_reply_file() (on the reply comment). Which files is planReceivedFiles()'s call (reply-attachments.ts:
// since Oct 19 notes pasted / Apple Mail inline images are saved too). Resend's webhook only carries
// attachment metadata; the files come from its Receiving API as signed download links valid for an hour.
// Background work of the verified webhook, so the service role is fine here. Nothing logs a file name,
// an address, or a link.

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export const MAX_FORWARDED_ATTACHMENTS = MAX_RECEIVED_ATTACHMENTS;
export type { SkippedFile };

const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+$/;
// Downloads at a time (each up to 25 MB, 30 seconds).
const CONCURRENCY = 3;

type Download = { ok: true; bytes: Uint8Array; contentType: string | null } | { ok: false; tooLarge: boolean };

// How the copier reaches Resend and the files: the Receiving API with the key; each file's signed
// download_url (valid for an hour) without it — the key never goes to the file host. Tests pass fakes.
export type ReceivedFileSource = {
  // The attachments list (id → download_url).
  list: (emailId: string) => Promise<unknown[]>;
  // One attachment again, for a fresh download_url when the first one failed (e.g. expired).
  refresh: (emailId: string, attachmentId: string) => Promise<string | null>;
  download: (url: string) => Promise<Download>;
};

export function resendFileSource(apiKey: string): ReceivedFileSource {
  const api = async (path: string) => {
    const response = await fetch(`https://api.resend.com/emails/receiving/${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Resend returned ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };
  return {
    list: async (emailId) => {
      const body = await api(`${encodeURIComponent(emailId)}/attachments?limit=100`);
      return Array.isArray(body.data) ? body.data : [];
    },
    refresh: async (emailId, attachmentId) => {
      const body = await api(`${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`).catch(() => null);
      return typeof body?.download_url === "string" ? body.download_url : null;
    },
    download: async (url) => {
      // https only, guarded lookup (no private addresses), no credentials, stops reading past 25 MB. A
      // refused address, a timeout, or a dropped connection is a failed download.
      const result = await safeDownload(url, { timeoutMs: 30_000, maxBytes: MAX_ATTACHMENT_BYTES }).catch(() => null);
      if (!result) return { ok: false, tooLarge: false };
      return result.ok ? { ok: true, bytes: result.bytes, contentType: result.contentType } : { ok: false, tooLarge: result.tooLarge };
    },
  };
}

function downloadUrls(listed: unknown[]): Map<string, string> {
  const urls = new Map<string, string>();
  for (const item of listed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id === "string" && typeof o.download_url === "string") urls.set(o.id, o.download_url);
  }
  return urls;
}

// Copies the files a plan (planReceivedFiles) says to copy into the task's folder of the private
// task-attachments bucket and records each through `record` (false = the database refused it; the file
// is then removed again). Returns how many were added and every file that wasn't, with why (the plan's
// own skips first).
export async function copyReceivedAttachments(
  admin: Admin,
  source: ReceivedFileSource,
  options: {
    emailId: string;
    taskId: string;
    plan: ReceivedFilePlan;
    record: (file: { path: string; name: string; type: string | null; size: number }) => Promise<boolean>;
  },
): Promise<{ added: number; skipped: SkippedFile[] }> {
  const failed: SkippedFile[] = [];
  let added = 0;
  if (!options.plan.copy.length) return { added, skipped: [...options.plan.skipped] };
  const urls = downloadUrls(await source.list(options.emailId));

  async function copyOne(file: ReceivedFile): Promise<SkippedFile["reason"] | null> {
    let url = urls.get(file.id) ?? (await source.refresh(options.emailId, file.id));
    if (!url) return "failed";
    let downloaded = await source.download(url);
    if (!downloaded.ok && !downloaded.tooLarge) {
      // An expired or refused link: ask Resend for a fresh one, once.
      url = await source.refresh(options.emailId, file.id);
      if (url) downloaded = await source.download(url);
    }
    if (!downloaded.ok) return downloaded.tooLarge ? "too_large" : "failed";
    const headerType = downloaded.contentType?.split(";")[0].trim().toLowerCase() ?? null;
    const type = file.contentType ?? (headerType && CONTENT_TYPE.test(headerType) ? headerType : null);
    const path = attachmentPath(options.taskId, file.filename, randomUUID());
    const uploaded = await admin.storage
      .from(ATTACHMENTS_BUCKET)
      .upload(path, downloaded.bytes, { contentType: type ?? undefined, upsert: false });
    if (uploaded.error) return "failed";
    if (!(await options.record({ path, name: file.filename, type, size: downloaded.bytes.byteLength }))) {
      // Not recorded (e.g. the 10-file limit): don't leave the file behind in the task's folder.
      await admin.storage.from(ATTACHMENTS_BUCKET).remove([path]);
      return "failed";
    }
    return null;
  }

  const queue = [...options.plan.copy];
  async function worker() {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const reason = await copyOne(file).catch(() => "failed" as const);
      if (reason) failed.push({ name: file.filename, reason });
      else added += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return { added, skipped: [...options.plan.skipped, ...failed] };
}

// Forwarded emails: up to 10 attachments, each recorded through attach_forwarded_file (as the person).
export async function copyForwardedAttachments(
  admin: Admin,
  source: ReceivedFileSource,
  options: { emailId: string; forwardId: string; taskId: string; plan: ReceivedFilePlan },
): Promise<{ added: number; skipped: number }> {
  const result = await copyReceivedAttachments(admin, source, {
    emailId: options.emailId,
    taskId: options.taskId,
    plan: options.plan,
    record: async (file) => {
      const { error } = await admin.rpc("attach_forwarded_file", {
        target_forward: options.forwardId,
        file_path: file.path,
        file_name: file.name,
        file_type: file.type,
        file_size: file.size,
      });
      if (error) console.error("Forwarded email: attach_forwarded_file refused", error.code);
      return !error;
    },
  });
  return { added: result.added, skipped: result.skipped.length };
}

// A form submitter's emailed reply: its files go to the request's task, linked to the reply comment
// (attach_reply_file), and the ones left out are noted on the comment (note_reply_skipped_files) — the
// plan's skips right away, so they show even if this work is cut short, then any that failed.
export async function copyReplyAttachments(
  admin: Admin,
  source: ReceivedFileSource,
  options: { emailId: string; commentId: string; taskId: string; plan: ReceivedFilePlan },
): Promise<{ added: number; skipped: number }> {
  const note = async (files: SkippedFile[]) => {
    const { error } = await admin.rpc("note_reply_skipped_files", { target_comment: options.commentId, files });
    if (error) console.error("Reply by email: note_reply_skipped_files refused", error.code);
  };
  if (options.plan.skipped.length) await note(options.plan.skipped);
  const result = await copyReceivedAttachments(admin, source, {
    emailId: options.emailId,
    taskId: options.taskId,
    plan: options.plan,
    record: async (file) => {
      const { error } = await admin.rpc("attach_reply_file", {
        target_comment: options.commentId,
        file_path: file.path,
        file_name: file.name,
        file_type: file.type,
        file_size: file.size,
      });
      if (error) console.error("Reply by email: attach_reply_file refused", error.code);
      return !error;
    },
  });
  if (result.skipped.length > options.plan.skipped.length) await note(result.skipped);
  return { added: result.added, skipped: result.skipped.length };
}
