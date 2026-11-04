// Big move 1: the reports area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { PortfolioCounts } from "@/lib/portfolios";

// ---------------------------------------------------------------------------------------------
// Reporting and export. Every number comes from SECURITY INVOKER RPCs that only count projects the
// viewer can read (RLS plus has_project_role per project); unreadable projects are only ever a count
// (workspace_hidden_project_count). Personal dashboards are owner-only (RLS).
// ---------------------------------------------------------------------------------------------

export type ReportRow = PortfolioCounts & { bucket: string | null; projectId: string | null };

export type SeriesPoint = { start: string; count: number };

export type OverdueTask = {
  taskId: string;
  title: string;
  projectId: string;
  assigneeId: string | null;
  dueOn: string;
  daysOverdue: number;
  parentTaskId: string | null;
};

export type AllProjectsRow = {
  id: string;
  name: string;
  status: string;
  statusNote: string | null;
  counts: PortfolioCounts;
};

export type SectionLabel = { id: string; name: string; projectId: string };
