// Big move 1: the projects area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { Goal } from "@/lib/goals";
import type { ProjectRole } from "@/lib/roles";
import type { StatusTemplateSection } from "@/lib/status-templates";
import type { Tables } from "@/lib/supabase/database.types";

// Every read in the app goes through this module, and every query here filters deleted_at IS NULL —
// except listTrashedTasks(), which reads soft-deleted tasks for the Trash page on purpose. RLS keeps
// soft-deleted rows readable (trashed tasks: Editors and above only) so restore stays possible.

export type Project = Pick<
  Tables<"projects">,
  | "id"
  | "name"
  | "description"
  | "sort_order"
  | "approval_completes_task"
  | "status"
  | "status_note"
  | "status_updated_at"
  | "status_updated_by"
  | "archived_at"
  | "team_id"
  | "visibility"
>;

export const PROJECT_COLUMNS =
  "id, name, description, sort_order, approval_completes_task, status, status_note, status_updated_at, status_updated_by, archived_at, team_id, visibility";

export type Section = Pick<Tables<"sections">, "id" | "project_id" | "name" | "sort_order">;

export type ProjectMember = {
  profileId: string;
  role: ProjectRole;
  // Full name, else the email (displayName()).
  name: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  addedAt: string;
};

export type ProjectStatusUpdate = {
  id: string;
  projectId: string;
  status: string;
  // The status panel's title (Asana parity, batch 2); null for older updates and plain status changes.
  title: string | null;
  note: string | null;
  authorName: string | null;
  createdAt: string;
};

export type ProjectOverviewInfo = { createdAt: string; createdByName: string | null; dueOn: string | null };

export type ProjectStoryKind = "created_from_template" | "duplicated" | "archived" | "unarchived";

export type ProjectStoryItem = {
  id: string;
  kind: ProjectStoryKind;
  actorName: string | null;
  // The template or source project name, as it was at copy time.
  fromName: string | null;
  createdAt: string;
};

// Nov 1 notes, batch 12 (83): tasks of this project that were created by email, and comments that came
// in by email, newest first (task_email_activity, read with each task: only tasks the viewer can open).
export type ProjectEmailActivityItem = {
  id: string;
  kind: "task_created" | "comment_added";
  taskId: string;
  taskTitle: string;
  // The sender's name when they're a workspace person, else null (then senderEmail is shown).
  senderName: string | null;
  senderEmail: string;
  subject: string | null;
  createdAt: string;
};

export type ProjectGoalLink = { linkId: string; goal: Goal };

export type ProjectTeamAccess = { teamId: string; name: string; role: string; usesDefaultRoles: boolean };

export type ProjectOrigin = {
  kind: "created_from_template" | "duplicated";
  // Template or source project name, as it was at copy time.
  fromName: string | null;
  fromProjectId: string | null;
  actorName: string | null;
  createdAt: string;
};

// The Browse projects table's people and last-modified time (Asana parity, batch 4), for exactly the
// rows browse_projects returns, keyed by project. Null on a database without
// 20261011040000_asana_parity_4.sql (the table then shows member counts only).
export type BrowseProjectPeople = { ownerIds: string[]; memberIds: string[]; modifiedAt: string | null };

// Oct 27 notes (batch 5): the viewer's own Show / Hide completed for a project's List and Board (null = what
// the view says; also null on a database without this release).
// Nov 2 notes (batch 14, 95): a project's roles (Approver, Designer, Lead) and who fills each. Read with
// the viewer's own client (project Viewers+). A database without this release has none.
export type ProjectRoleDef = { id: string; projectId: string; name: string; profileId: string | null; sortOrder: number };

// A task's role links (which roles give its assignee, approvers, or followers).
export type TaskRoleLink = { roleId: string; slot: "assignee" | "approver" | "follower" };

// Nov 3 notes (batch 19, 146): everything that follows a role, for the "Change all current tasks …?" prompt:
// the open tasks linked to it (and how: assignee, approver, follower) and the automations that name it
// (they use whoever fills it when they run, so they follow the change on their own). Read with the
// viewer's own client: only tasks and automations they can read.
export type RoleUsage = {
  tasks: { id: string; title: string; slots: string[]; assigneeId: string | null }[];
  taskTotal: number;
  automations: { id: string; name: string; enabled: boolean }[];
};

// Files tab: every active attachment on the project's active tasks and their subtasks (read through
// RLS, so only tasks the viewer can read), newest first.
export type ProjectFile = {
  id: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
  uploadedBy: string;
  // Where it came from (Real features 1): uploaded in the app, a form submitter's file, or a forwarded
  // email's attachment. A form file's uploadedBy is a stand-in (the form's creator), so Files says "Form".
  source: "upload" | "form" | "email";
  createdAt: string;
  taskId: string;
  taskTitle: string;
};

// Teams a new project can go in (the New project dialog's team picker): the viewer's teams plus the
// default team, default first.
export type ProjectTeamChoice = { id: string; name: string; isDefault: boolean };

// Customize → Status templates: what the template editor saves (checked by the layer before writing).
export type StatusTemplateInput = {
  name: string;
  status: string | null;
  title: string | null;
  sections: StatusTemplateSection[];
};
