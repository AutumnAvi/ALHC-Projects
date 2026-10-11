// The app shell's shared vocabulary (Asana parity, batch 1): search palette results, recents, the
// Settings modal's tabs, and the Create menu's dialogs. Browser + server.

export type SearchKind = "tasks" | "projects" | "people";
export const SEARCH_KINDS: { key: SearchKind; label: string }[] = [
  { key: "tasks", label: "Tasks" },
  { key: "projects", label: "Projects" },
  { key: "people", label: "People" },
];
export const isSearchKind = (value: unknown): value is SearchKind =>
  value === "tasks" || value === "projects" || value === "people";

export type QuickTask = {
  id: string;
  title: string;
  completed: boolean;
  // Null for a private task (no project).
  projectId: string | null;
  projectName: string | null;
  // Where the task opens: its project's pane, My tasks for a private task (decided on the server).
  href: string;
};
export type QuickProject = { id: string; name: string; archived: boolean };
export type QuickPerson = { id: string; name: string; email: string };
export type QuickResults = { tasks: QuickTask[]; projects: QuickProject[]; people: QuickPerson[] };
export const EMPTY_RESULTS: QuickResults = { tasks: [], projects: [], people: [] };

// Recently opened tasks and projects are kept in the browser as ids only; names come from the server
// (through RLS) each time the palette opens, so a recent the viewer can no longer read never shows.
export type RecentRef = { kind: "task" | "project"; id: string };
export type RecentItem = ({ kind: "task" } & QuickTask) | ({ kind: "project" } & QuickProject);
export const MAX_RECENTS = 20;

export const quickProjectHref = (project: Pick<QuickProject, "id">) => `/projects/${project.id}`;
// People have no profile page yet: Reports filtered to their tasks (in projects the viewer can read).
export const quickPersonHref = (person: Pick<QuickPerson, "id">) => `/reports?a=${person.id}`;

export const SETTINGS_TABS = [
  { key: "profile", label: "Profile" },
  { key: "notifications", label: "Notifications" },
  { key: "account", label: "Account" },
  { key: "display", label: "Display" },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];
export const isSettingsTab = (value: unknown): value is SettingsTab => SETTINGS_TABS.some((t) => t.key === value);

// What the Create menu (and the sidebar's "+" and Invite) can open.
export type ShellDialog =
  | { kind: "task" | "project" | "message" | "team" | "portfolio" | "goal" | "invite" }
  | { kind: "settings"; tab: SettingsTab };
