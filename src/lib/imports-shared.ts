// Shared by the Import page (browser) and the import Server Actions. Export files are uploaded from the
// browser to the private `imports` bucket at `<project id>/<uploader id>/<uuid>-<name>` (Storage
// policies: Admin+ of the project, own folder only), then parsed server-side.

export const IMPORTS_BUCKET = "imports";
export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_FILES = 10;

export function importFileKind(name: string): "json" | "csv" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv")) return "csv";
  return null;
}

export function importObjectPath(projectId: string, userId: string, fileName: string, uniqueId: string) {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100) || "export";
  return `${projectId}/${userId}/${uniqueId}-${safe}`;
}

// The original file name, from an object path built above.
export function importFileName(path: string) {
  const last = path.split("/").pop() ?? path;
  return last.replace(/^[0-9a-f-]{36}-/i, "");
}

export type ImportPerson = { name: string | null; email: string | null; references: number };

export type ImportPreview = {
  files: string[];
  sourceProject: string | null;
  // Other projects (that you administer) this same Asana project was imported into before.
  importedElsewhere: { id: string; name: string }[];
  counts: {
    tasks: { total: number; existing: number };
    subtasks: { total: number; existing: number };
    comments: { total: number; existing: number };
    attachments: { total: number; existing: number };
    sections: { total: number; existing: number };
    fields: { total: number; existing: number };
    tags: number;
    dependencies: number;
    rules: number;
  };
  people: {
    matched: ImportPerson[];
    notMember: ImportPerson[];
    noAccount: ImportPerson[];
    noEmail: ImportPerson[];
  };
  warnings: string[];
  steps: number;
};

export const IMPORT_TOTAL_KEYS = [
  "sections",
  "fields",
  "rules",
  "rules_skipped",
  "tasks",
  "tasks_skipped",
  "subtasks",
  "comments",
  "attachments",
  "dependencies",
  "dependencies_skipped",
  "memberships",
  "unassigned",
  "values_skipped",
  "dates_dropped",
] as const;

export type ImportTotals = Partial<Record<(typeof IMPORT_TOTAL_KEYS)[number], number>>;

export function addTotals(a: ImportTotals, b: unknown): ImportTotals {
  const next: ImportTotals = { ...a };
  if (b && typeof b === "object") {
    for (const key of IMPORT_TOTAL_KEYS) {
      const value = (b as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value)) next[key] = (next[key] ?? 0) + value;
    }
  }
  return next;
}

export type ImportProgress = {
  runId: string;
  step: number;
  steps: number;
  done: boolean;
  totals: ImportTotals;
};

// What a finished run added (import_runs.summary.created), for the past-imports lists.
export function describeImportCreated(created: unknown) {
  if (!created || typeof created !== "object") return "nothing added yet";
  const c = created as Record<string, unknown>;
  const n = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : 0);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return `${plural(n("task"), "task")}, ${plural(n("subtask"), "subtask")}, ${plural(n("comment"), "comment")} added`;
}
