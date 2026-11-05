import {
  File,
  FileArchive,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
  PenTool,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { fileTypeKind, type FileTypeKind } from "@alhc/core/attachment-list";

// Nov 5 note 165: the small icon a file gets where only its name shows (the compact Attachments list,
// a feedback pill without a thumbnail, a file chip in a task's name).
const ICONS: Record<FileTypeKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  video: FileVideoCamera,
  audio: FileMusic,
  sheet: FileSpreadsheet,
  slides: Presentation,
  doc: FileText,
  archive: FileArchive,
  design: PenTool,
  file: File,
};

// Tints per kind, so a list of names can be scanned by type.
const TONES: Record<FileTypeKind, string> = {
  image: "text-sky-600",
  pdf: "text-red-600",
  video: "text-violet-600",
  audio: "text-fuchsia-600",
  sheet: "text-green-600",
  slides: "text-orange-600",
  doc: "text-blue-600",
  archive: "text-amber-700",
  design: "text-pink-600",
  file: "text-zinc-500",
};

export function FileTypeIcon({
  fileName,
  contentType = null,
  className = "size-4",
}: {
  fileName: string;
  contentType?: string | null;
  className?: string;
}) {
  const kind = fileTypeKind(fileName, contentType);
  const Icon = ICONS[kind];
  return <Icon className={`shrink-0 ${TONES[kind]} ${className}`} aria-hidden data-file-kind={kind} />;
}
