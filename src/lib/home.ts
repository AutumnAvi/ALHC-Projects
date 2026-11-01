// Home's vocabulary (Asana parity, batch 5): the greeting, the date line, and the My tasks widget's
// tabs. Browser + server; times of day and "today" are computed in the viewer's time zone (the tz
// cookie) on the server, so the page draws the same greeting the browser would.

export function hourIn(timeZone: string, now: Date = new Date()): number {
  try {
    const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now);
    const value = Number.parseInt(hour, 10);
    return Number.isFinite(value) ? value % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

// Asana's greeting: morning until noon, afternoon until 6 pm, evening after (and before 5 am).
export function greetingFor(hour: number): "Good morning" | "Good afternoon" | "Good evening" {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

// "Monday, October 12" in the viewer's time zone.
export function longDateIn(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(now);
  } catch {
    return now.toDateString();
  }
}

// The name in the greeting: the first word of the person's name, or the part of their email before @
// when the account has no name (password sign-ups fall back to the address).
export function firstName(name: string, email: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("@") || trimmed.toLowerCase() === email.toLowerCase()) return email.split("@")[0] || "there";
  return trimmed.split(/\s+/)[0];
}

export const HOME_TASK_TABS = [
  { key: "upcoming", label: "Upcoming" },
  { key: "overdue", label: "Overdue" },
  { key: "completed", label: "Completed" },
] as const;
export type HomeTaskTab = (typeof HOME_TASK_TABS)[number]["key"];

type DatedTask = { dueOn: string | null; completedAt: string | null };

// Upcoming = open tasks due today or later, then those without a due date; Overdue = open tasks due
// before today (oldest first); Completed = the recently completed list as given (newest first).
export function splitHomeTasks<T extends DatedTask>(open: T[], completed: T[], today: string) {
  const upcoming = open
    .filter((t) => !t.dueOn || t.dueOn >= today)
    .sort((a, b) => (a.dueOn ?? "9999-12-31").localeCompare(b.dueOn ?? "9999-12-31"));
  const overdue = open.filter((t) => t.dueOn !== null && t.dueOn < today).sort((a, b) => a.dueOn!.localeCompare(b.dueOn!));
  return { upcoming, overdue, completed };
}

// A new task has no due date, so splitHomeTasks puts it with the undated tasks at the end of Upcoming.
// The tasks someone just created in the My tasks widget (ids newest first) go first instead, right under
// the row they were typed in.
export function createdFirst<T extends { id: string }>(tasks: T[], createdIds: string[]): T[] {
  if (createdIds.length === 0) return tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const created = createdIds.map((id) => byId.get(id)).filter((t): t is T => t !== undefined);
  const pinned = new Set(createdIds);
  return [...created, ...tasks.filter((t) => !pinned.has(t.id))];
}

// Tasks completed this week (Sunday through today, local days), for the "My week" summary.
export function completedThisWeek<T extends DatedTask>(completed: T[], today: string, timeZone: string): number {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - weekday * 86_400_000).toISOString().slice(0, 10);
  const localDay = (iso: string) => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    } catch {
      return iso.slice(0, 10);
    }
  };
  return completed.filter((t) => t.completedAt && localDay(t.completedAt) >= start).length;
}

// listMyTasks() reads the 30 most recently completed tasks; when every one of them falls in this week the
// summary can only say "30+" (and the Completed tab says it shows the latest 30).
export const RECENT_COMPLETED_LIMIT = 30;

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// The Projects widget's two lists, remembered per browser.
export const HOME_PROJECT_VIEWS = [
  { key: "recents", label: "Recents" },
  { key: "starred", label: "Starred" },
] as const;
export type HomeProjectView = (typeof HOME_PROJECT_VIEWS)[number]["key"];
export const isHomeProjectView = (value: unknown): value is HomeProjectView =>
  HOME_PROJECT_VIEWS.some((v) => v.key === value);

// ---------------------------------------------------------------------------------------------
// Nov 1 notes (batch 9b, item 65): home_dashboard(tz) — my projects for everyone, and four fixed lead
// cards for people who lead projects. The parser drops anything malformed (a missing card is empty).
// ---------------------------------------------------------------------------------------------

export type HomeProject = {
  id: string;
  name: string;
  status: string;
  statusSet: boolean;
  starred: boolean;
  myOpen: number;
  total: number;
  completed: number;
  overdue: number;
};

export type LeadPerson = { profileId: string; name: string; open: number; dueWeek: number; overdue: number };
export type LeadLateTask = {
  id: string;
  title: string;
  dueOn: string;
  overdue: boolean;
  assigneeId: string | null;
  assigneeName: string | null;
  projectId: string | null;
  projectName: string | null;
};
export type LeadHealth = {
  id: string;
  name: string;
  status: string;
  statusSet: boolean;
  total: number;
  completed: number;
  overdue: number;
  doneWeek: number;
};
export type LeadCards = {
  projectCount: number;
  workspaceAdmin: boolean;
  weekStart: string;
  load: { people: LeadPerson[]; peopleCount: number; unassigned: number };
  late: { overdue: number; atRisk: number; tasks: LeadLateTask[] };
  health: LeadHealth[];
  done: { total: number; people: { profileId: string | null; name: string | null; count: number }[] };
};
export type HomeDashboard = { projects: HomeProject[]; lead: LeadCards | null };

export const EMPTY_HOME_DASHBOARD: HomeDashboard = { projects: [], lead: null };

// A soft cap for Team load's bars: more than this many due in the next seven days reads as a lot.
export const LOAD_SOFT_CAP = 10;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

export function parseHomeDashboard(data: unknown): HomeDashboard {
  if (!isObj(data)) return EMPTY_HOME_DASHBOARD;
  const projects = list(data.projects).flatMap((p): HomeProject[] => {
    const id = str(p.id);
    const name = str(p.name);
    if (!id || name === null) return [];
    return [{
      id,
      name,
      status: str(p.status) ?? "on_track",
      statusSet: p.status_set === true,
      starred: p.starred === true,
      myOpen: num(p.my_open),
      total: num(p.total),
      completed: num(p.completed),
      overdue: num(p.overdue),
    }];
  });
  const raw = data.lead;
  if (!isObj(raw)) return { projects, lead: null };
  const load = isObj(raw.load) ? raw.load : {};
  const late = isObj(raw.late) ? raw.late : {};
  const done = isObj(raw.done) ? raw.done : {};
  const lead: LeadCards = {
    projectCount: num(raw.project_count),
    workspaceAdmin: raw.workspace_admin === true,
    weekStart: str(raw.week_start) ?? "",
    load: {
      people: list(load.people).flatMap((x) => {
        const profileId = str(x.profile_id);
        return profileId
          ? [{ profileId, name: str(x.name) ?? "Someone", open: num(x.open), dueWeek: num(x.due_week), overdue: num(x.overdue) }]
          : [];
      }),
      peopleCount: num(load.people_count),
      unassigned: num(load.unassigned),
    },
    late: {
      overdue: num(late.overdue),
      atRisk: num(late.at_risk),
      tasks: list(late.tasks).flatMap((x) => {
        const id = str(x.id);
        const dueOn = str(x.due_on);
        return id && dueOn
          ? [{
              id,
              title: str(x.title) ?? "",
              dueOn,
              overdue: x.overdue === true,
              assigneeId: str(x.assignee_id),
              assigneeName: str(x.assignee_name),
              projectId: str(x.project_id),
              projectName: str(x.project_name),
            }]
          : [];
      }),
    },
    health: list(raw.health).flatMap((x) => {
      const id = str(x.id);
      return id
        ? [{
            id,
            name: str(x.name) ?? "",
            status: str(x.status) ?? "on_track",
            statusSet: x.status_set === true,
            total: num(x.total),
            completed: num(x.completed),
            overdue: num(x.overdue),
            doneWeek: num(x.done_week),
          }]
        : [];
    }),
    done: {
      total: num(done.total),
      people: list(done.people).map((x) => ({ profileId: str(x.profile_id), name: str(x.name), count: num(x.count) })),
    },
  };
  return { projects, lead };
}

// Progress the way the rest of the app rounds it: down, so 100% only means everything is done; null
// when there's nothing to count.
export function progressOf(completed: number, total: number): number | null {
  return total > 0 ? Math.floor((100 * completed) / total) : null;
}
