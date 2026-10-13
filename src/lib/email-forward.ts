import "server-only";
import { randomUUID } from "node:crypto";
import { ATTACHMENTS_BUCKET, MAX_ATTACHMENT_BYTES, attachmentPath } from "@/lib/attachments";
import type { createAdminClient } from "@/lib/supabase/admin";

// Forward emails to create tasks (Real features 1): after post_email_forward() made the task, the
// inbound email route copies the email's attachments into the task's folder of the private
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

async function download(url: string): Promise<ArrayBuffer | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), cache: "no-store", redirect: "follow" });
  if (!response.ok) return null;
  if (Number(response.headers.get("content-length") ?? "0") > MAX_ATTACHMENT_BYTES) return null;
  const bytes = await response.arrayBuffer();
  return bytes.byteLength > MAX_ATTACHMENT_BYTES ? null : bytes;
}

// Copies up to 10 attachments (25 MB each, inline images skipped) and returns how many were added.
export async function copyForwardedAttachments(
  admin: Admin,
  apiKey: string,
  options: { emailId: string; forwardId: string; taskId: string },
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  const all = await listAttachments(apiKey, options.emailId);
  const wanted = all.filter((a) => !isInlineImage(a));
  skipped += all.length - wanted.length;
  for (const item of wanted) {
    if (added >= MAX_FORWARDED_ATTACHMENTS) {
      skipped += 1;
      continue;
    }
    const url = typeof item.download_url === "string" ? item.download_url : null;
    const size = typeof item.size === "number" ? item.size : null;
    if (!url || !url.startsWith("https://") || (size !== null && size > MAX_ATTACHMENT_BYTES)) {
      skipped += 1;
      continue;
    }
    const fileName =
      typeof item.filename === "string" && item.filename.trim() ? item.filename.trim().slice(0, 255) : "attachment";
    const contentType =
      typeof item.content_type === "string" && CONTENT_TYPE.test(item.content_type) ? item.content_type.slice(0, 255) : null;
    try {
      const bytes = await download(url);
      if (!bytes) {
        skipped += 1;
        continue;
      }
      const path = attachmentPath(options.taskId, fileName, randomUUID());
      const uploaded = await admin.storage
        .from(ATTACHMENTS_BUCKET)
        .upload(path, bytes, { contentType: contentType ?? undefined, upsert: false });
      if (uploaded.error) {
        skipped += 1;
        continue;
      }
      const recorded = await admin.rpc("attach_forwarded_file", {
        target_forward: options.forwardId,
        file_path: path,
        file_name: fileName,
        file_type: contentType,
        file_size: bytes.byteLength,
      });
      if (recorded.error) {
        // Not recorded (e.g. the 10-file limit): don't leave the file behind in the task's folder.
        await admin.storage.from(ATTACHMENTS_BUCKET).remove([path]);
        skipped += 1;
        continue;
      }
      added += 1;
    } catch {
      skipped += 1;
    }
  }
  return { added, skipped };
}
