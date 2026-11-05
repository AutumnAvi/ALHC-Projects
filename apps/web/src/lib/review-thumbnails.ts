import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import { uploadObject } from "@alhc/core/api/attachments/mutations";
import { downloadObject, signedObjectUrl } from "@alhc/core/api/attachments/queries";
import type { ApiContext } from "@alhc/core/api/core/context";
import { MAX_ATTACHMENT_BYTES } from "@alhc/core/attachments";
import { reviewMediaKind } from "@alhc/core/review-checks";
import { THUMBNAIL_BUDGET_MS, thumbnailPath, type ReviewThumbnail } from "@alhc/core/review-thumbnail-shared";

// Oct 27 notes (batch 5): thumbnails for the review check email — an image, or a PDF's first page, drawn
// on the server as a JPEG (about 1,200 px wide since Nov 1 notes, batch 8) and stored next to the file in
// the private task-attachments bucket at <task id>/thumb-<attachment id>.jpg (two path segments, so the
// task's Viewers+ read it like any of its files and Editors+ write it). Everything goes through the
// signed-in Editor's own context (the data-access layer's Storage calls with their own Supabase client),
// never the service role; the email gets a signed link that lasts
// as long as the review link. Best effort: a file that can't be drawn (too big, a broken file, no renderer
// on this server) gets a file tile instead, and the email still goes out.
//
// Nov 4 notes (batch 21, QW3): this module loads @napi-rs/canvas (Skia, ~32 MB native) and pdf.js (~6 MB
// traced), so only the route that draws thumbnails imports it (src/app/api/review-thumbnails/route.ts).
// Everything else — the review Server Actions included — asks that route (review-thumbnail-request.ts),
// so the libraries ship with one server function instead of every page that has a task pane.

// Nov 1 notes (batch 8): the email shows each file near the full width of its content (EMAIL_IMAGE_WIDTH,
// 504 px), so thumbnails are drawn at about twice that for sharp screens (they were 480 px wide before).
export const THUMB_WIDTH = 1200;
// Tall images and pages are cropped from the top at this height (an email shouldn't scroll for one file).
export const THUMB_MAX_HEIGHT = 1500;
// A JPEG over this is encoded again at a lower quality (THUMB_QUALITIES), so an email stays light.
export const THUMB_MAX_BYTES = 600 * 1024;
export const THUMB_QUALITIES = [82, 72, 62, 52] as const;
export const MAX_THUMBNAILS = 6;
const RENDER_TIMEOUT_MS = 12000;
const CONCURRENCY = 3;
// Nov 2 notes (batch 16, 122): the review email waits at most THUMBNAIL_BUDGET_MS for thumbnails (defined
// with the request side in review-thumbnail-request.ts, which can't import this module).
export { THUMBNAIL_BUDGET_MS };
export type { ReviewThumbnail };

export type ThumbnailSource = {
  assetId: string;
  attachmentId: string;
  name: string;
  contentType: string | null;
  storagePath: string;
  size: number | null;
};

export { thumbnailPath };

// Which files get a thumbnail: images and PDFs (never SVG or HTML: previewKind decides), at most
// MAX_THUMBNAILS of them, each no bigger than an attachment may be.
export function thumbnailCandidates<T extends Pick<ThumbnailSource, "name" | "contentType" | "size">>(assets: T[]): T[] {
  return assets
    .filter((a) => {
      const kind = reviewMediaKind(a.name, a.contentType);
      return (kind === "image" || kind === "pdf") && (a.size === null || a.size <= MAX_ATTACHMENT_BYTES);
    })
    .slice(0, MAX_THUMBNAILS);
}

// The thumbnail's size: THUMB_WIDTH wide (never upscaled past the original), cropped at THUMB_MAX_HEIGHT.
export function thumbnailSize(width: number, height: number) {
  const scale = Math.min(1, THUMB_WIDTH / Math.max(1, width));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.min(THUMB_MAX_HEIGHT, Math.round(height * scale)));
  return { width: w, height: h, scale };
}

// The pixel size of a JPEG (its first start-of-frame marker), or null when the bytes aren't one. Used for
// thumbnails already stored (an earlier round's, or one drawn before batch 8 at 480 px).
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    // SOF0–SOF15 except DHT (C4), JPG (C8), and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= bytes.length) return null;
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width && height ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

// Encodes the thumbnail as a JPEG, lowering the quality until it fits THUMB_MAX_BYTES (the last try is
// kept whatever its size: a thumbnail is never bigger than THUMB_WIDTH × THUMB_MAX_HEIGHT anyway).
export function encodeWithinCap(encode: (quality: number) => Buffer): Buffer {
  let last: Buffer | null = null;
  for (const quality of THUMB_QUALITIES) {
    last = encode(quality);
    if (last.length <= THUMB_MAX_BYTES) return last;
  }
  return last!;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type Canvas = typeof import("@napi-rs/canvas");

async function loadCanvas(): Promise<Canvas> {
  return import("@napi-rs/canvas");
}

async function renderImage(canvasLib: Canvas, bytes: Uint8Array): Promise<Buffer> {
  const image = await canvasLib.loadImage(Buffer.from(bytes));
  const size = thumbnailSize(image.width, image.height);
  const canvas = canvasLib.createCanvas(size.width, size.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, Math.round(image.width * size.scale), Math.round(image.height * size.scale));
  return encodeWithinCap((quality) => canvas.toBuffer("image/jpeg", quality));
}

// pdf.js's Node build, loaded on first use. Its worker module is imported here so pdf.js runs it on this
// thread (globalThis.pdfjsWorker) instead of looking for a worker file at run time.
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsLoad: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsLoad ??= (async () => {
    // @ts-expect-error -- pdf.js ships no types for its worker module (only its exports matter here).
    const worker: unknown = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker ??= worker;
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })().catch((error) => {
    pdfjsLoad = null;
    throw error;
  });
  return pdfjsLoad;
}

// The built-in fonts' data (Helvetica, Times, …) for PDFs that don't embed their fonts. Found the way
// Node finds a package — node_modules here, else in a parent folder: since big move 2 the app runs from
// apps/web (locally and in its Vercel function) while npm installs pdf.js in the monorepo root's
// node_modules, which next.config.ts traces into this route.
export function standardFontDataUrl(start: string = process.cwd()): string | undefined {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const fonts = path.join(dir, "node_modules", "pdfjs-dist", "standard_fonts");
    if (existsSync(fonts)) return `${fonts}${path.sep}`;
    if (path.dirname(dir) === dir) return undefined;
  }
}

async function renderPdf(canvasLib: Canvas, bytes: Uint8Array): Promise<Buffer> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = THUMB_WIDTH / Math.max(1, base.width);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.min(THUMB_MAX_HEIGHT, Math.round(viewport.height)));
    const canvas = canvasLib.createCanvas(width, Math.round(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    if (height === canvas.height) return encodeWithinCap((quality) => canvas.toBuffer("image/jpeg", quality));
    const cropped = canvasLib.createCanvas(width, height);
    cropped.getContext("2d").drawImage(canvas, 0, 0);
    return encodeWithinCap((quality) => cropped.toBuffer("image/jpeg", quality));
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

// Draws one file's thumbnail (an image, or a PDF's first page) as a JPEG. Exported for the tests.
export async function renderThumbnail(kind: "image" | "pdf", bytes: Uint8Array): Promise<Buffer> {
  const canvasLib = await loadCanvas();
  return kind === "pdf" ? renderPdf(canvasLib, bytes) : renderImage(canvasLib, bytes);
}

// The size of a thumbnail already stored, read from its header (null when it can't be read: the email
// then draws it at the full content width).
async function storedSize(ctx: ApiContext, objectPath: string): Promise<{ width: number; height: number } | null> {
  const data = await downloadObject(ctx, objectPath);
  if (!data || data.size > THUMB_MAX_BYTES * 4) return null;
  return jpegSize(new Uint8Array(await data.arrayBuffer()));
}

async function oneThumbnail(ctx: ApiContext, taskId: string, source: ThumbnailSource, seconds: number): Promise<ReviewThumbnail | null> {
  const objectPath = thumbnailPath(taskId, source.attachmentId);
  // Files never change, so a thumbnail drawn for an earlier round (or an earlier send) is reused. One drawn
  // before batch 8 (480 px) is kept too and shown at its own width (sharp, if a little smaller): people
  // can't replace a stored file (no update policy on the bucket), and the original is a click away.
  const existing = await signedObjectUrl(ctx, objectPath, seconds);
  if (existing) {
    const size = await storedSize(ctx, objectPath).catch(() => null);
    return { url: existing, width: size?.width ?? null, height: size?.height ?? null };
  }
  const kind = reviewMediaKind(source.name, source.contentType);
  if (kind !== "image" && kind !== "pdf") return null;
  const original = await downloadObject(ctx, source.storagePath);
  if (!original) return null;
  if (original.size > MAX_ATTACHMENT_BYTES) return null;
  const jpeg = await renderThumbnail(kind, new Uint8Array(await original.arrayBuffer()));
  const uploadError = await uploadObject(ctx, objectPath, jpeg, { contentType: "image/jpeg", upsert: false });
  // Someone else drew it at the same moment: theirs is the same picture.
  if (uploadError && !/exists|duplicate/i.test(uploadError)) return null;
  const url = await signedObjectUrl(ctx, objectPath, seconds);
  const size = jpegSize(new Uint8Array(jpeg));
  return url ? { url, width: size?.width ?? null, height: size?.height ?? null } : null;
}

// Signed thumbnails (with their sizes) by asset id, for the files that could be drawn (the rest are left
// out: the email shows a file tile for them). Links last until the review link expires.
export async function reviewThumbnails(
  ctx: ApiContext,
  taskId: string,
  assets: ThumbnailSource[],
  expiresAt: Date,
  budgetMs = THUMBNAIL_BUDGET_MS,
): Promise<Map<string, ReviewThumbnail>> {
  const urls = new Map<string, ReviewThumbnail>();
  const seconds = Math.max(3600, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  const queue = thumbnailCandidates(assets);
  let next = 0;
  async function work() {
    while (next < queue.length) {
      const source = queue[next++];
      try {
        const thumb = await withTimeout(oneThumbnail(ctx, taskId, source, seconds), RENDER_TIMEOUT_MS);
        if (thumb) urls.set(source.assetId, thumb);
      } catch (error) {
        // Logs the kind of failure only (never a file name, path, or link).
        console.error("Review thumbnail skipped:", error instanceof Error ? error.message.slice(0, 60) : "error");
      }
    }
  }
  const done = Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, work));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  await Promise.race([done, budget]);
  clearTimeout(timer);
  // A copy: thumbnails that finish after the budget don't change the email being sent.
  return new Map(urls);
}
