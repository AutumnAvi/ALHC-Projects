// Big move 1: the portfolios area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { Project } from "../projects/model";
import type { FieldOption } from "../../fields";
import type { PortfolioCounts, PortfolioFieldType } from "../../portfolios";
import type { PortfolioRole } from "../../roles";
import type { Tables } from "../../supabase/database.types";

// ---------------------------------------------------------------------------------------------
// Portfolios. RLS shows a portfolio only to its members, and a portfolio's projects only when the
// viewer can also read the project; reports (portfolio_report) apply the same rule.
// ---------------------------------------------------------------------------------------------

export type Portfolio = Pick<Tables<"portfolios">, "id" | "name" | "notes" | "created_at">;

export type PortfolioMember = {
  profileId: string;
  role: PortfolioRole;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  addedAt: string;
};

export type PortfolioProject = Project & { portfolioSortOrder: number };

export type PortfolioReportRow = PortfolioCounts & { bucket: string | null };

// ---------------------------------------------------------------------------------------------
// Portfolio depth: nested portfolios, portfolio fields, rollups, timeline, project status history.
// Links to a nested portfolio show only to Viewers+ of both; rollups and values only cover projects the
// viewer can read (20261006060000_critical_path_portfolios.sql).
// ---------------------------------------------------------------------------------------------

export type PortfolioChild = { id: string; name: string; sortOrder: number };

export type RollupProject = {
  id: string;
  name: string;
  status: string;
  statusNote: string | null;
  // The portfolio the project sits in directly, and the nested portfolio it came through (null = own).
  portfolioId: string;
  groupId: string | null;
  sortOrder: number;
};

export type PortfolioTimelineRow = RollupProject & {
  startOn: string | null;
  dueOn: string | null;
  openTasks: number;
  // Nov 10 batch 36 (C14): nobody ever set the project's status (it reads "No status", grey).
  statusUnset?: boolean;
};

export type PortfolioMilestone = { projectId: string; taskId: string; title: string; dueOn: string };

export type PortfolioField = {
  id: string;
  name: string;
  fieldType: PortfolioFieldType;
  options: FieldOption[];
  sortOrder: number;
  // Oct 29 notes, item 49: a number field's symbol; null = none (and before this release's migration).
  numberPrefix?: string | null;
};
