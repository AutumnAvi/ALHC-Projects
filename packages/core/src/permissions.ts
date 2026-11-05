// What a project role lets someone do in the app (Oct 26 notes): the one place the UI turns a role into
// "can edit", "can comment", "can manage". Every view, row, card, and the task pane asks this instead of
// comparing roles itself, so a control a role can't use is hidden (or read-only) everywhere alike.
// RLS stays the source of truth; this only decides what to draw.
import { hasRole, type ProjectRole } from "./roles";

export type Permissions = {
  role: ProjectRole | null;
  // Read the project / task (every member).
  canView: boolean;
  // Comment, react, follow, decide approvals they're named on (Commenter+).
  canComment: boolean;
  // Create, edit, complete, move, select, drag, add tasks and sections (Editor+).
  canEdit: boolean;
  // Members, rules, forms, settings (Admin+ — owners, and older Admin memberships).
  canManage: boolean;
  // Ownership and deleting the project.
  isOwner: boolean;
  // One line for read-only places (the task pane's header), null for editors.
  readOnlyNote: string | null;
};

export function permissionsFor(role: ProjectRole | null | undefined): Permissions {
  const known = role ?? null;
  const canEdit = hasRole(known, "editor");
  const canComment = hasRole(known, "commenter");
  return {
    role: known,
    canView: hasRole(known, "viewer"),
    canComment,
    canEdit,
    canManage: hasRole(known, "admin"),
    isOwner: hasRole(known, "owner"),
    readOnlyNote: canEdit ? null : canComment ? "You can comment on this task" : "View only",
  };
}

// Nov 2 security fix (note 119): what picking a person in the task's Followers list does. Commenters
// follow and unfollow themselves and add people; removing someone else is an Editor's (the database's
// follower policies refuse it below Editor). null = nothing (the control isn't offered).
export function followerChange(
  permissions: Pick<Permissions, "canComment" | "canEdit">,
  memberId: string,
  profileId: string,
  following: boolean,
): "add" | "remove" | null {
  if (!permissions.canComment) return null;
  if (!following) return "add";
  return profileId === memberId || permissions.canEdit ? "remove" : null;
}

// A task's permissions come from the viewer's role on the task (task_role(): the highest of its projects,
// a subtask through its root, Editor for a private task's creator and assignee).
export function taskPermissions(task: { viewerRole: ProjectRole | null }): Permissions {
  return permissionsFor(task.viewerRole);
}

// The highest of several roles (a task in several projects counts its best one, like task_role()).
export function bestRole(roles: Iterable<ProjectRole | null | undefined>): ProjectRole | null {
  let best: ProjectRole | null = null;
  for (const role of roles) {
    if (!role) continue;
    if (!best || (hasRole(role, best) && role !== best)) best = role;
  }
  return best;
}
