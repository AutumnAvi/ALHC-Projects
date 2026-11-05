// Nov 5 note 165: a task's Attachments start compact — the first few files by name, each with a small
// file-type icon and no preview — with "Show all N" to list every name and a Previews view that is the
// card grid as it was (thumbnails, PDFs, sizes). Pure, so the unit tests can pin it.

export type AttachmentView = "compact" | "all" | "previews";

// How many files the compact list shows before "Show all N".
export const COMPACT_ATTACHMENT_LIMIT = 4;

// How many of `total` rows a view draws, and how many it leaves behind "Show all N".
export function attachmentRows(total: number, view: AttachmentView, limit = COMPACT_ATTACHMENT_LIMIT): { shown: number; hidden: number } {
  const count = Math.max(0, Math.floor(total));
  // One more row would only replace the "Show all" line itself: show it instead.
  const shown = view === "compact" && count > limit + 1 ? limit : count;
  return { shown, hidden: count - shown };
}

export type FileTypeKind = "image" | "pdf" | "video" | "audio" | "sheet" | "slides" | "doc" | "archive" | "design" | "file";

const EXTENSIONS: Record<string, FileTypeKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  heic: "image",
  heif: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  avif: "image",
  pdf: "pdf",
  mp4: "video",
  mov: "video",
  webm: "video",
  m4v: "video",
  avi: "video",
  mkv: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  flac: "audio",
  xls: "sheet",
  xlsx: "sheet",
  csv: "sheet",
  tsv: "sheet",
  numbers: "sheet",
  ods: "sheet",
  ppt: "slides",
  pptx: "slides",
  key: "slides",
  odp: "slides",
  doc: "doc",
  docx: "doc",
  txt: "doc",
  rtf: "doc",
  md: "doc",
  pages: "doc",
  odt: "doc",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  gz: "archive",
  tar: "archive",
  psd: "design",
  ai: "design",
  indd: "design",
  sketch: "design",
  fig: "design",
  eps: "design",
};

// The small icon a file gets in a name-only list: from its extension, else its content type. Only an
// icon: whether a file may be shown inline is still previewKind's (attachment-preview.ts) decision.
export function fileTypeKind(fileName: string, contentType: string | null = null): FileTypeKind {
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot + 1).trim().toLowerCase() : "";
  const byExtension = ext ? EXTENSIONS[ext] : undefined;
  if (byExtension) return byExtension;
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/")) return "doc";
  return "file";
}
