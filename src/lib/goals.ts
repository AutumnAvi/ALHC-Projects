// Goal vocabulary, mirrored from 20261006050000_goals_teams.sql (goals.status / progress_mode checks),
// plus time-period labels and the "who can edit" rule the UI uses to hide controls. The database is
// the trust boundary (goal_editable() in RLS); these only decide what to show.

export const GOAL_STATUSES = ["on_track", "at_risk", "off_track", "achieved", "missed", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  achieved: "Achieved",
  missed: "Missed",
  dropped: "Dropped",
};

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && (GOAL_STATUSES as readonly string[]).includes(value);
}

export const PROGRESS_MODES = ["manual", "sub_goals", "projects"] as const;
export type ProgressMode = (typeof PROGRESS_MODES)[number];

export const PROGRESS_MODE_LABELS: Record<ProgressMode, string> = {
  manual: "Set manually",
  sub_goals: "From sub-goals",
  projects: "From linked projects",
};

export const PROGRESS_MODE_DESCRIPTIONS: Record<ProgressMode, string> = {
  manual: "The owner sets a percentage.",
  sub_goals: "The average of its sub-goals (dropped sub-goals and sub-goals with nothing to measure are left out).",
  projects:
    "Completed tasks ÷ all tasks across the linked projects and the projects of linked portfolios you can open, each task counted once.",
};

export function isProgressMode(value: unknown): value is ProgressMode {
  return typeof value === "string" && (PROGRESS_MODES as readonly string[]).includes(value);
}

export type Goal = {
  id: string;
  title: string;
  notes: string | null;
  teamId: string | null;
  parentId: string | null;
  ownerId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  status: GoalStatus;
  progressMode: ProgressMode;
  manualProgress: number;
  createdAt: string;
};

// As the viewer sees it: projects they can't open are left out (hiddenProjects counts them).
export type GoalProgress = {
  progress: number | null;
  taskCount: number | null;
  completedCount: number | null;
  hiddenProjects: number;
  subGoalCount: number;
};

export const NO_PROGRESS: GoalProgress = {
  progress: null,
  taskCount: null,
  completedCount: null,
  hiddenProjects: 0,
  subGoalCount: 0,
};

// Who the viewer is, for goalEditable().
export type GoalViewer = { id: string; isWorkspaceAdmin: boolean; leadTeamIds: readonly string[] };

// Mirrors goal_editable(): the owner, a lead of the goal's team, or a workspace admin.
export function goalEditable(goal: Pick<Goal, "ownerId" | "teamId">, viewer: GoalViewer): boolean {
  return (
    viewer.isWorkspaceAdmin ||
    goal.ownerId === viewer.id ||
    (goal.teamId !== null && viewer.leadTeamIds.includes(goal.teamId))
  );
}

// Goals that can't become `goalId`'s parent: itself and its descendants (the database rejects cycles too).
export function descendantIds(goalId: string, goals: Pick<Goal, "id" | "parentId">[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const g of goals) {
    if (!g.parentId) continue;
    children.set(g.parentId, [...(children.get(g.parentId) ?? []), g.id]);
  }
  const out = new Set<string>([goalId]);
  const stack = [goalId];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Time periods (plain dates, YYYY-MM-DD)
// ---------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

function lastDay(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function short(value: string, withYear: boolean) {
  const { y, m, d } = parts(value);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ""}`;
}

// "Q4 2026", "H1 2027", "2026", "Oct 1 – Nov 15, 2026", "From Oct 1, 2026", "No time period".
export function periodLabel(start: string | null, end: string | null): string {
  if (!start && !end) return "No time period";
  if (!start) return `Until ${short(end!, true)}`;
  if (!end) return `From ${short(start, true)}`;
  const a = parts(start);
  const b = parts(end);
  if (a.y === b.y && a.d === 1 && b.d === lastDay(b.y, b.m)) {
    if (a.m === 1 && b.m === 12) return String(a.y);
    if (b.m - a.m === 2 && (a.m - 1) % 3 === 0) return `Q${(a.m + 2) / 3} ${a.y}`;
    if (b.m - a.m === 5 && (a.m === 1 || a.m === 7)) return `H${a.m === 1 ? 1 : 2} ${a.y}`;
  }
  return a.y === b.y ? `${short(start, false)} – ${short(end, true)}` : `${short(start, true)} – ${short(end, true)}`;
}

export function periodKey(start: string | null, end: string | null): string {
  return `${start ?? ""}_${end ?? ""}`;
}

export function periodCovers(start: string | null, end: string | null, day: string): boolean {
  return (!start || start <= day) && (!end || day <= end);
}

export type PeriodPreset = { label: string; start: string; end: string };

// Quarters, halves, and the year for this year and next, for the period picker.
export function periodPresets(today: string): PeriodPreset[] {
  const year = parts(today).y;
  const out: PeriodPreset[] = [];
  for (const y of [year, year + 1]) {
    for (let q = 0; q < 4; q++) {
      const start = iso(y, q * 3 + 1, 1);
      const end = iso(y, q * 3 + 3, lastDay(y, q * 3 + 3));
      out.push({ label: periodLabel(start, end), start, end });
    }
    out.push({ label: periodLabel(iso(y, 1, 1), iso(y, 6, 30)), start: iso(y, 1, 1), end: iso(y, 6, 30) });
    out.push({ label: periodLabel(iso(y, 7, 1), iso(y, 12, 31)), start: iso(y, 7, 1), end: iso(y, 12, 31) });
    out.push({ label: periodLabel(iso(y, 1, 1), iso(y, 12, 31)), start: iso(y, 1, 1), end: iso(y, 12, 31) });
  }
  return out;
}
