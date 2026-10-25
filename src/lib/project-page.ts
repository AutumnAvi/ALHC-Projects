// Project page vocabulary (Asana parity, batch 2), shared by server and browser code: the status panel,
// the Share dialog's data, and the Overview's activity. The database decides everything for real
// (set_project_status / post_project_status_update, add_project_member, add_team_to_project, RLS).

import type { ProjectIntegrations } from "@/lib/integrations-shared";
import type { ProjectRole } from "@/lib/roles";
import type { PendingInvite, ProjectVisibility } from "@/lib/workspace";

// project_status_updates.title (CHECK 1–200 characters; post_project_status_update()).
export const STATUS_TITLE_MAX = 200;
// set_project_status(): the summary is the update's note.
export const STATUS_SUMMARY_MAX = 2000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Asana's default title: "Status update — Oct 11" (the viewer's local date).
export function defaultStatusTitle(now: Date = new Date()) {
  return `Status update — ${MONTHS[now.getMonth()]} ${now.getDate()}`;
}

export type SharePerson = { id: string; name: string; email: string };

export type ShareMember = {
  profileId: string;
  name: string;
  email: string;
  role: ProjectRole;
};

export type ShareTeam = { id: string; name: string; memberCount: number };

// Everything the Share dialog shows, read with the viewer's own client when it opens.
export type ShareData = {
  viewerId: string;
  viewerRole: ProjectRole;
  // The project's team and who can find the project (Public to team = its members can join as Editor).
  team: ShareTeam | null;
  visibility: ProjectVisibility;
  members: ShareMember[];
  // Invited before their first sign-in.
  invites: PendingInvite[];
  // Invite emails go out and can be sent again (Real features 1's database update is applied and an email
  // provider is set up).
  resendable: boolean;
  // Teams added with a group invite (a record of the invite; the people are ordinary members).
  addedTeams: (ShareTeam & { role: string; usesDefaultRoles: boolean })[];
  // The invite search: people in the workspace and every team.
  people: SharePerson[];
  teams: ShareTeam[];
  // The workspace offers the Commenter role (off by default; existing Commenters keep it).
  allowCommenter: boolean;
  // "Their default role" can be picked (the Oct 25 notes' database update is applied).
  defaultRoles: boolean;
};

// The Overview tab's activity timeline (newest first): status updates, people joining, the project
// being created, and project-level stories (copies, archive / unarchive).
export type ProjectActivityItem =
  | { kind: "status"; id: string; at: string; status: string; title: string | null; note: string | null; by: string | null }
  | { kind: "joined"; id: string; at: string; name: string }
  | { kind: "created"; id: string; at: string; by: string | null }
  | {
      kind: "story";
      id: string;
      at: string;
      story: "created_from_template" | "duplicated" | "archived" | "unarchived";
      by: string | null;
      fromName: string | null;
    };

const ACTIVITY_ORDER: Record<ProjectActivityItem["kind"], number> = { status: 0, story: 1, joined: 2, created: 3 };

// Newest first; at the same moment (a new project and its owner joining) "created" comes last.
export function sortActivity(items: ProjectActivityItem[]): ProjectActivityItem[] {
  return [...items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || ACTIVITY_ORDER[a.kind] - ACTIVITY_ORDER[b.kind]);
}

// Customize → Emails and Apps (loadCustomizeDetails): Admin+ only; hints, names, and counts — never a
// URL or secret.
export type CustomizeDetails = {
  admin: boolean;
  integrations: ProjectIntegrations | null;
  inbound: { id: string; name: string; enabled: boolean }[] | null;
  deliveries: { failed: number; waiting: number; emailsSent: number } | null;
};
