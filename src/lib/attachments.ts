export const ATTACHMENTS_BUCKET = "task-attachments";
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentPath(taskId: string, fileName: string, uniqueId: string) {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100) || "file";
  return `${taskId}/${uniqueId}-${safe}`;
}
