// Big move 1: the goals area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import { type Goal, type GoalStatus, isGoalStatus, isProgressMode } from "../../goals";
import type { Tables } from "../../supabase/database.types";

// ---------------------------------------------------------------------------------------------
// Goals (workspace-level; progress is computed per viewer and never counts unreadable projects)
// ---------------------------------------------------------------------------------------------

export const GOAL_COLUMNS =
  "id, title, notes, team_id, parent_id, owner_id, period_start, period_end, status, progress_mode, manual_progress, created_at";

export function toGoal(row: Pick<
  Tables<"goals">,
  | "id"
  | "title"
  | "notes"
  | "team_id"
  | "parent_id"
  | "owner_id"
  | "period_start"
  | "period_end"
  | "status"
  | "progress_mode"
  | "manual_progress"
  | "created_at"
>): Goal {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    teamId: row.team_id,
    parentId: row.parent_id,
    ownerId: row.owner_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: isGoalStatus(row.status) ? row.status : "on_track",
    progressMode: isProgressMode(row.progress_mode) ? row.progress_mode : "manual",
    manualProgress: row.manual_progress,
    createdAt: row.created_at,
  };
}

export type GoalLink = {
  id: string;
  kind: "project" | "portfolio";
  targetId: string;
  name: string;
  status: string | null;
  // False until someone set the project's status (Nov 10 audit, C14: "No status", never a default "On track").
  statusSet: boolean;
};

export type GoalStatusUpdate = {
  id: string;
  status: GoalStatus;
  body: string | null;
  authorId: string | null;
  authorName: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------------------------
// Goal writes' inputs
// ---------------------------------------------------------------------------------------------

export type GoalInput = {
  title: string;
  parentId?: string | null;
  teamId?: string | null;
  ownerId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  progressMode?: string;
};

export type GoalPatch = {
  title?: string;
  notes?: string | null;
  parentId?: string | null;
  teamId?: string | null;
  ownerId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  progressMode?: string;
  manualProgress?: number;
};

export type GoalLinkTarget = { projectId: string } | { portfolioId: string };
