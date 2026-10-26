// Which files of a received email to save (Oct 19 notes: a submitter's reply attachments didn't come
// through). Mail apps send pasted and Apple Mail images as inline parts with a Content-ID, and the old
// copier dropped every inline image as a "signature logo", silently — so a reply whose file was an image
// saved nothing and kept the mail app's "[AL_ICON MARK.jpg]" placeholder as its text. Here an inline
// image is left out only when it sits in the quoted part or the signature (referenced there and not in
// what the person wrote), or is a tracking pixel / spacer (under 1 KB, referenced nowhere). Everything
// else is copied, within the limits (10 files, 25 MB each); the rest is noted with why. The placeholders
// of the files we save or note come out of the text before it's posted. Pure (no server imports): the
// inbound route, the copier, and the unit tests share it.
import { MAX_ATTACHMENT_BYTES } from "@/lib/attachments";

export const MAX_RECEIVED_ATTACHMENTS = 10;
// Below this, an inline image referenced nowhere is a tracking pixel or a spacer.
export const MIN_UNREFERENCED_INLINE_IMAGE_BYTES = 1024;

const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

export type ReceivedFile = {
  id: string;
  filename: string;
  contentType: string | null;
  inline: boolean;
  contentId: string | null;
  size: number | null;
};

// Mirrors note_reply_skipped_files' reasons ("blocked_type" since Oct 26 notes, batch 3).
export type SkipReason = "too_large" | "too_many" | "failed" | "blocked_type";
export type SkippedFile = { name: string; reason: SkipReason };
export const SKIP_REASONS: readonly SkipReason[] = ["too_large", "too_many", "failed", "blocked_type"];

// Oct 26 notes (batch 3): files that could run code or a page when opened are never saved from an
// email (programs, scripts, installers, shortcuts, web pages, SVG). Everything else is kept (documents,
// images, video, archives, …); the attachments route still serves only safe types inline.
const BLOCKED_EXTENSIONS = new Set([
  "exe", "msi", "msp", "dll", "com", "scr", "pif", "cpl", "bat", "cmd", "vb", "vbs", "vbe", "js", "jse", "mjs",
  "wsf", "wsh", "hta", "ps1", "psm1", "psd1", "sh", "bash", "zsh", "csh", "ksh", "command", "jar", "apk", "app",
  "dmg", "pkg", "deb", "rpm", "iso", "img", "vhd", "lnk", "url", "reg", "inf", "scf", "msc", "gadget", "html",
  "htm", "xhtml", "shtml", "mht", "mhtml", "svg", "svgz", "php", "py", "pl", "rb", "appx",
  "msix", "xll", "chm",
]);
const BLOCKED_TYPES = /^(application\/(x-msdownload|x-msdos-program|x-dosexec|x-executable|x-sh|x-shellscript|javascript|x-javascript|ecmascript|hta|x-ms-shortcut|xhtml\+xml|x-apple-diskimage|java-archive|vnd\.microsoft\.portable-executable)|text\/(html|javascript|x-sh|x-shellscript)|image\/svg\+xml)$/;

export function unsafeReceivedFile(file: Pick<ReceivedFile, "filename" | "contentType">): boolean {
  const ext = file.filename.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase();
  if (ext && BLOCKED_EXTENSIONS.has(ext)) return true;
  return file.contentType !== null && BLOCKED_TYPES.test(file.contentType);
}

export type ReceivedFilePlan = { copy: ReceivedFile[]; skipped: SkippedFile[]; ignored: ReceivedFile[] };

// Resend's attachment objects (the received email's `attachments`, or the attachments list) → files.
// Entries without an id are dropped.
// Oct 26 notes (batch 3): the attachments list (GET /emails/receiving/{id}/attachments) is the source of
// truth — the retrieved email doesn't always carry its attachments (that's how a reply's pasted image
// went missing and its "[AL_ICON MARK.jpg]" placeholder stayed). Anything the list leaves out about a
// file (its content id, whether it's inline) is filled in from the email's own attachment entries.
export function mergeReceivedFiles(listed: unknown, embedded: unknown): ReceivedFile[] {
  const fromList = normalizeReceivedFiles(listed);
  const fromEmail = normalizeReceivedFiles(embedded);
  if (!fromList.length) return fromEmail;
  const byId = new Map(fromEmail.map((f) => [f.id, f] as const));
  return fromList.map((file) => {
    const other = byId.get(file.id);
    if (!other) return file;
    return {
      ...file,
      filename: file.filename === "attachment" ? other.filename : file.filename,
      contentType: file.contentType ?? other.contentType,
      inline: file.inline || other.inline,
      contentId: file.contentId ?? other.contentId,
      size: file.size ?? other.size,
    };
  });
}

export function normalizeReceivedFiles(raw: unknown): ReceivedFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) return [];
    const filename = typeof o.filename === "string" && o.filename.trim() ? o.filename.trim().slice(0, 255) : "attachment";
    const contentType =
      typeof o.content_type === "string" && CONTENT_TYPE.test(o.content_type) ? o.content_type.toLowerCase().slice(0, 255) : null;
    const contentId =
      typeof o.content_id === "string" && o.content_id.trim() ? o.content_id.trim().replace(/^<|>$/g, "") || null : null;
    const size = typeof o.size === "number" && Number.isFinite(o.size) && o.size >= 0 ? o.size : null;
    return [{ id: o.id, filename, contentType, inline: o.content_disposition === "inline", contentId, size }];
  });
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The placeholders mail apps leave in the text part where a file was: Gmail "[image: NAME]", Apple Mail
// and others "[NAME]" or "<NAME>", Outlook "[cid:CONTENT-ID]".
function placeholders(file: Pick<ReceivedFile, "filename" | "contentId">): string[] {
  const name = escapeRegExp(file.filename);
  const out = [`\\[image:\\s*${name}\\]`, `\\[${name}\\]`, `<${name}>`];
  if (file.contentId) {
    const cid = escapeRegExp(file.contentId);
    out.push(`\\[cid:${cid}\\]`, `<cid:${cid}>`);
  }
  return out;
}

function mentions(text: string, file: Pick<ReceivedFile, "filename" | "contentId">): boolean {
  return new RegExp(placeholders(file).join("|"), "i").test(text);
}

// The cid: references of an HTML body (Resend's ?html_format=cid keeps them), lowercased.
export function cidReferences(html: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const match of (html ?? "").matchAll(/\bsrc\s*=\s*["']?cid:([^"'\s>]+)/gi)) out.add(match[1].toLowerCase());
  return out;
}

// Decides each file: copy, skip (with why), or leave out. `rawText` / `html` are the whole email,
// `keptText` / `keptHtml` what the person wrote (the quote and signature cut); for a forwarded email
// both are the whole email.
export function planReceivedFiles(
  files: ReceivedFile[],
  context: { rawText: string; keptText: string; html?: string | null; keptHtml?: string | null },
  limits: { maxFiles: number; maxBytes: number } = { maxFiles: MAX_RECEIVED_ATTACHMENTS, maxBytes: MAX_ATTACHMENT_BYTES },
): ReceivedFilePlan {
  const plan: ReceivedFilePlan = { copy: [], skipped: [], ignored: [] };
  const allCids = cidReferences(context.html);
  const keptCids = cidReferences(context.keptHtml);
  for (const file of files) {
    if (file.inline && file.contentType?.startsWith("image/")) {
      const cid = file.contentId?.toLowerCase() ?? null;
      const inKept = mentions(context.keptText, file) || (cid !== null && keptCids.has(cid));
      const anywhere = mentions(context.rawText, file) || (cid !== null && allCids.has(cid));
      const pixel = !anywhere && file.size !== null && file.size < MIN_UNREFERENCED_INLINE_IMAGE_BYTES;
      if (!inKept && (anywhere || pixel)) {
        plan.ignored.push(file);
        continue;
      }
    }
    if (unsafeReceivedFile(file)) plan.skipped.push({ name: file.filename, reason: "blocked_type" });
    else if (file.size !== null && file.size > limits.maxBytes) plan.skipped.push({ name: file.filename, reason: "too_large" });
    else if (plan.copy.length >= limits.maxFiles) plan.skipped.push({ name: file.filename, reason: "too_many" });
    else plan.copy.push(file);
  }
  return plan;
}

// The text without the placeholders of these files (only their exact names and content ids, so
// "[other.jpg]" stays), with the spaces and blank lines they leave behind tidied. Since Oct 26 notes
// (batch 3), when an email had inline images, Gmail's "[image: …]" and Outlook's "[cid:…]" forms come out
// whatever name they carry (mail apps don't always use the attachment's own file name there).
export function stripAttachmentPlaceholders(
  body: string,
  files: Pick<ReceivedFile, "filename" | "contentId">[],
  options: { inlineImages?: boolean } = {},
): string {
  if (!files.length && !options.inlineImages) return body;
  const forms = files.flatMap(placeholders);
  if (options.inlineImages) forms.push("\\[image:[^\\]\\n]{0,255}\\]", "\\[cid:[^\\]\\s]{1,255}\\]");
  const pattern = new RegExp(`[ \\t]*(?:${forms.join("|")})`, "gi");
  return body
    .replace(pattern, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A reply that was only files still needs words (a comment can't be empty).
export function attachmentsOnlyBody(count: number): string {
  return count === 1 ? "Sent an attachment." : `Sent ${count} attachments.`;
}

// The files a plan names (copied or noted as not saved): their placeholders come out of the text.
export function plannedFiles(files: ReceivedFile[], plan: ReceivedFilePlan): ReceivedFile[] {
  const ignored = new Set(plan.ignored.map((f) => f.id));
  return files.filter((f) => !ignored.has(f.id));
}

// Whether a plan saves (or notes) an inline image: then generic image placeholders come out too.
export function plansInlineImage(files: ReceivedFile[], plan: ReceivedFilePlan): boolean {
  const ignored = new Set(plan.ignored.map((f) => f.id));
  return files.some((f) => !ignored.has(f.id) && f.contentType?.startsWith("image/") === true);
}
