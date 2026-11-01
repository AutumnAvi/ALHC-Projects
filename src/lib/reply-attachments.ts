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
  const type = file.contentType?.split(";")[0].trim().toLowerCase() ?? null;
  return type !== null && BLOCKED_TYPES.test(type);
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
    // The base type only ("text/html; charset=utf-8" → "text/html"), lowercased.
    const baseType = typeof o.content_type === "string" ? o.content_type.split(";")[0].trim().toLowerCase() : "";
    const contentType = CONTENT_TYPE.test(baseType) ? baseType.slice(0, 255) : null;
    const contentId =
      typeof o.content_id === "string" && o.content_id.trim() ? o.content_id.trim().replace(/^<|>$/g, "") || null : null;
    const size = typeof o.size === "number" && Number.isFinite(o.size) && o.size >= 0 ? o.size : null;
    return [{ id: o.id, filename, contentType, inline: o.content_disposition === "inline", contentId, size }];
  });
}

// Nov 1 notes (batch 8, item 59): names are compared loosely. Mail apps don't always write a file's name
// in the text exactly as the attachment carries it — macOS screenshot names have a narrow no-break space
// (U+202F) before AM/PM, which the text keeps ("[Screenshot … 12.18.36\u202fPM.png]") while the
// attachment's name dropped it ("… 12.18.36PM.png"), so the bracket text stayed in the comment. A name
// matches when the two are equal after Unicode NFKC, ignoring case and every kind of whitespace (spaces,
// no-break / narrow / thin spaces, tabs, zero-width characters).
const LOOSE_IGNORED = /[\s\u00a0\u1680\u180e\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/g;
export function looseName(value: string): string {
  return value.normalize("NFKC").replace(LOOSE_IGNORED, "").toLowerCase();
}

// The placeholders mail apps leave in the text part where a file was: Gmail "[image: NAME]", Apple Mail
// and others "[NAME]" or "<NAME>", Outlook "[cid:CONTENT-ID]". Each match's inner text is compared with
// the files' names / content ids loosely (looseName).
const PLACEHOLDER = /[ \t\u00a0\u202f]*(?:\[\s*image:([^[\]\n]{1,300})\]|\[\s*cid:([^[\]\n]{1,300})\]|<\s*cid:([^<>\n]{1,300})>|\[([^[\]\n]{1,300})\]|<([^<>\n]{1,300})>)/gi;

type Placeholder = { start: number; end: number; kind: "image" | "cid" | "name"; inner: string };

function findPlaceholders(text: string): Placeholder[] {
  const out: Placeholder[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (m[1] !== undefined) out.push({ start, end, kind: "image", inner: m[1] });
    else if (m[2] !== undefined) out.push({ start, end, kind: "cid", inner: m[2] });
    else if (m[3] !== undefined) out.push({ start, end, kind: "cid", inner: m[3] });
    else out.push({ start, end, kind: "name", inner: m[4] ?? m[5] ?? "" });
  }
  return out;
}

type FileKeys = { names: Set<string>; cids: Set<string> };

function fileKeys(files: Pick<ReceivedFile, "filename" | "contentId">[]): FileKeys {
  const names = new Set<string>();
  const cids = new Set<string>();
  for (const file of files) {
    const name = looseName(file.filename);
    if (name) names.add(name);
    if (file.contentId) cids.add(looseName(file.contentId));
  }
  return { names, cids };
}

// Whether this placeholder stands for one of the files: "[image: NAME]" / "[NAME]" / "<NAME>" by name,
// "[cid:ID]" / "<cid:ID>" by content id; with `anyImage`, every "[image: …]" and "[cid:…]" form.
function placeholderMatches(p: Placeholder, keys: FileKeys, anyImage = false): boolean {
  const inner = looseName(p.inner);
  if (!inner) return false;
  if (p.kind === "cid") return anyImage || keys.cids.has(inner);
  if (p.kind === "image") return anyImage || keys.names.has(inner);
  return keys.names.has(inner);
}

function mentions(text: string, file: Pick<ReceivedFile, "filename" | "contentId">): boolean {
  const keys = fileKeys([file]);
  return findPlaceholders(text).some((p) => placeholderMatches(p, keys));
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

// The text without the placeholders of these files (their names and content ids, compared loosely —
// looseName — so "[other.jpg]" stays), with the spaces and blank lines they leave behind tidied. Since
// Oct 26 notes (batch 3), when an email had inline images, Gmail's "[image: …]" and Outlook's "[cid:…]"
// forms come out whatever name they carry (mail apps don't always use the attachment's own file name there).
export function stripAttachmentPlaceholders(
  body: string,
  files: Pick<ReceivedFile, "filename" | "contentId">[],
  options: { inlineImages?: boolean } = {},
): string {
  if (!files.length && !options.inlineImages) return body;
  const keys = fileKeys(files);
  let out = "";
  let last = 0;
  for (const p of findPlaceholders(body)) {
    if (!placeholderMatches(p, keys, options.inlineImages === true)) continue;
    out += body.slice(last, p.start);
    last = p.end;
  }
  out += body.slice(last);
  return out
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

// Whether a plan saves (or notes) an inline image (one shown in the body: inline, or with a content id):
// then generic image placeholders come out too.
export function plansInlineImage(files: ReceivedFile[], plan: ReceivedFilePlan): boolean {
  const ignored = new Set(plan.ignored.map((f) => f.id));
  return files.some(
    (f) => !ignored.has(f.id) && (f.inline || f.contentId !== null) && f.contentType?.startsWith("image/") === true,
  );
}
