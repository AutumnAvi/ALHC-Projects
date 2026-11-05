// Big move 1: the imports area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { AttachmentFileProgress, ImportPerson, ImportTotals } from "../../imports-shared";
import type { Json } from "../../supabase/database.types";

// ---------------------------------------------------------------------------------------------
// Imports (Admin+ read; RLS returns nothing below Admin)
// ---------------------------------------------------------------------------------------------

export type ImportRun = {
  id: string;
  source: string;
  status: "running" | "completed" | "failed";
  fileNames: string[];
  summary: Record<string, unknown>;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type WorkspaceImportRun = ImportRun & { projectId: string; projectName: string };

// ---------------------------------------------------------------------------------------------
// Asana import (Admin+): what the import's reads and writes take. The export parser
// (src/lib/asana-import.ts) and the file downloads (src/lib/safe-fetch.ts, the Asana API) are server-only,
// so the adapter hands them to the layer as tools; these types are what the layer needs of them.
// ---------------------------------------------------------------------------------------------

// One downloaded export file.
export type ImportFile = { name: string; text: string };

// An attachment's file for "Download attachments" (asana-import.ts's PlanAttachmentFile).
export type ImportAttachmentFile = {
  taskGid: string;
  gid: string;
  name: string;
  downloadUrl: string | null;
  size: number | null;
};

// The parts of a parsed plan (asana-import.ts's ImportPlan fits this) the import reads.
export type ImportPlanView = {
  project: { gid: string; name: string } | null;
  sections: readonly { key: string; name: string }[];
  fields: readonly { key: string; name: string; type: string }[];
  rules: readonly unknown[];
  tasks: readonly unknown[];
  dependencies: readonly unknown[];
  people: readonly ImportPerson[];
  tagCount: number;
  warnings: string[];
  attachmentFiles: readonly ImportAttachmentFile[];
};

// Every external id the plan would create, by kind (asana-import.ts's planExternalIds).
export type ImportExternalIds = Record<
  "project" | "section" | "field" | "task" | "subtask" | "comment" | "attachment",
  string[]
>;

// A parsed import: the plan, its batches for import_batch in order (importSteps), and the external ids
// it would create (planExternalIds), computed when asked.
export type ParsedImport = {
  plan: ImportPlanView;
  steps: () => Json[];
  externalIds: () => ImportExternalIds;
};

// Parses the downloaded export files; refuses a file it can't read with ApiError("invalid", <why>).
export type ImportParser = (files: ImportFile[]) => ParsedImport;

// A public https:// file fetched for "Download attachments" (safe-fetch.ts's safeDownload answer).
export type ImportDownload =
  | { ok: true; bytes: Uint8Array; contentType: string | null }
  | { ok: false; tooLarge: boolean };

// One attachment's fresh download link from the Asana API.
export type AsanaAttachmentLink =
  | { kind: "ok"; url: string; size: number | null }
  | { kind: "unauthorized" }
  | { kind: "failed" };

export type ImportTools = {
  parse: ImportParser;
  // GET a public https:// file (no private addresses, stops past maxBytes).
  download: (url: string, init: { timeoutMs: number; maxBytes: number }) => Promise<ImportDownload>;
  // Asks the Asana API for an attachment's download link with the importer's own token.
  asanaAttachmentLink: (gid: string, token: string) => Promise<AsanaAttachmentLink>;
};

export type RunAsanaImportInput = {
  projectId: string;
  paths: string[];
  runId?: string | null;
  step?: number;
  totals?: ImportTotals;
  inviteRole?: "editor" | null;
  // "Download attachments" (off by default): after the batches, copy each task's Asana attachment
  // files into Storage, resumably (files: where the last call stopped).
  downloadAttachments?: boolean;
  files?: AttachmentFileProgress | null;
  // Nov 2 notes (batch 14, 103): an Asana personal access token for files the export has no download link
  // for. Sent with each call by the browser (which keeps it only in memory); never stored or logged.
  asanaToken?: string | null;
};
