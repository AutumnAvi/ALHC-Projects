// Big move 1: the shell area's types (what the app shell, the "#" link picker, and the Members pages'
// project access panel load on demand). No database here; safe in the browser.
import type { ProjectRole } from "../../roles";

// The "#" link picker (Nov 3 notes, batch 18, 133): how many tasks and projects it lists.
export const LINK_SEARCH_MAX_TASKS = 6;
export const LINK_SEARCH_MAX_PROJECTS = 4;

// What the Settings modal's email card needs from the server's configuration. Environment switches, so
// the adapter reads them and hands them in.
export type SettingsEmailConfig = {
  // An email provider is set up (isEmailConfigured()).
  sending: boolean;
  // Replies come back: the Resend webhook secret is set (isInboundEmailConfigured()).
  inbound: boolean;
  // Forwarding can work here: inbound email is set up, plus what /api/inbound/email needs to read the
  // message and write the task (RESEND_API_KEY, the service-role key).
  forwarding: boolean;
  // The forwarding address for a token (its domain is configuration: forwardingAddress()).
  forwardingAddress: (token: string) => string;
};

export type PersonProjectAccessRow = {
  projectId: string;
  name: string;
  archived: boolean;
  role: ProjectRole;
  // Invited before their first sign-in (the membership starts then).
  pending: boolean;
  // The viewer may change this role (Admin+ of the project by their own role; owners for owners).
  canManage: boolean;
  // Roles the viewer may give here.
  grantable: ProjectRole[];
};

export type PersonProjectAccess = {
  rows: PersonProjectAccessRow[];
  // Projects the viewer administers that the person isn't in yet (Add to a project).
  addable: { id: string; name: string; grantable: ProjectRole[] }[];
  allowCommenter: boolean;
  // "Their default role" can be picked.
  defaultRoles: boolean;
};
