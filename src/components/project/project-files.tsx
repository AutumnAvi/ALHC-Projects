"use client";

import Link from "next/link";
import { useState } from "react";
import { Download, Eye, FileImage, FileText, Files, Paperclip } from "lucide-react";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "@/components/ui";
import { previewKind } from "@/lib/attachment-preview";
import { formatBytes } from "@/lib/attachments";
import type { ProjectFile } from "@/lib/data";

const FILTERS = [
  { value: "all", label: "All files" },
  { value: "image", label: "Images" },
  { value: "pdf", label: "PDFs" },
  { value: "other", label: "Other" },
] as const;
type FilterValue = (typeof FILTERS)[number]["value"];

// The Files tab: one row per attachment, linked to its task. Opening and downloading go through the
// same RLS-checked /attachments/<id> route as the task pane (60-second signed URLs).
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
  const kindOf = (f: ProjectFile) => previewKind(f.fileName, f.contentType) ?? "other";
  const shown = filter === "all" ? files : files.filter((f) => kindOf(f) === filter);

  return (
    <div className="mx-auto w-full max-w-5xl px-gutter py-4">
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
              onClick={() => setFilter(f.value)}
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
            Files attached to this project’s tasks show up here. Open a task and use Attachments in its pane to add
            one.
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
              <th scope="col" className="w-20 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((file) => {
              const kind = kindOf(file);
              const Icon = kind === "image" ? FileImage : FileText;
              return (
                <tr key={file.id} className="border-b border-zinc-100 hover:bg-zinc-50">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon className="size-4 shrink-0 text-zinc-400" aria-hidden />
                      <span className="truncate text-zinc-900">{file.fileName}</span>
                      <span className="shrink-0 text-xs text-zinc-400">{formatBytes(file.sizeBytes)}</span>
                    </span>
                  </th>
                  <td className="py-2 pr-3">
                    <Link
                      href={`/projects/${projectId}/list?task=${file.taskId}`}
                      className="block truncate text-zinc-600 hover:text-zinc-900 hover:underline"
                    >
                      {file.taskTitle}
                    </Link>
                  </td>
                  <td className="hidden truncate py-2 pr-3 text-zinc-600 md:table-cell">
                    {uploaderNames[file.uploadedBy] ?? "Someone"}
                  </td>
                  <td className="hidden whitespace-nowrap py-2 pr-3 text-xs text-zinc-500 sm:table-cell">
                    <Timestamp iso={file.createdAt} />
                  </td>
                  <td className="whitespace-nowrap py-2 text-right">
                    {kind !== "other" ? (
                      <a
                        href={`/attachments/${file.id}?preview=1`}
                        target="_blank"
                        rel="noopener"
                        aria-label={`Open ${file.fileName}`}
                        title="Open"
                        className="btn-icon"
                      >
                        <Eye className="size-4" />
                      </a>
                    ) : null}
                    <a href={`/attachments/${file.id}?download`} aria-label={`Download ${file.fileName}`} title="Download" className="btn-icon">
                      <Download className="size-4" />
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
