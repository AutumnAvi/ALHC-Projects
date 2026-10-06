// Which attachments may be shown inline (thumbnail / lightbox / the browser's PDF viewer).
// Shared by `/attachments/[id]` (the real gate) and the task pane, so the rules live in one place.
// Only raster images (PNG, JPEG, GIF, WebP) and PDF qualify. SVG, HTML, and everything else are
// downloaded instead: SVG and HTML can carry script.

export type PreviewKind = "image" | "pdf";

const EXTENSION_KINDS: Record<string, PreviewKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "pdf",
};

const CONTENT_TYPE_KINDS: Record<string, PreviewKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/pjpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "pdf",
};

function extensionKind(fileName: string): PreviewKind | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSION_KINDS[fileName.slice(dot + 1).trim().toLowerCase()] ?? null;
}

function contentTypeKind(contentType: string): PreviewKind | null {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_KINDS[base] ?? null;
}

// The extension must be on the safe list, and a content type, when known, must agree with it.
// A missing content type falls back to the extension alone (the route also checks the stored
// object's type before serving anything inline).
export function previewKind(fileName: string, contentType: string | null | undefined): PreviewKind | null {
  const byName = extensionKind(fileName);
  if (!byName) return null;
  if (contentType == null || contentType.trim() === "") return byName;
  return contentTypeKind(contentType) === byName ? byName : null;
}
