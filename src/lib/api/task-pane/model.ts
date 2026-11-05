// Big move 1: the task-pane area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { CommentRefs } from "@/lib/api/comments/model";
import type { Profile } from "@/lib/api/people/model";
import type { Section } from "@/lib/api/projects/model";
import type { SubtaskItem } from "@/lib/api/tasks/model";
import type { CommentEmail } from "@/lib/comment-email";
import type { TaskSchedule } from "@/lib/critical-path";
import type { DependencyKind } from "@/lib/dependencies";
import type { DeliveryStatus } from "@/lib/email-schedules";
import type { FieldDef } from "@/lib/fields";
import type { MentionTeam } from "@/lib/mentions";
import type { ReactionKey } from "@/lib/reactions";
import type { Recurrence } from "@/lib/recurrence";
import type { SkipReason } from "@/lib/reply-attachments";
import type { RequestLabel, TaskNumber } from "@/lib/request-numbers";
import type { ProjectRole } from "@/lib/roles";
import type { PartialRun } from "@/lib/run-outcome";
import type { Json } from "@/lib/supabase/database.types";
import type { Tag } from "@/lib/tags";
import type { AfterApproval, ApprovalTaskStatus, TaskKind } from "@/lib/task-kinds";

// One project of the task the viewer can read. TaskDetail.memberships lists them in the stable order
// (Oct 29 notes, 55b: the order the task was added to them; there's no home project), so the first one is
// the task's link / default project.
export type TaskMembership = {
  projectId: string;
  projectName: string;
  sectionId: string | null;
  sections: Pick<Section, "id" | "name">[];
};

export type TaskDetail = {
  id: string;
  title: string;
  kind: TaskKind;
  notes: string | null;
  completedAt: string | null;
  startOn: string | null;
  dueOn: string | null;
  startAt: string | null;
  dueAt: string | null;
  timeZone: string | null;
  recurrence: Recurrence | null;
  recurrenceSeq: number;
  // The occurrence spawned when this one was completed (if it still exists).
  nextOccurrenceId: string | null;
  dependencies: TaskDependency[];
  // Incomplete finish-to-start predecessors the viewer can't open (they still block completion).
  hiddenBlockers: number;
  // Projects (with sections) where the viewer is an Editor among the task's projects (a subtask: its root's).
  editableProjectIds: string[];
  assigneeId: string | null;
  // The first of the task's projects the viewer can read (Oct 29 notes, 55b: memberships[0], the stable
  // rule; never the database's internal pointer, which may be a project the viewer can't open). Null for a
  // private task (and its subtasks): no project; only its creator and assignee can read it.
  homeProjectId: string | null;
  createdAt: string;
  updatedAt: string;
  source: string;
  // The request number with its project's bracket setting (task numbering on), else null. Since Oct 29
  // notes (55b) the first number the viewer can read in the stable order (no home project).
  requestLabel: RequestLabel | null;
  canAssignRequestNumber: boolean;
  // `name`: the requester's name from the form's required name question (Nov 1 notes, batch 8), else a
  // short answer to a question labelled like a name, else null.
  submission: { email: string; name: string | null; formId: string; formTitle: string | null; createdAt: string } | null;
  // The database has Comments and reply by email (20261014030000): responses to a form's submitter can
  // be sent (see canRespondToSubmitter()).
  submitterResponses: boolean;
  // Nov 1 notes, item 69: whether this request's reply-by-email conversation is on (a verified-domain
  // submitter, or a workspace admin allowed it), and why. Null without a submitter or the update.
  submitterConversation?: SubmitterConversation | null;
  // The request's reply thread (the top-level task's), once someone sent the submitter a response:
  // closed = the submitter's replies are refused. Null without one (or without the database update).
  // subject = the conversation's subject (every response and reply in it keeps it), null before Oct 19 notes.
  replyThread: {
    closed: boolean;
    closedAt: string | null;
    closedByName: string | null;
    submitterEmail: string;
    subject: string | null;
  } | null;
  approvals: TaskApproval[];
  // Approval tasks: approvers, status, rounds (null for other kinds, or before Oct 27 notes, batch 6).
  approval: TaskApprovalInfo | null;
  // The task's number in each of its projects the viewer can read (projectId → label; Oct 27 notes, batch 6).
  projectNumbers: Record<string, RequestLabel>;
  // The same numbers as a list in the stable order (Oct 29 notes, 55b: the pane's number chips, "Req #1 ·
  // Design #14"); subtasks carry their path in each project. requestLabel is the first one.
  taskNumbers?: TaskNumber[];
  // Direct subtasks, in order.
  subtasks: SubtaskItem[];
  // Set for a subtask: its parent, and the way up from the top-level task (root first) for the breadcrumb.
  parentTaskId: string | null;
  ancestors: { id: string; title: string; completedAt: string | null }[];
  // A subtask's memberships are its root task's (read-only in its pane: subtasks never have their own).
  isSubtask: boolean;
  memberships: TaskMembership[];
  fields: FieldDef[];
  fieldValues: Record<string, Json>;
  followerIds: string[];
  attachments: TaskAttachment[];
  // Attachments that stayed in Asana (imported as name + link, no file copy).
  attachmentLinks: TaskAttachmentLink[];
  comments: TaskComment[];
  // Non-deleted comments on the task (the Comments tab). `comments` is the newest page.
  commentTotal: number;
  // Set when an older page exists. The pane passes it to loadOlderComments.
  olderComments: { beforeAt: string; beforeId: string } | null;
  stories: TaskStory[];
  // Nov 1 notes, batch 12 (84): this task's automation runs (newest TASK_RUN_LIMIT, oldest first), drawn as
  // thin markers in All activity. Only automations of projects the viewer can read (rule_runs RLS).
  ruleRuns?: TaskRuleRun[];
  // Nov 1 notes, batch 12 (83): the task (or a comment on it) came in by email. Empty without the update.
  emailActivity?: TaskEmailActivity[];
  // Nov 1 notes, batch 9a (10.4): the task's pinned comments, newest pin first (also in `comments` when
  // they're on the loaded page). Empty without the update.
  pinnedComments?: TaskComment[];
  // Nov 1 notes, batch 9a (10.3): names of the tasks and projects that comments link to, read with the
  // viewer's own access (an id that isn't here is one they can't open).
  commentRefs?: CommentRefs;
  // Teams whose @name in a comment shows as a pill with the team's members (display only).
  mentionTeams: MentionTeam[];
  // The viewer's highest role across the task's projects (null: read access through nothing).
  viewerRole: ProjectRole | null;
  // Best role of each member of the task's visible projects: who can be assigned, follow, approve.
  memberRoles: Record<string, ProjectRole>;
  // The viewer's own role in each of the task's projects (archived = Viewer): a field's values are
  // changed through its project, so a locked field only by that project's Owners and Admins (Oct 29
  // notes, batch 7). Absent = unknown (the task-level role decides).
  viewerProjectRoles?: Record<string, ProjectRole>;
  tagIds: string[];
  // A private task (no project; for a subtask: its top-level task is private). Only its top-level task's
  // creator and assignee (privateReaderIds) can read it, so only they can be assigned or follow.
  isPrivate: boolean;
  privateReaderIds: string[];
};

export type TaskDependency = {
  id: string;
  // blocked_by: the other task comes first; blocking: the other task waits on this one.
  relation: "blocked_by" | "blocking";
  kind: DependencyKind;
  lagDays: number;
  taskId: string;
  title: string;
  completedAt: string | null;
  // The other task is a subtask (it has no projects of its own).
  isSubtask: boolean;
};

// Each task carries its number (when its project numbers tasks) and, for a project other than the open
// task's own, the project's name, so the picker can show "Task #12 · Website" (Oct 26 notes, batch 4).
type DependencyCandidate = {
  id: string;
  title: string;
  label?: RequestLabel | null;
  projectName?: string | null;
};

export type DependencyCandidateGroup = { key: string; label: string; tasks: DependencyCandidate[] };

// The pane's on-demand part (Oct 19 notes): the tasks the Dependencies picker and Convert offer, and the
// slack in each project. On a big project these two reads take seconds (row-by-row RLS over every task),
// so they stay off the path that opens a task; getTaskExtras() loads them when the pane needs them.
export type TaskExtras = {
  // Tasks that can be linked: active tasks of projects where the viewer is an Editor (the task's own
  // projects first, then others), plus the other tasks and subtasks of the same task tree.
  dependencyCandidates: DependencyCandidateGroup[];
  // Slack / critical path in each of the task's projects (project_critical_path); empty without a due date.
  schedule: (TaskSchedule & { projectId: string; projectName: string })[];
};

// Imported Asana attachments (name + link), and a duplicated task's links to the original's files
// (attachmentId: opened through /attachments/<id>, which checks access to the original).
export type TaskAttachmentLink = { id: string; source: string; name: string; url: string | null; attachmentId: string | null };

export type TaskAttachment = {
  id: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
  // upload | form | email (Real features 1): "form" files are the request's own (Nov 1 notes, item 72:
  // shown under the description as "Original request").
  source?: string;
};

export type TaskApproval = {
  id: string;
  subtaskId: string | null;
  approverId: string;
  requestedBy: string | null;
  ruleName: string | null;
  note: string | null;
  status: "pending" | "approved" | "changes_requested" | "rejected" | "cancelled";
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  // Approval tasks (Oct 27 notes, batch 6): the round it belongs to, and why it was cancelled.
  roundId?: string | null;
  cancelReason?: string | null;
  handoffTo?: string | null;
  handoffNote?: string | null;
};

// An approval task's approval (Oct 27 notes, batch 6): who approves, how, by when, and every round.
export type ApprovalRound = {
  id: string;
  number: number;
  status: "pending" | "approved" | "changes_requested" | "rejected" | "withdrawn";
  mode: "any" | "all";
  finalText: string | null;
  attachmentIds: string[];
  moreSteps: boolean;
  afterApproval: AfterApproval;
  moveSectionId: string | null;
  moveSectionName: string | null;
  dueOn: string | null;
  sentBy: string | null;
  sentAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  acknowledgedAt: string | null;
  withdrawnAt: string | null;
  // This round's requests (one per approver), oldest first.
  requests: TaskApproval[];
};

export type TaskApprovalInfo = {
  // The guided setup's follow-up (Nov 1 notes, batch 9a): what happens after approval (null = not chosen:
  // complete the task), its section, and whether approvers get due-date reminders. Ready for approval
  // starts from it. Null on a database without this release's update.
  followUp?: { afterApproval: AfterApproval | null; sectionId: string | null; reminders: boolean } | null;
  approverIds: string[];
  mode: "any" | "all";
  dueOn: string | null;
  status: ApprovalTaskStatus;
  paused: boolean;
  waitingOnMe: boolean;
  // Newest first.
  rounds: ApprovalRound[];
};

export type TaskComment = {
  id: string;
  authorId: string | null;
  ruleName: string | null;
  // Nov 1 notes, batch 12 (84): the automation that posted it, and its project when the viewer can read
  // the automation (then "Automation · <name>" links to it).
  ruleId?: string | null;
  ruleProjectId?: string | null;
  // Empty for a deleted comment (shown as a "Comment deleted" placeholder).
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  mentionIds: string[];
  // Active reactions, in the fixed REACTIONS order; only emoji someone used.
  reactions: { emoji: ReactionKey; profileIds: string[] }[];
  // A response emailed to the form's submitter, or the submitter's emailed reply (no author).
  email: CommentEmail | null;
  // A received reply's attachments (saved to the task) and the ones that weren't saved, with why.
  emailFiles?: { id: string; name: string; sizeBytes: number; contentType: string | null }[];
  emailSkipped?: { name: string; reason: SkipReason }[];
  // Oct 26 notes (batch 3): the review check whose outcome this comment reports.
  reviewCheckId?: string | null;
  // Nov 1 notes, batch 9a (Asana test 10.4): pinned to the top of the feed (set_comment_pinned).
  pinnedAt?: string | null;
  pinnedBy?: string | null;
};

// Nov 1 notes, batch 12 (84): one automation run on the task (rule_runs), for the activity's run markers.
export type TaskRuleRun = {
  id: string;
  ruleId: string;
  ruleName: string;
  projectId: string;
  status: "succeeded" | "scheduled" | "skipped" | "failed";
  // skipped: loop | depth_limit | throttled | rate_limited; failed: the error.
  reason: string | null;
  createdAt: string;
  // Nov 4 notes, batch 24 (157): it finished, but an action was skipped (run-outcome.ts).
  partial?: PartialRun | null;
};

// Nov 1 notes, batch 12 (83): the task was created by email, or a comment came in by email
// (task_email_activity).
export type TaskEmailActivity = {
  id: string;
  kind: "task_created" | "comment_added";
  senderEmail: string;
  senderProfileId: string | null;
  subject: string | null;
  commentId: string | null;
  createdAt: string;
};

export type TaskStory = {
  id: string;
  actorId: string | null;
  kind: string;
  data: Json;
  createdAt: string;
  // email_queued stories: the email's live delivery state (null when the row is gone, e.g. purged).
  email?: StoryEmailStatus | null;
};

export type StoryEmailStatus = {
  status: "pending" | "sending" | "sent" | "mocked" | "failed";
  error: string | null;
  attempts: number;
  maxAttempts: number;
  // What Resend reported after sending (Real features 3; null before anything was reported).
  delivery?: DeliveryStatus | null;
};

// Nov 4 notes (batch 22, M1): task_pane_rows() (one call for the pane's reads), or null on a database
// without it (or for an id that isn't a uuid), so getTaskDetail reads them one by one as before.
export type TaskPaneRows = Record<string, Json | undefined>;

// The pane's on-demand parts (see TaskExtras), one at a time: "candidates" = the Dependencies picker's and
// Convert's tasks (Editors), "schedule" = the slack in each project (a dated top-level task). The other
// part comes back empty. Null when the task isn't readable.
export type TaskExtrasPart = "schedule" | "candidates";

// What the pane needs besides the task: the viewer, the projects they can add a task to, people, tags.
export type TaskPaneContext = {
  memberId: string;
  projects: { id: string; name: string; canAdd: boolean }[];
  profiles: Profile[];
  tags: Tag[];
};

// One pane load (the page's server render of an open task, or GET /api/task-pane/<id>). loadedAt is when
// the reads started (server clock), so the client keeps whichever copy is newer.
export type TaskPanePayload = { task: TaskDetail | null; context: TaskPaneContext | null; loadedAt: number };

// Whether a request's reply-by-email conversation is on (submitter_conversation_status). Null when the
// task has no form submitter, or without this release's database update.
export type SubmitterConversation = {
  allowed: boolean;
  reason: "override_request" | "override_submitter" | "setting_off" | "verified" | "unverified";
  email: string;
  domain: string;
  verified: boolean;
  canOverride: boolean;
};

export function parseSubmitterConversation(value: Record<string, Json | undefined>): SubmitterConversation | null {
  const reasons = ["override_request", "override_submitter", "setting_off", "verified", "unverified"] as const;
  const reason = reasons.find((r) => r === value.reason);
  if (!reason || typeof value.email !== "string") return null;
  return {
    allowed: value.allowed === true,
    reason,
    email: value.email,
    domain: typeof value.domain === "string" ? value.domain : "",
    verified: value.verified === true,
    canOverride: value.can_override === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Nov 1 notes, batch 9a: pinned comments (10.4) and links in comments (10.3)
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Nov 1 notes, batch 12: automation runs and email-in activity on a task (83, 84)
// ---------------------------------------------------------------------------------------------

// How many of a task's latest automation runs the activity shows (a scheduled automation can run on a
// task every day; older markers aren't worth the payload).
export const TASK_RUN_LIMIT = 100;
