import type { RequestLabel } from "@/lib/request-numbers";
// The app shell's shared vocabulary (Asana parity, batch 1): search palette results, recents, the
// Settings modal's tabs and links, and the Create menu's dialogs. Browser + server.

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
  // The name without its number; `label` is the number (shown as a badge; Oct 26 notes, batch 4).
  title: string;
  label?: RequestLabel | null;
  completed: boolean;
  // A private task (no project): only its creator and assignee can read it.
  isPrivate: boolean;
  // A project of the task the person can read (its home project when they can), else null.
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
// A person opens their profile page (Real features 2), which links on to their work in Reports.
export const quickPersonHref = (person: Pick<QuickPerson, "id">) => `/people/${person.id}`;

export const SETTINGS_TABS = [
  { key: "profile", label: "Profile" },
  { key: "notifications", label: "Notifications" },
  { key: "email_forwarding", label: "Email forwarding" },
  { key: "calendar", label: "Calendar sync" },
  { key: "account", label: "Account" },
  { key: "display", label: "Display" },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];
export const isSettingsTab = (value: unknown): value is SettingsTab => SETTINGS_TABS.some((t) => t.key === value);

// Settings is a modal (Asana parity, batch 5), so a link to it is a page with ?settings=<tab>: the shell
// opens the modal on that tab (SettingsFromUrl) and takes the parameter out of the address. Links from
// emails and the old /settings/profile page land on Home.
export const SETTINGS_PARAM = "settings";
export const settingsHref = (tab: SettingsTab) => `/?${SETTINGS_PARAM}=${tab}`;

// What Settings → Notifications and Email forwarding say about email in this workspace (read with the
// person's own session when the modal opens): whether emails go out at all, whether replying to a comment
// email posts a comment, and the active projects the person administers by their own role, where they
// can set up inbound webhooks.
export type EmailSetup = {
  sending: boolean;
  replyByEmail: boolean;
  inboundProjects: { id: string; name: string }[];
  forwarding: ForwardingSetup;
};

// Settings → Email forwarding (Real features 1): the person's own forwarding address and where its tasks
// go — or why there isn't one here: inbound email isn't set up on this deployment (no Resend webhook
// secret), or this release's database update isn't applied yet.
export type ForwardingSetup =
  | { state: "not_configured" }
  | { state: "needs_update" }
  | {
      state: "ready";
      address: string;
      defaultProjectId: string | null;
      // Active projects the person can add tasks to (Editor+).
      projects: { id: string; name: string }[];
      recent: ForwardedEmail[];
    };

// One forwarded email the inbound route handled for this person (never its body or sender).
export type ForwardedEmail = {
  id: string;
  status: "created" | "rejected";
  reason: string | null;
  taskId: string | null;
  // Null when the person can't open the task anymore.
  taskTitle: string | null;
  // The project it went to (null = their private My tasks).
  projectId: string | null;
  projectName: string | null;
  attachments: number;
  createdAt: string;
};

// Why a forwarded email didn't become a task, in plain words (email_forwards.reason).
export function forwardRejectionLabel(reason: string | null): string {
  switch (reason) {
    case "sender_mismatch":
      return "Not from your email address, so it was ignored";
    case "not_authenticated":
      return "From your address, but it didn’t pass the sender checks (DMARC), so it was ignored";
    case "rotated":
      return "Sent to your old address, which no longer works";
    case "no_access":
      return "You weren’t in the workspace at the time";
    case "failed":
      return "Couldn’t create the task";
    default:
      return "Ignored";
  }
}

// What the Create menu (and the sidebar's "+" and Invite) can open. A team page opens New project and
// New goal with its team preselected (`teamId`; New project falls back to the default team when the
// viewer can't put projects in that one).
export type ShellDialog =
  | { kind: "task" | "message" | "team" | "portfolio" | "invite" }
  | { kind: "project" | "goal"; teamId?: string }
  | { kind: "settings"; tab: SettingsTab };
