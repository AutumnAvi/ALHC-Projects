// Big move 1: the CSV exports' row types (src/lib/exports.ts builds the files; packages/core/src/api/exports/queries.ts
// reads the rows). Types only; safe anywhere.

// One row of a workspace report breakdown (workspace_report), as the export pages through it.
export type ReportCountRow = {
  bucket: string | null;
  project_id: string | null;
  task_count: number;
  completed_count: number;
  incomplete_count: number;
  overdue_count: number;
  completed_recent_count: number;
};
