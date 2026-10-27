import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import { ATTACHMENTS_BUCKET, MAX_ATTACHMENT_BYTES } from "@/lib/attachments";
import { reviewMediaKind } from "@/lib/review-checks";
import type { createClient } from "@/lib/supabase/server";

// Oct 27 notes (batch 5): thumbnails for the review check email — an image, or a PDF's first page, drawn
// on the server as a small JPEG and stored next to the file in the private task-attachments bucket at
// <task id>/thumb-<attachment id>.jpg (two path segments, so the task's Viewers+ read it like any of its
// files and Editors+ write it). Everything goes through the signed-in Editor's own Supabase client, never
// the service role; the email gets a signed link that lasts as long as the review link. Best effort: a
// file that can't be drawn (too big, a broken file, no renderer on this server) gets a file tile instead,
// and the email still goes out.

type Supabase = Awaited<ReturnType<typeof createClient>>;

export const THUMB_WIDTH = 480;
// Tall images and pages are cropped from the top at this height (an email shouldn't scroll for one file).
export const THUMB_MAX_HEIGHT = 640;
export const MAX_THUMBNAILS = 6;
const RENDER_TIMEOUT_MS = 8000;
const CONCURRENCY = 3;

export type ThumbnailSource = {
  assetId: string;
  attachmentId: string;
  name: string;
  contentType: string | null;
  storagePath: string;
  size: number | null;
};

export function thumbnailPath(taskId: string, attachmentId: string) {
  return `${taskId}/thumb-${attachmentId}.jpg`;
}

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
  return canvas.toBuffer("image/jpeg", 82);
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

// The built-in fonts' data (Helvetica, Times, …) for PDFs that don't embed their fonts.
function standardFontDataUrl(): string | undefined {
  const dir = path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts");
  return existsSync(dir) ? `${dir}${path.sep}` : undefined;
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
    if (height === canvas.height) return canvas.toBuffer("image/jpeg", 82);
    const cropped = canvasLib.createCanvas(width, height);
    cropped.getContext("2d").drawImage(canvas, 0, 0);
    return cropped.toBuffer("image/jpeg", 82);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

// Draws one file's thumbnail (an image, or a PDF's first page) as a JPEG. Exported for the tests.
export async function renderThumbnail(kind: "image" | "pdf", bytes: Uint8Array): Promise<Buffer> {
  const canvasLib = await loadCanvas();
  return kind === "pdf" ? renderPdf(canvasLib, bytes) : renderImage(canvasLib, bytes);
}

async function signedThumbnail(supabase: Supabase, objectPath: string, seconds: number): Promise<string | null> {
  const { data, error } = await supabase.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(objectPath, seconds);
  return error || !data?.signedUrl ? null : data.signedUrl;
}

async function oneThumbnail(supabase: Supabase, taskId: string, source: ThumbnailSource, seconds: number) {
  const objectPath = thumbnailPath(taskId, source.attachmentId);
  // Files never change, so a thumbnail drawn for an earlier round (or an earlier send) is reused.
  const existing = await signedThumbnail(supabase, objectPath, seconds);
  if (existing) return existing;
  const kind = reviewMediaKind(source.name, source.contentType);
  if (kind !== "image" && kind !== "pdf") return null;
  const download = await supabase.storage.from(ATTACHMENTS_BUCKET).download(source.storagePath);
  if (download.error || !download.data) return null;
  if (download.data.size > MAX_ATTACHMENT_BYTES) return null;
  const jpeg = await renderThumbnail(kind, new Uint8Array(await download.data.arrayBuffer()));
  const upload = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(objectPath, jpeg, { contentType: "image/jpeg", upsert: false });
  // Someone else drew it at the same moment: theirs is the same picture.
  if (upload.error && !/exists|duplicate/i.test(upload.error.message)) return null;
  return signedThumbnail(supabase, objectPath, seconds);
}

// Signed thumbnail links by asset id, for the files that could be drawn (the rest are left out: the email
// shows a file tile for them). Links last until the review link expires.
export async function reviewThumbnails(
  supabase: Supabase,
  taskId: string,
  assets: ThumbnailSource[],
  expiresAt: Date,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const seconds = Math.max(3600, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  const queue = thumbnailCandidates(assets);
  let next = 0;
  async function work() {
    while (next < queue.length) {
      const source = queue[next++];
      try {
        const url = await withTimeout(oneThumbnail(supabase, taskId, source, seconds), RENDER_TIMEOUT_MS);
        if (url) urls.set(source.assetId, url);
      } catch (error) {
        // Logs the kind of failure only (never a file name, path, or link).
        console.error("Review thumbnail skipped:", error instanceof Error ? error.message.slice(0, 60) : "error");
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, work));
  return urls;
}
