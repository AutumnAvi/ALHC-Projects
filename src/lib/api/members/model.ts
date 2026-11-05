// Big move 1: the members area's types (project members, invites, project roles). No database here; safe
// in the browser.
import type { ActionResult } from "@/lib/api/core/result";
import type { InviteOutcome } from "./invite";

// What an add-by-email Server Action answers: the usual result plus what happened (see InviteOutcome).
export type InviteActionResult = ActionResult & InviteOutcome;

// Adding someone with "Their default role" before this release's database update.
export const DEFAULT_ROLES_MISSING = "“Their default role” needs this release’s database update. Choose a role instead.";

// The roles a task can take people from (roles of its — its top-level task's — projects) and its links,
// for the task pane's Roles row. Read with the viewer's own client.
export type TaskRolesInfo = {
  roles: { id: string; name: string; projectName: string; personName: string | null }[];
  links: { roleId: string; slot: "assignee" | "approver" | "follower" }[];
};
