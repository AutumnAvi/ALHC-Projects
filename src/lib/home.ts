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
