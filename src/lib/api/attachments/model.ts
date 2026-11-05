// Big move 1: the attachments area's types (no database; safe in the browser).

// A file in the private task-attachments bucket, as its metadata row describes it.
export type StoredFile = { storagePath: string; fileName: string; contentType: string | null };

// A task attachment's file details (the review email and its thumbnails read these).
export type AttachmentFileRow = {
  id: string;
  file_name: string;
  content_type: string | null;
  storage_path: string;
  size_bytes: number;
};
