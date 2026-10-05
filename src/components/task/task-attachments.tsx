"use client";

import { useRef, useState } from "react";
import { FileText, Paperclip, Trash2 } from "lucide-react";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { deleteAttachment, registerAttachment } from "@/lib/actions";
import {
  ATTACHMENTS_BUCKET,
  MAX_ATTACHMENT_BYTES,
  attachmentPath,
  formatBytes,
} from "@/lib/attachments";
import type { TaskAttachment } from "@/lib/data";
import { createClient } from "@/lib/supabase/client";

export function TaskAttachments({
  taskId,
  attachments,
}: {
  taskId: string;
  attachments: TaskAttachment[];
}) {
  const [, run] = useServerAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList) {
    setError(null);
    const supabase = createClient();
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is larger than 25 MB.`);
        continue;
      }
      setUploading((n) => n + 1);
      const path = attachmentPath(taskId, file.name, crypto.randomUUID());
      const { error: uploadError } = await supabase.storage
        .from(ATTACHMENTS_BUCKET)
        .upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (uploadError) {
        setError(`Couldn’t upload ${file.name}: ${uploadError.message}`);
      } else {
        run(() =>
          registerAttachment({
            taskId,
            storagePath: path,
            fileName: file.name,
            contentType: file.type || null,
            sizeBytes: file.size,
          }),
        );
      }
      setUploading((n) => n - 1);
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <section className="mt-6" aria-labelledby="attachments-heading">
      <div className="flex items-baseline justify-between">
        <h3 id="attachments-heading" className="text-sm font-medium text-zinc-900">
          Attachments
        </h3>
        <span className="text-xs text-zinc-400">Up to 25 MB each</span>
      </div>

      {attachments.length > 0 ? (
        <ul className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-200">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="group flex items-center gap-2.5 px-3 py-2">
              <FileText className="size-4 shrink-0 text-zinc-400" aria-hidden />
              <a
                href={`/attachments/${attachment.id}`}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sm text-zinc-800 hover:underline"
              >
                {attachment.fileName}
              </a>
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                {formatBytes(attachment.sizeBytes)} · <Timestamp iso={attachment.createdAt} />
              </span>
              <button
                type="button"
                aria-label={`Remove attachment ${attachment.fileName}`}
                onClick={() => {
                  if (window.confirm(`Remove “${attachment.fileName}” from this task?`)) {
                    run(() => deleteAttachment(attachment.id));
                  }
                }}
                className="rounded p-1 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-within:ring-2 focus-within:ring-accent-100">
        <Paperclip className="size-4" aria-hidden />
        {uploading > 0 ? `Uploading ${uploading}…` : "Attach files"}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => e.currentTarget.files && void upload(e.currentTarget.files)}
        />
      </label>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </section>
  );
}
