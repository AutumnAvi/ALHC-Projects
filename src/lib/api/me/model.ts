// Big move 1: the me area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { CheckedMode } from "@/lib/checklist";
import type { EmailPreferences } from "@/lib/email-schedules";
import type { MyTasksLayout } from "@/lib/my-tasks";
import type { NotificationSettings } from "@/lib/notifications";

// Everything the Settings modal (and /settings/profile) shows about the signed-in person: their name,
// workspace role, teams, the comment-email switch, when they joined, and how they sign in.
export type MySettings = {
  name: string;
  // The name you set yourself (Settings → Profile), or null while it comes from your sign-in account.
  fullName: string | null;
  avatarUrl: string | null;
  email: string;
  isWorkspaceAdmin: boolean;
  workspaceName: string;
  // Settings → Workspace for members (Nov 3 notes, batch 19): what the workspace's admins set, read-only.
  workspaceLogoUrl: string | null;
  defaultTeamName: string | null;
  emailSenderName: string | null;
  teams: { id: string; name: string; lead: boolean }[];
  emailComments: boolean;
  // Real features 2: the Inbox / Email switch per kind (null on a database without its migration).
  notifications: NotificationSettings | null;
  // Real features 3: the Inbox digest and report email switches (null on a database without its migration).
  emailPreferences: EmailPreferences | null;
  joinedAt: string | null;
  signInMethod: "google" | "password";
  // How My tasks opens (the my_tasks_layout cookie), for Settings → Display.
  myTasksLayout: MyTasksLayout;
  // Oct 26 notes (batch 4): open my own saved view of a project first (null = a database without it).
  openPersonalView: boolean | null;
  // Nov 1 notes (batch 9b): what a task ticked on the My tasks checklist does (saved on the account).
  myTasksChecked: CheckedMode;
  // Nov 1 notes (batch 11): the workspace's workdays (the email digest only goes out on them).
  workWeek: number[];
  // Nov 3 notes (batch 19, 140): the person's own workdays (null = the organization's); undefined = a database
  // without this release's update.
  personalWorkWeek?: number[] | null;
};
