// Big move 1: the people area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { Tables } from "@/lib/supabase/database.types";
import type { TeamRole } from "@/lib/teams";

export type Profile = Pick<Tables<"profiles">, "id" | "email" | "full_name" | "avatar_url">;

// ---------------------------------------------------------------------------------------------
// Asana parity, batch 5: Home's People widget, the team page (curated work, calendar), and the
// Admin console (last activity, invite deliveries). Everything reads with the viewer's own client.
// ---------------------------------------------------------------------------------------------

export type Collaborator = { id: string; name: string; email: string; sharedProjects: number };

// ---------------------------------------------------------------------------------------------
// Person profile pages (Real features 2): /people/<id>. Everything reads with the viewer's own client,
// so the open tasks, activity, and projects shown are only ones RLS lets the viewer read; the
// workspace-wide last activity time comes from list_member_last_activity only for workspace admins and
// the person themselves.
// ---------------------------------------------------------------------------------------------

export type PersonTask = {
  id: string;
  title: string;
  dueOn: string | null;
  completedAt: string | null;
  kind: string;
  // The project to name: the first one the task was added to that the viewer can read (Oct 29 notes,
  // 55b: the stable rule); null for a private task.
  projectName: string | null;
  isSubtask: boolean;
};

export type PersonActivity = {
  id: string;
  at: string;
  kind: "story" | "comment";
  // Stories: the story kind (activityVerb()); comments: "comment".
  verb: string;
  taskId: string;
  taskTitle: string;
  // Comments: the first line of the comment.
  excerpt: string | null;
  // Back-to-back story lines of the same kind on the same task are folded into one (at = the newest).
  times: number;
};

export type PersonProfile = {
  id: string;
  name: string;
  email: string;
  joinedAt: string | null;
  status: "active" | "invited" | "removed" | "not_in_workspace";
  isWorkspaceAdmin: boolean;
  teams: { id: string; name: string; role: TeamRole }[];
  // Projects both can open: the person's memberships RLS shows the viewer (projects the viewer is in).
  projects: { id: string; name: string; role: string; archived: boolean }[];
  openTasks: PersonTask[];
  // How many open tasks assigned to them the viewer can read (openTasks shows the first PROFILE_TASK_LIMIT).
  openTaskCount: number;
  recentlyCompleted: PersonTask[];
  activity: PersonActivity[];
  // "workspace": from list_member_last_activity (workspace admins, or the person themselves);
  // "visible": the newest activity the viewer can read; null when there's none.
  lastActivity: { at: string | null; signedInAt: string | null; scope: "workspace" | "visible" };
};
