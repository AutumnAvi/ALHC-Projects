// Big move 1: the imports area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).


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
