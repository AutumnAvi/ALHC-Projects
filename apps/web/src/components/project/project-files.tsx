"use client";

import Link from "next/link";
import { useState } from "react";
import { Download, Files, Paperclip } from "lucide-react";
import { FilePreviewOverlay } from "@/components/file-preview-overlay";
import { FileTypeIcon } from "@/components/task/file-type-icon";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "@/components/ui";
import { previewKind } from "@alhc/core/attachment-preview";
import { formatBytes } from "@alhc/core/attachments";
import type { ProjectFile } from "@alhc/core/api/projects/model";

const FILTERS = [
  { value: "all", label: "All files" },
  { value: "image", label: "Images" },
  { value: "pdf", label: "PDFs" },
  { value: "other", label: "Other" },
] as const;
type FilterValue = (typeof FILTERS)[number]["value"];

// The Files tab: one row per attachment, linked to its task. Opening and downloading go through the
// same RLS-checked /attachments/<id> route as the task pane (60-second signed URLs). Nov 18 notes
// (batch 44, item 7): a click on a file opens it right here (FilePreviewOverlay: images, PDFs, videos;
// a card with Download for anything else), ← / → move through the files shown, Esc closes.
export function ProjectFiles({
  projectId,
  files,
  uploaderNames,
}: {
  projectId: string;
  files: ProjectFile[];
  uploaderNames: Record<string, string>;
}) {
  const [filter, setFilter] = useState<FilterValue>("all");
  // The file being previewed, by id (the list can change under the overlay; it follows the file).
  const [previewId, setPreviewId] = useState<string | null>(null);
  const kindOf = (f: ProjectFile) => previewKind(f.fileName, f.contentType) ?? "other";
  const shown = filter === "all" ? files : files.filter((f) => kindOf(f) === filter);
  const previewing = previewId === null ? -1 : shown.findIndex((f) => f.id === previewId);
  const taskHref = (f: ProjectFile) => `/projects/${projectId}/list?task=${f.taskId}`;

  return (
    <div className="w-full px-gutter py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold text-zinc-900">
          Files <span className="font-normal tabular-nums text-zinc-500">· {files.length}</span>
        </h2>
        <div role="group" aria-label="Show" className="flex gap-0.5 rounded-md bg-zinc-100 p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => {
                setFilter(f.value);
                setPreviewId(null);
              }}
              className="rounded px-2 py-0.5 text-xs text-zinc-600 aria-pressed:bg-white aria-pressed:font-medium aria-pressed:text-zinc-900 aria-pressed:shadow-xs"
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {files.length === 0 ? (
        <div className="mt-6">
          <EmptyState icon={Files} title="No files yet">
            Files attached to this project’s tasks show up here. To add one, open a task and use the paperclip at
            the top of its pane.
          </EmptyState>
        </div>
      ) : shown.length === 0 ? (
        <div className="mt-6">
          <EmptyState icon={Paperclip} title="No files of this kind" size="inline">
            Choose All files to see everything attached to this project’s tasks.
          </EmptyState>
        </div>
      ) : (
        <table className="mt-3 w-full table-fixed text-sm">
          <caption className="sr-only">Files attached to tasks in this project</caption>
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500">
              <th scope="col" className="py-2 pr-3 font-medium">
                Name
              </th>
              <th scope="col" className="w-[32%] py-2 pr-3 font-medium">
                Task
              </th>
              <th scope="col" className="hidden w-36 py-2 pr-3 font-medium md:table-cell">
                Added by
              </th>
              <th scope="col" className="hidden w-24 py-2 pr-3 font-medium sm:table-cell">
                Added
              </th>
              <th scope="col" className="w-12 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((file) => {
              return (
                <tr
                  key={file.id}
                  className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50"
                  data-file-row={file.id}
                  // A click anywhere on the row (but its links) previews the file in place.
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    setPreviewId(file.id);
                  }}
                >
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <button
                      type="button"
                      onClick={() => setPreviewId(file.id)}
                      aria-label={`Preview ${file.fileName}`}
                      className="-mx-1 flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left hover:text-accent-700 focus-visible:outline-2 focus-visible:outline-accent-500"
                      data-file-open=""
                    >
                      <FileTypeIcon fileName={file.fileName} contentType={file.contentType} className="size-4 shrink-0 text-zinc-400" />
                      <span className="truncate text-zinc-900">{file.fileName}</span>
                      <span className="shrink-0 text-xs text-zinc-400">{formatBytes(file.sizeBytes)}</span>
                    </button>
                  </th>
                  <td className="py-2 pr-3">
                    <Link
                      href={taskHref(file)}
                      className="block truncate text-zinc-600 hover:text-zinc-900 hover:underline"
                    >
                      {file.taskTitle}
                    </Link>
                  </td>
                  <td className="hidden truncate py-2 pr-3 text-zinc-600 md:table-cell">
                    {file.source === "form" ? "Form submission" : (uploaderNames[file.uploadedBy] ?? "Someone")}
                    {file.source === "email" ? <span className="text-zinc-400"> · by email</span> : null}
                  </td>
                  <td className="hidden whitespace-nowrap py-2 pr-3 text-xs text-zinc-500 sm:table-cell">
                    <Timestamp iso={file.createdAt} />
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    <a
                      href={`/attachments/${file.id}?download`}
                      aria-label={`Download ${file.fileName}`}
                      data-tooltip="Download"
                      className="btn-icon"
                    >
                      <Download className="size-4" />
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {previewing >= 0 ? (
        <FilePreviewOverlay
          files={shown.map((f) => ({
            id: f.id,
            fileName: f.fileName,
            contentType: f.contentType,
            sizeBytes: f.sizeBytes,
            context: { label: f.taskTitle, href: taskHref(f) },
          }))}
          index={previewing}
          onIndex={(index) => setPreviewId(shown[index]?.id ?? null)}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </div>
  );
}
