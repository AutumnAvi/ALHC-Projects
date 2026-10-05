// Portfolio and project-status vocabulary shared by server and client code. The database
// (20261005070000_portfolios.sql) is the source of truth; this mirrors it for display.

export const PROJECT_STATUSES = ["on_track", "at_risk", "off_track", "complete"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  complete: "Complete",
};

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}

// "Completed recently" in portfolio reports: completed on one of the viewer's last N local days,
// today included (same as the views filter completed_within_days). Fixed in portfolio_report().
export const RECENT_DAYS = 7;

export type PortfolioCounts = {
  total: number;
  completed: number;
  incomplete: number;
  overdue: number;
  completedRecent: number;
};

export const EMPTY_COUNTS: PortfolioCounts = { total: 0, completed: 0, incomplete: 0, overdue: 0, completedRecent: 0 };

// Progress = completed / (completed + incomplete), rounded down so 100% only ever means "all done".
// Portfolio-wide, portfolio_report() counts each task once even when it is in several of the
// portfolio's projects, and only over projects the viewer can read. No tasks => null ("No tasks").
export function progressPercent(completed: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.floor((100 * completed) / total);
}

export function formatProgress(percent: number | null): string {
  return percent === null ? "No tasks" : `${percent}%`;
}
