// Nov 4 notes (batch 21, QW3): what both sides of thumbnail drawing share — the route that draws them
// (review-thumbnails.ts, with pdf.js and Skia) and the Server Actions that ask it
// (review-thumbnail-request.ts). No heavy imports here, so the actions' server functions stay small.

// Nov 2 notes (batch 16, 122): the review email waits at most this long for thumbnails, so it goes out in
// seconds; files whose thumbnail isn't ready by then get a file tile (their thumbnails still finish and
// are stored, so the next round reuses them).
export const THUMBNAIL_BUDGET_MS = 4000;

// A stored thumbnail and its size in pixels (the email draws it at min(its width, EMAIL_IMAGE_WIDTH)).
export type ReviewThumbnail = { url: string; width: number | null; height: number | null };

// Where a file's thumbnail is stored, next to it in the private task-attachments bucket. The approval
// request email (Nov 4 notes, batch 25, 160) signs the ones already drawn.
export function thumbnailPath(taskId: string, attachmentId: string) {
  return `${taskId}/thumb-${attachmentId}.jpg`;
}

// The route that draws them (src/app/api/review-thumbnails/route.ts).
export const REVIEW_THUMBNAILS_PATH = "/api/review-thumbnails";

export type ReviewThumbnailRequest = {
  taskId: string;
  // When the review link expires: the signed thumbnail links last as long.
  expiresAt: string;
  assets: { assetId: string; attachmentId: string }[];
};

export function parseThumbnailResponse(body: unknown): Map<string, ReviewThumbnail> {
  const out = new Map<string, ReviewThumbnail>();
  if (!body || typeof body !== "object" || !("thumbnails" in body)) return out;
  const thumbnails = (body as { thumbnails: unknown }).thumbnails;
  if (!thumbnails || typeof thumbnails !== "object") return out;
  for (const [assetId, value] of Object.entries(thumbnails as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { url, width, height } = value as Record<string, unknown>;
    if (typeof url !== "string" || !url.startsWith("https://")) continue;
    out.set(assetId, {
      url,
      width: typeof width === "number" ? width : null,
      height: typeof height === "number" ? height : null,
    });
  }
  return out;
}
