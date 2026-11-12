// AI builder round 5 (experimental, branch feat/ai-builder-p5, note 178): the ONE capability registry —
// every action the AI assistant and the MCP endpoint may take, with who may take it. Pure (no network, no
// database): this file is the table; packages/core/src/api/capabilities/ holds each tool's handler (what it
// reads, stages, writes through the existing typed API, and undoes).
//
// It replaces round 4's AI_CAPABILITIES table and round 3's fixed operation list. Used in five places:
//   * the model's tools (Anthropic tool use: one input schema per tool, toolInputSchema),
//   * the model's context (which kinds of change this person may make in each project: allowedGroups),
//   * the resolver and Confirm (capabilityRefusal — the same rule, checked again against the database just
//     before every write),
//   * the MCP endpoint's tool list (the same schemas, ids instead of refs),
//   * answer mode's help and the PR / docs role matrix (registryHelp, capabilityMatrix).
//
// Every rule MIRRORS what the person can do by hand (AGENTS.md's role matrix); the AI never does more. An
// archived project counts everyone as a Viewer. In the app, Commenters and Viewers get answers only from the
// assistant (canChangeIn); over MCP each tool's own role applies (a Commenter may comment, as by hand).
import { hasRole, ROLE_LABELS, type ProjectRole } from "./roles";

export type ToolGroup =
  | "read"
  | "tasks"
  | "approvals"
  | "collaboration"
  | "sections"
  | "projects"
  | "members"
  | "fields"
  | "automations"
  | "my_automations"
  | "portfolio_automations"
  | "views"
  | "forms"
  | "workspace"
  | "personal";

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  read: "Look things up",
  tasks: "Tasks and subtasks",
  approvals: "Approvals",
  collaboration: "Comments, followers, tags, dependencies, files",
  sections: "Sections",
  projects: "Projects, status, templates",
  members: "Members and project roles",
  fields: "Custom fields",
  automations: "Project automations",
  my_automations: "My Tasks automations",
  portfolio_automations: "Portfolio automations",
  views: "Views and dashboard widgets",
  forms: "Forms",
  workspace: "Portfolios, goals, teams",
  personal: "Your own: My Tasks sections, sidebar, Inbox, dashboards",
};

// What a tool's target is checked against. project = the person's role in the project (minRole);
// personal = the person's own things (any pilot admin); workspace = something of the pilot workspace whose
// own rules decide (a portfolio's, team's, or goal's role, the tag's creator) — the typed API's RPCs and RLS
// refuse anything else, and the target must be in the pilot.
export type ToolScope = "project" | "personal" | "workspace";

export type RefKind =
  | "task"
  | "project"
  | "section"
  | "field"
  | "rule"
  | "comment"
  | "tag"
  | "dependency"
  | "attachment"
  | "approval"
  | "view"
  | "widget"
  | "form"
  | "portfolio"
  | "goal"
  | "team"
  | "my_section"
  | "my_rule"
  | "portfolio_rule"
  | "project_role"
  | "template"
  | "dashboard"
  | "folder"
  | "inbox_item";

export const REF_PREFIX: Record<RefKind, string> = {
  task: "T",
  project: "P",
  section: "S",
  field: "F",
  rule: "R",
  comment: "C",
  tag: "G",
  dependency: "X",
  attachment: "A",
  approval: "AP",
  view: "V",
  widget: "W",
  form: "FM",
  portfolio: "PF",
  goal: "GL",
  team: "TM",
  my_section: "MS",
  my_rule: "MR",
  portfolio_rule: "PR",
  project_role: "RL",
  template: "TP",
  dashboard: "D",
  folder: "FD",
  inbox_item: "I",
};

export type Param =
  | { t: "ref"; kind: RefKind; d: string; req?: true }
  | { t: "refs"; kind: RefKind; d: string; req?: true; max?: number }
  | { t: "str"; d: string; req?: true; max?: number }
  | { t: "int"; d: string; req?: true; min?: number; max?: number }
  | { t: "bool"; d: string; req?: true }
  | { t: "enum"; values: readonly string[]; d: string; req?: true }
  | { t: "strs"; d: string; req?: true; max?: number }
  | { t: "date"; d: string; req?: true }
  | { t: "person"; d: string; req?: true }
  | { t: "people"; d: string; req?: true }
  | { t: "automation"; system: "project" | "my_tasks" | "portfolio"; d: string; req?: true };

export type ToolMeta = {
  group: ToolGroup;
  kind: "read" | "write";
  label: string;
  description: string;
  // Where people do it by hand (answer mode's help).
  where: string;
  scope: ToolScope;
  // project scope: the lowest project role that may do it by hand.
  minRole?: ProjectRole;
  // Extra conditions beyond the role, in plain words (matrix, help).
  also?: string;
  // Deletes or removes something (red in the change set, with counts; MCP, like every change there, needs confirm: true).
  destructive?: boolean;
  // Messages people (an Inbox item, an email, a comment) — needs its own explicit confirmation that names
  // who (in the app: a tick; over MCP: confirm: true).
  notifies?: boolean;
  // Undo: "yes" (the change can be put back), "no" (said before Confirm).
  undo: "yes" | "no";
  // Section changes follow the project's section lock (only its Owners while locked).
  sectionLock?: true;
  params: Record<string, Param>;
  // Only offered over MCP / only to the in-app assistant.
  only?: "mcp" | "assistant";
};

const ref = (kind: RefKind, d: string, req = true): Param => (req ? { t: "ref", kind, d, req } : { t: "ref", kind, d });
const opt = <P extends Param>(p: P): P => {
  const { req: _req, ...rest } = p as P & { req?: true };
  void _req;
  return rest as P;
};
const s = (d: string, max = 200): Param => ({ t: "str", d, req: true, max });
const so = (d: string, max = 200): Param => ({ t: "str", d, max });
const KINDS = ["task", "milestone", "approval"] as const;
const ROLES = ["owner", "admin", "editor", "commenter", "viewer"] as const;
const STATUSES = ["on_track", "at_risk", "off_track", "on_hold", "complete"] as const;

export const AI_TOOLS = {
  // ---- Read (run at once, never staged) -------------------------------------------------------------
  search_tasks: {
    group: "read", kind: "read", scope: "personal", undo: "yes", label: "Search tasks", where: "the search box (⌘K)",
    description: "Find tasks by words in their name, description, or number. Returns task refs to use in other tools.",
    params: { query: s("words to find"), project: ref("project", "only in this project", false), include_completed: { t: "bool", d: "include completed tasks" }, include_deleted: { t: "bool", d: "only tasks in the Trash" } },
  },
  search_projects: {
    group: "read", kind: "read", scope: "personal", undo: "yes", label: "Search projects", where: "the sidebar and Browse projects",
    description: "Find projects of the Testing data workspace you can open, by name.",
    params: { query: so("words in the name (empty = all)") },
  },
  search_people: {
    group: "read", kind: "read", scope: "personal", undo: "yes", label: "Find people", where: "a project's Share dialog",
    description: "Find people of the Testing data workspace by name (aliases to use for assignees, approvers, followers).",
    params: { query: s("a name or part of one") },
  },
  get_task: {
    group: "read", kind: "read", scope: "personal", undo: "yes", label: "Read a task", where: "the task pane",
    description: "A task's details: section, assignee, dates, type, approvers, field values, subtasks, tags, dependencies, files, recent comments, approvals.",
    params: { task: ref("task", "the task") },
  },
  get_project: {
    group: "read", kind: "read", scope: "personal", undo: "yes", label: "Read a project", where: "the project page",
    description: "A project's sections, fields, members, views, forms, automations, project roles, and task templates.",
    params: { project: ref("project", "the project") },
  },
  get_automation: {
    group: "read", kind: "read", scope: "personal", undo: "yes", label: "Read an automation", where: "the automation builder",
    description: "An automation's whole When / If / Then, in the form update_automation takes.",
    params: { automation: ref("rule", "the automation") },
  },
  list_my_things: {
    group: "read", kind: "read", scope: "personal", undo: "yes", label: "List your own things", where: "My tasks, the sidebar, the Inbox, Reports",
    description: "Your My Tasks sections and automations, sidebar folders, unread Inbox items, personal dashboards, portfolios, goals, teams, and tags.",
    params: { what: { t: "enum", values: ["my_sections", "my_automations", "folders", "inbox", "dashboards", "portfolios", "goals", "teams", "tags", "project_templates"], d: "what to list", req: true } },
  },
  find_tools: {
    group: "read", kind: "read", scope: "personal", undo: "yes", label: "Find more tools", where: "—", only: "assistant",
    description: "Look up tools for a kind of change not in your current tool list (e.g. 'goals', 'forms', 'inbox'); the tools found become available.",
    params: { query: s("what you want to do") },
  },

  // ---- Tasks ----------------------------------------------------------------------------------------
  create_task: {
    group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Create a task", where: "+ Add task in a project's toolbar",
    description: "Add a task to a project (optionally a section, assignee, dates, type, description).",
    params: {
      project: ref("project", "the project"), title: s("the task's name", 500), section: opt(ref("section", "a section of that project (or one made earlier in this change set, by name)")),
      assignee: { t: "person", d: "who does it" }, due: { t: "date", d: "due date" }, start: { t: "date", d: "start date" },
      kind: { t: "enum", values: KINDS, d: "task type" }, description: so("the description", 10000),
    },
  },
  create_subtask: {
    group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Add a subtask", where: "the task pane's Subtasks",
    description: "Add a subtask under a task (or under a task made earlier in this change set).",
    params: { parent: ref("task", "the parent task"), title: s("the subtask's name", 500), assignee: { t: "person", d: "who does it" }, due: { t: "date", d: "due date" } },
  },
  duplicate_task: {
    group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Duplicate a task", where: "the task pane's … → Duplicate",
    description: "Copy a task with its subtasks, assignee, dates, tags, and field values.", params: { task: ref("task", "the task"), title: so("the copy's name", 500) },
  },
  rename_task: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Rename a task or subtask", where: "the task pane's title", description: "Change a task's name.", params: { task: ref("task", "the task"), name: s("the new name", 500) } },
  set_description: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Change a description", where: "the task pane's Description", description: "Replace a task's description (\"\" clears it).", params: { task: ref("task", "the task"), text: { t: "str", d: "the whole new description", max: 10000, req: true } } },
  move_task: {
    group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Move a task", where: "drag in List / Board, or the pane's Projects row", also: "Editor of both projects to move it to another",
    description: "Move a task to a section (\"none\" = no section), or to another project.",
    params: { task: ref("task", "the task"), section: { t: "str", d: "a section ref, \"none\", or the name of a section made earlier in this change set" }, project: opt(ref("project", "another project to move it to")) },
  },
  add_task_to_project: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Also add a task to another project", where: "the pane's Projects row", also: "Editor of both projects", description: "Multi-home a task: it stays where it is and also shows in another project.", params: { task: ref("task", "the task"), project: ref("project", "the other project") } },
  remove_task_from_project: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", destructive: true, label: "Remove a task from a project", where: "the pane's Projects row", also: "not its last project", description: "Take a task out of one of its projects (it stays in the others).", params: { task: ref("task", "the task"), project: ref("project", "the project to leave") } },
  assign_task: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Assign a task", where: "the pane's Assignee", also: "only to the project's members", description: "Assign a task (\"none\" unassigns). Person: an alias, a name, or \"me\".", params: { task: ref("task", "the task"), person: { t: "person", d: "who", req: true } } },
  set_dates: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Set dates", where: "the pane's Due date", description: "Set a task's due and/or start date (YYYY-MM-DD; \"none\" clears; leave out to keep).", params: { task: ref("task", "the task"), due: { t: "date", d: "due date" }, start: { t: "date", d: "start date" } } },
  set_recurrence: {
    group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Make a task repeat", where: "the date picker's Repeats",
    description: "Repeat a task (or \"never\" to stop).",
    params: { task: ref("task", "the task"), frequency: { t: "enum", values: ["never", "daily", "weekly", "monthly", "yearly"], d: "how often", req: true }, interval: { t: "int", d: "every N (1–365)", min: 1, max: 365 }, weekdays: { t: "strs", d: "weekly: days (sun, mon, …)", max: 7 }, until: { t: "date", d: "stop after this date" } },
  },
  complete_task: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Complete a task", where: "the check mark", also: "never a blocked task; an approval task only by its approvers", description: "Mark a task complete.", params: { task: ref("task", "the task") } },
  reopen_task: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Reopen a task", where: "the check mark", description: "Mark a completed task incomplete.", params: { task: ref("task", "the task") } },
  delete_task: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", destructive: true, label: "Delete a task", where: "the pane's … → Delete", also: "goes to the Trash with its subtasks", description: "Move a task (and its subtasks) to the Trash.", params: { task: ref("task", "the task") } },
  restore_task: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Restore a task from the Trash", where: "Project … → Trash", description: "Bring back a deleted task (search_tasks with include_deleted finds it).", params: { task: ref("task", "the deleted task") } },
  convert_to_subtask: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Make a task a subtask", where: "the pane's … → Make a subtask of…", description: "Put a task under another task.", params: { task: ref("task", "the task"), parent: ref("task", "its new parent") } },
  convert_to_task: { group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Make a subtask a task", where: "the pane's … → Convert to main task", description: "Turn a subtask into a top-level task in a project.", params: { task: ref("task", "the subtask"), project: opt(ref("project", "the project (default: its parent's)")), section: opt(ref("section", "a section of that project")) } },
  set_task_type: {
    group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Set a task's type", where: "the pane's … → Task type",
    description: "Make a task a task, a milestone, or an approval. For an approval, also name approvers (then set_approvers isn't needed).",
    params: { task: ref("task", "the task"), kind: { t: "enum", values: KINDS, d: "the type", req: true }, approvers: { t: "people", d: "approval only: who approves (aliases, names, or \"me\")" }, mode: { t: "enum", values: ["any", "all"], d: "approval only: any one or everyone" } },
  },
  bulk_edit: {
    group: "tasks", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Change many tasks at once", where: "the bulk bar (tick several rows)", also: "each task is checked on its own; more than 10 tasks is marked as a big change",
    description: "Apply one change to several tasks (up to 50): complete, reopen, delete, assign, set_due, move_section, add_tag, remove_tag.",
    params: { tasks: { t: "refs", kind: "task", d: "the tasks", req: true, max: 50 }, action: { t: "enum", values: ["complete", "reopen", "delete", "assign", "set_due", "move_section", "add_tag", "remove_tag"], d: "the change", req: true }, person: { t: "person", d: "assign: who" }, due: { t: "date", d: "set_due: the date" }, section: opt(ref("section", "move_section: the section")), tag: so("add_tag / remove_tag: the tag's name") },
  },

  // ---- Approvals ------------------------------------------------------------------------------------
  set_approvers: { group: "approvals", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Set an approval task's approvers", where: "the Approval row → Details", also: "approvers need Commenter+; while a round is pending only Owners and Admins", description: "Name who approves an approval task, any one or everyone, and an approval due date.", params: { task: ref("task", "the approval task"), approvers: { t: "people", d: "who approves (1–10)", req: true }, mode: { t: "enum", values: ["any", "all"], d: "any one or everyone" }, due: { t: "date", d: "approval due date" } } },
  set_approval_follow_up: { group: "approvals", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "What happens after approval", where: "the approval setup", description: "Set what happens when it's approved: complete the task, move it to a section, or just notify; reminders on or off. On a two-stage task the choice is saved but approving still leaves the task open.", params: { task: ref("task", "the approval task"), after: { t: "enum", values: ["complete", "move_section", "notify"], d: "what happens", req: true }, section: opt(ref("section", "move_section: where")), reminders: { t: "bool", d: "remind approvers before the due date" } } },
  send_for_approval: { group: "approvals", kind: "write", scope: "project", minRole: "editor", notifies: true, undo: "yes", label: "Send for approval", where: "Ready for approval on the Approval row", also: "notifies the approvers; Undo withdraws it", description: "Start an approval round with the final text and/or files. Uses the saved When it's approved choice; refuses if setup isn't finished (no approver).", params: { task: ref("task", "the approval task"), text: s("what's being approved", 10000), files: { t: "refs", kind: "attachment", d: "files to approve" } } },
  withdraw_approval: { group: "approvals", kind: "write", scope: "project", minRole: "editor", undo: "no", label: "Withdraw an approval round", where: "the Approval row → Details → Withdraw", description: "Withdraw the pending approval round.", params: { task: ref("task", "the approval task") } },
  acknowledge_approval: { group: "approvals", kind: "write", scope: "project", minRole: "commenter", undo: "no", label: "Feedback / rejection received", where: "the Approval row", also: "the assignee or an Editor", description: "Say the requested changes or rejection were seen, so the task can go on.", params: { task: ref("task", "the approval task") } },
  hand_off_approval: { group: "approvals", kind: "write", scope: "project", minRole: "commenter", notifies: true, undo: "no", label: "Hand off your approval", where: "the Approval row → Details → Hand off", also: "only an approver who hasn't decided; notifies the new approver", description: "Pass your approval to someone else.", params: { task: ref("task", "the approval task"), person: { t: "person", d: "the new approver", req: true }, note: so("why", 2000) } },
  request_approval: { group: "approvals", kind: "write", scope: "project", minRole: "editor", notifies: true, undo: "yes", label: "Request approval (approval subtask)", where: "an automation, or the Approvals block when the task already has a request", also: "notifies the approver; Undo cancels it", description: "Ask someone to approve a task (makes an approval subtask).", params: { task: ref("task", "the task"), approver: { t: "person", d: "who approves", req: true }, note: so("a note", 2000) } },
  cancel_approval: { group: "approvals", kind: "write", scope: "project", minRole: "editor", undo: "no", label: "Cancel an approval request", where: "the pane's Approvals", description: "Cancel an open approval request.", params: { approval: ref("approval", "the request (from get_task)") } },
  resubmit_approval: { group: "approvals", kind: "write", scope: "project", minRole: "editor", notifies: true, undo: "no", label: "Resubmit an approval request", where: "the pane's Approvals", also: "notifies the approver", description: "Ask again after changes were requested.", params: { approval: ref("approval", "the request (from get_task)"), note: so("a note", 2000) } },

  // ---- Collaboration --------------------------------------------------------------------------------
  add_comment: { group: "collaboration", kind: "write", scope: "project", minRole: "commenter", notifies: true, undo: "yes", label: "Comment on a task", where: "the pane's comment box", also: "notifies the task's followers and anyone @mentioned", description: "Post a comment as you.", params: { task: ref("task", "the task"), text: s("the comment", 5000) } },
  edit_comment: { group: "collaboration", kind: "write", scope: "project", minRole: "commenter", undo: "yes", label: "Edit your comment", where: "a comment's … → Edit", also: "your own comments only, within 15 minutes of posting", description: "Change the text of one of your comments (only for 15 minutes after you posted it).", params: { comment: ref("comment", "your comment (from get_task)"), text: s("the new text", 5000) } },
  delete_comment: { group: "collaboration", kind: "write", scope: "project", minRole: "commenter", destructive: true, undo: "no", label: "Delete your comment", where: "a comment's … → Delete", also: "your own comments only; can't be undone", description: "Remove one of your comments.", params: { comment: ref("comment", "your comment (from get_task)") } },
  pin_comment: { group: "collaboration", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Pin a comment", where: "a comment's Pin", description: "Pin or unpin a comment.", params: { comment: ref("comment", "the comment"), pinned: { t: "bool", d: "pin (true) or unpin (false)", req: true } } },
  react_to_comment: { group: "collaboration", kind: "write", scope: "project", minRole: "commenter", undo: "yes", label: "React to a comment", where: "a comment's reactions", description: "Add or remove your reaction.", params: { comment: ref("comment", "the comment"), emoji: { t: "enum", values: ["thumbs_up", "heart", "tada", "laugh", "eyes", "check"], d: "the reaction", req: true } } },
  follow_task: { group: "collaboration", kind: "write", scope: "project", minRole: "commenter", undo: "yes", label: "Follow / unfollow a task", where: "the pane's Followers row", also: "removing someone else needs Editor", description: "Add or remove a follower (yourself by default).", params: { task: ref("task", "the task"), person: { t: "person", d: "who (default: me)" }, following: { t: "bool", d: "follow (true) or stop (false)", req: true } } },
  add_tag: { group: "collaboration", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Tag a task", where: "the pane's Tags row", also: "tags must be on in the workspace", description: "Add a tag to a task (made if no tag has that name).", params: { task: ref("task", "the task"), tag: s("the tag's name", 50) } },
  remove_tag: { group: "collaboration", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Untag a task", where: "the pane's Tags row", description: "Remove a tag from a task.", params: { task: ref("task", "the task"), tag: s("the tag's name", 50) } },
  create_tag: { group: "collaboration", kind: "write", scope: "workspace", undo: "yes", label: "Create a tag", where: "Settings → Workspace → Tags", description: "Make a workspace tag.", params: { name: s("the name", 50), color: so("a color (gray, red, orange, yellow, green, teal, blue, purple, pink, …)", 20) } },
  add_dependency: { group: "collaboration", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Add a dependency", where: "the pane's Dependencies row", also: "Editor on both tasks", description: "Make a task wait on another (blocked_by).", params: { task: ref("task", "the task that waits"), blocked_by: ref("task", "the task it waits on"), kind: { t: "enum", values: ["finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"], d: "link type (default finish_to_start)" }, lag_days: { t: "int", d: "lag in days", min: -365, max: 365 } } },
  remove_dependency: { group: "collaboration", kind: "write", scope: "project", minRole: "editor", destructive: true, undo: "yes", label: "Remove a dependency", where: "the pane's Dependencies row", description: "Remove a dependency link.", params: { task: ref("task", "the task that waits"), blocked_by: ref("task", "the task it waits on") } },
  shift_with_dependents: { group: "collaboration", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Move dates and their dependents", where: "Timeline drags / the date picker's prompt", also: "lists every task that moves before Confirm", description: "Change a task's dates and push the tasks that depend on it.", params: { task: ref("task", "the task"), due: { t: "date", d: "new due date" }, start: { t: "date", d: "new start date" } } },
  delete_attachment: { group: "collaboration", kind: "write", scope: "project", minRole: "editor", destructive: true, undo: "no", label: "Remove a file", where: "the pane's Attachments", also: "can't be undone (no uploads from the AI)", description: "Remove a file from a task.", params: { attachment: ref("attachment", "the file (from get_task)") } },

  // ---- Sections -------------------------------------------------------------------------------------
  create_section: { group: "sections", kind: "write", scope: "project", minRole: "editor", sectionLock: true, undo: "yes", label: "Add a section", where: "+ Add task → Add section", also: "Owners only while sections are locked", description: "Add a section (before another one, or at the end).", params: { project: ref("project", "the project"), name: s("the name"), before: opt(ref("section", "put it before this section")) } },
  rename_section: { group: "sections", kind: "write", scope: "project", minRole: "editor", sectionLock: true, undo: "yes", label: "Rename a section", where: "a section's … → Rename", also: "Owners only while sections are locked", description: "Rename a section.", params: { section: ref("section", "the section"), name: s("the new name") } },
  move_section: { group: "sections", kind: "write", scope: "project", minRole: "editor", sectionLock: true, undo: "yes", label: "Reorder sections", where: "drag a section", also: "Owners only while sections are locked", description: "Move a section before another (or to the end).", params: { section: ref("section", "the section"), before: opt(ref("section", "put it before this one (leave out = the end)")) } },
  delete_section: { group: "sections", kind: "write", scope: "project", minRole: "editor", sectionLock: true, destructive: true, undo: "yes", label: "Delete an empty section", where: "a section's … → Delete", also: "only an empty section; Undo makes it again", description: "Delete a section that has no tasks.", params: { section: ref("section", "the section") } },
  lock_sections: { group: "sections", kind: "write", scope: "project", minRole: "owner", undo: "yes", label: "Lock / unlock sections", where: "Customize → Lock sections", description: "Lock the project's sections (only Owners change them while locked).", params: { project: ref("project", "the project"), locked: { t: "bool", d: "lock (true) or unlock", req: true } } },

  // ---- Projects -------------------------------------------------------------------------------------
  create_project: { group: "projects", kind: "write", scope: "workspace", undo: "yes", label: "Create a project", where: "Create → Project", also: "in the Testing data workspace; you own it", description: "Make a blank project with the default sections.", params: { name: s("the name"), visibility: { t: "enum", values: ["private", "team"], d: "private (default) or public to its team" } } },
  update_project: { group: "projects", kind: "write", scope: "project", minRole: "admin", undo: "yes", label: "Rename / describe a project", where: "the project header and Overview", description: "Change a project's name, description, or due date.", params: { project: ref("project", "the project"), name: so("new name"), description: so("new description (\"\" clears)", 10000), due: { t: "date", d: "project due date (\"none\" clears)" } } },
  set_project_status: { group: "projects", kind: "write", scope: "project", minRole: "editor", notifies: true, undo: "no", label: "Post a status update", where: "the status pill in the project header", also: "notifies the project's members; stays in the status history", description: "Set a project's status with a note.", params: { project: ref("project", "the project"), status: { t: "enum", values: STATUSES, d: "the status", req: true }, title: so("a title"), note: so("the summary", 2000) } },
  archive_project: { group: "projects", kind: "write", scope: "project", minRole: "admin", undo: "yes", label: "Archive / unarchive a project", where: "the project menu", description: "Archive (read-only for everyone) or unarchive a project.", params: { project: ref("project", "the project"), archived: { t: "bool", d: "archive (true) or unarchive", req: true } } },
  delete_project: { group: "projects", kind: "write", scope: "project", minRole: "owner", destructive: true, undo: "no", label: "Delete a project", where: "the project menu → Delete", also: "Owners only; can't be undone here", description: "Delete a project and hide all its tasks.", params: { project: ref("project", "the project") } },
  duplicate_project: { group: "projects", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Duplicate a project", where: "the project menu → Duplicate", also: "rules copied off", description: "Copy a project (sections, fields, tasks, views; automations land off).", params: { project: ref("project", "the project"), name: s("the copy's name") } },
  save_as_template: { group: "projects", kind: "write", scope: "project", minRole: "admin", undo: "yes", label: "Save a project as a template", where: "the project menu → Save as template", description: "Save a project as a workspace template.", params: { project: ref("project", "the project"), name: s("the template's name"), description: so("what it's for", 2000) } },
  save_task_template: { group: "projects", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Save a task as a task template", where: "the pane's … → Save as task template", description: "Save a task (and its subtasks) as a task template of a project.", params: { task: ref("task", "the task"), project: ref("project", "the project"), name: s("the template's name") } },

  // ---- Members --------------------------------------------------------------------------------------
  add_member: { group: "members", kind: "write", scope: "project", minRole: "admin", undo: "yes", label: "Add someone to a project", where: "Share", also: "people of the Testing data workspace only; Owners add Owners", description: "Give a person access to a project with a role.", params: { project: ref("project", "the project"), person: { t: "person", d: "who", req: true }, role: { t: "enum", values: ["admin", "editor", "commenter", "viewer"], d: "their role (default editor)" } } },
  change_member_role: { group: "members", kind: "write", scope: "project", minRole: "admin", undo: "yes", label: "Change someone's role", where: "Share → role menu", also: "only Owners change Owners", description: "Change a member's role.", params: { project: ref("project", "the project"), person: { t: "person", d: "who", req: true }, role: { t: "enum", values: ROLES.filter((r) => r !== "owner"), d: "the new role", req: true } } },
  remove_member: { group: "members", kind: "write", scope: "project", minRole: "admin", destructive: true, undo: "yes", label: "Remove someone from a project", where: "Share → Remove", also: "never the last Owner; Undo adds them back with their role", description: "Take a person out of a project.", params: { project: ref("project", "the project"), person: { t: "person", d: "who", req: true } } },
  create_project_role: { group: "members", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Add a project role", where: "Overview → Project roles", description: "Add a named project role (e.g. Designer), optionally filled by a member.", params: { project: ref("project", "the project"), name: s("the role's name", 60), person: { t: "person", d: "who fills it" } } },
  rename_project_role: { group: "members", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Rename a project role", where: "Overview → Project roles", description: "Rename a project role.", params: { role: ref("project_role", "the role"), name: s("the new name", 60) } },
  set_project_role_person: { group: "members", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Change who fills a project role", where: "Overview → Project roles", also: "open tasks follow", description: "Change who fills a project role (\"none\" empties it); open tasks assigned through it follow.", params: { role: ref("project_role", "the role"), person: { t: "person", d: "who", req: true } } },
  remove_project_role: { group: "members", kind: "write", scope: "project", minRole: "editor", destructive: true, undo: "no", label: "Remove a project role", where: "Overview → Project roles", description: "Remove a project role.", params: { role: ref("project_role", "the role") } },

  // ---- Fields ---------------------------------------------------------------------------------------
  create_field: { group: "fields", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Add a custom field", where: "Customize → Fields → + Add", description: "Add a custom field to a project.", params: { project: ref("project", "the project"), name: s("the name", 100), type: { t: "enum", values: ["text", "number", "date", "boolean", "single_select", "multi_select", "people"], d: "field type", req: true }, options: { t: "strs", d: "select fields: the option names", max: 50 }, description: so("what it's for", 2000) } },
  rename_field: { group: "fields", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Rename a custom field", where: "Edit field", also: "locked: Owners and Admins; shared: editors of the project that published it", description: "Rename a field.", params: { field: ref("field", "the field"), name: s("the new name", 100) } },
  update_field_options: { group: "fields", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Add, rename, or remove a field's options", where: "Edit field", also: "locked: Owners and Admins; shared: editors of the project that published it", description: "The field's WHOLE new option list in order: an existing name keeps it, \"Old => New\" renames, a new name adds, a name left out is removed.", params: { field: ref("field", "the field"), options: { t: "strs", d: "every option name", req: true, max: 50 } } },
  set_field_description: { group: "fields", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Describe a custom field", where: "Edit field", also: "locked: Owners and Admins", description: "Set a field's description (\"\" clears).", params: { field: ref("field", "the field"), description: { t: "str", d: "the description", max: 2000, req: true } } },
  lock_field: { group: "fields", kind: "write", scope: "project", minRole: "admin", undo: "yes", label: "Lock / unlock a custom field", where: "Edit field → Lock", description: "Lock a field (only Owners and Admins change it and its values).", params: { field: ref("field", "the field"), locked: { t: "bool", d: "lock (true) or unlock", req: true } } },
  remove_field: { group: "fields", kind: "write", scope: "project", minRole: "editor", destructive: true, undo: "yes", label: "Remove a custom field from the project", where: "Edit field → Delete", also: "locked: Owners and Admins; values are kept", description: "Remove a field (its values are kept; Undo brings it back).", params: { field: ref("field", "the field") } },
  set_field_value: { group: "fields", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Set a field value", where: "a task's field row", also: "a locked field: Owners and Admins", description: "Set a task's value of a field: an option name, several names separated by \", \", text, digits, YYYY-MM-DD, true/false, or people. \"\" clears.", params: { task: ref("task", "the task"), field: ref("field", "a field of the task's project"), value: { t: "str", d: "the value", max: 1000, req: true } } },

  // ---- Automations ----------------------------------------------------------------------------------
  create_automation: { group: "automations", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Create an automation", where: "Customize → Automations → + Add", also: "it's created off", description: "Create a project automation (When / If / Then; the full vocabulary below). Created off.", params: { project: ref("project", "the project"), automation: { t: "automation", system: "project", d: "the automation", req: true } } },
  update_automation: { group: "automations", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Edit an automation", where: "the automation builder", description: "Replace an automation's name and steps (send the whole automation, as get_automation shows it). Keeps its on / off state.", params: { automation_ref: ref("rule", "the automation"), automation: { t: "automation", system: "project", d: "the whole new automation", req: true } } },
  enable_automation: { group: "automations", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Turn an automation on / off", where: "the automation's switch", also: "turning on one that messages people needs its own confirmation", description: "Turn an automation on (true) or off (false).", params: { automation_ref: ref("rule", "the automation"), on: { t: "bool", d: "on or off", req: true } } },
  delete_automation: { group: "automations", kind: "write", scope: "project", minRole: "editor", destructive: true, undo: "yes", label: "Remove an automation", where: "the automation's … → Delete", description: "Remove an automation (Undo brings it back).", params: { automation_ref: ref("rule", "the automation") } },
  duplicate_automation: { group: "automations", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Duplicate an automation", where: "the automation's … → Duplicate", description: "Copy an automation (the copy starts off).", params: { automation_ref: ref("rule", "the automation") } },
  pause_automation: { group: "automations", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Pause an automation for a while", where: "the automation's … → Pause", description: "Pause until a date (\"none\" resumes).", params: { automation_ref: ref("rule", "the automation"), until: { t: "date", d: "pause until (YYYY-MM-DD) or \"none\"", req: true } } },
  run_automation: { group: "automations", kind: "write", scope: "project", minRole: "editor", undo: "no", label: "Run an automation on a task", where: "the pane's … → Run an automation", also: "\"Run manually\" automations; what it does can't be undone here", description: "Run a manual automation on a task now.", params: { automation_ref: ref("rule", "the automation"), task: ref("task", "the task") } },

  create_my_automation: { group: "my_automations", kind: "write", scope: "personal", undo: "yes", label: "Create a My Tasks automation", where: "My tasks → Rules", also: "your own; created off", description: "Create an automation on your own tasks (My Tasks vocabulary below). Created off.", params: { automation: { t: "automation", system: "my_tasks", d: "the automation", req: true } } },
  update_my_automation: { group: "my_automations", kind: "write", scope: "personal", undo: "yes", label: "Edit a My Tasks automation", where: "My tasks → Rules", description: "Replace one of your My Tasks automations.", params: { automation_ref: ref("my_rule", "the automation"), automation: { t: "automation", system: "my_tasks", d: "the whole new automation", req: true } } },
  enable_my_automation: { group: "my_automations", kind: "write", scope: "personal", undo: "yes", label: "Turn a My Tasks automation on / off", where: "My tasks → Rules", description: "Turn one of your My Tasks automations on or off.", params: { automation_ref: ref("my_rule", "the automation"), on: { t: "bool", d: "on or off", req: true } } },
  delete_my_automation: { group: "my_automations", kind: "write", scope: "personal", destructive: true, undo: "no", label: "Delete a My Tasks automation", where: "My tasks → Rules", description: "Delete one of your My Tasks automations.", params: { automation_ref: ref("my_rule", "the automation") } },

  create_portfolio_automation: { group: "portfolio_automations", kind: "write", scope: "workspace", undo: "yes", label: "Create a portfolio automation", where: "a portfolio's Rules tab", also: "portfolio Editors+; created off", description: "Create a portfolio automation (portfolio vocabulary below). Created off.", params: { portfolio: ref("portfolio", "the portfolio"), automation: { t: "automation", system: "portfolio", d: "the automation", req: true } } },
  update_portfolio_automation: { group: "portfolio_automations", kind: "write", scope: "workspace", undo: "yes", label: "Edit a portfolio automation", where: "a portfolio's Rules tab", also: "portfolio Editors+", description: "Replace a portfolio automation.", params: { automation_ref: ref("portfolio_rule", "the automation"), automation: { t: "automation", system: "portfolio", d: "the whole new automation", req: true } } },
  enable_portfolio_automation: { group: "portfolio_automations", kind: "write", scope: "workspace", undo: "yes", label: "Turn a portfolio automation on / off", where: "a portfolio's Rules tab", also: "portfolio Editors+", description: "Turn a portfolio automation on or off.", params: { automation_ref: ref("portfolio_rule", "the automation"), on: { t: "bool", d: "on or off", req: true } } },
  delete_portfolio_automation: { group: "portfolio_automations", kind: "write", scope: "workspace", destructive: true, undo: "no", label: "Delete a portfolio automation", where: "a portfolio's Rules tab", also: "portfolio Editors+", description: "Delete a portfolio automation.", params: { automation_ref: ref("portfolio_rule", "the automation") } },

  // ---- Views, widgets, forms ------------------------------------------------------------------------
  create_view: { group: "views", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Add a view", where: "the + after the project's tabs", description: "Add a List, Board, Calendar, or Timeline view.", params: { project: ref("project", "the project"), name: s("the name", 100), layout: { t: "enum", values: ["list", "board", "calendar", "timeline"], d: "layout", req: true } } },
  rename_view: { group: "views", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Rename a view", where: "a tab's … → Rename", description: "Rename a view.", params: { view: ref("view", "the view"), name: s("the new name", 100) } },
  delete_view: { group: "views", kind: "write", scope: "project", minRole: "editor", destructive: true, undo: "no", label: "Delete a view", where: "a tab's … → Delete", also: "never the last one; the default view only by Owners", description: "Delete a view.", params: { view: ref("view", "the view") } },
  set_default_view: { group: "views", kind: "write", scope: "project", minRole: "owner", undo: "yes", label: "Set the default view", where: "a tab's … → Make default", description: "Choose the view everyone opens first.", params: { project: ref("project", "the project"), view: ref("view", "the view") } },
  add_widget: { group: "views", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Add a dashboard widget", where: "the Dashboard tab", description: "Add a count or chart to a project's dashboard.", params: { project: ref("project", "the project"), title: s("the title", 100), kind: { t: "enum", values: ["count", "by_section", "by_assignee"], d: "kind", req: true } } },
  delete_widget: { group: "views", kind: "write", scope: "project", minRole: "editor", destructive: true, undo: "no", label: "Remove a dashboard widget", where: "the Dashboard tab", description: "Remove a dashboard widget.", params: { widget: ref("widget", "the widget") } },
  create_form: { group: "forms", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Add a form", where: "Customize → Forms → + Add form", also: "starts off", description: "Add a form to a project (not live until turned on).", params: { project: ref("project", "the project"), title: s("the title", 200) } },
  rename_form: { group: "forms", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Rename a form", where: "the form editor", description: "Rename a form.", params: { form: ref("form", "the form"), title: s("the new title", 200) } },
  set_form_live: { group: "forms", kind: "write", scope: "project", minRole: "editor", undo: "yes", label: "Turn a form on / off", where: "the form editor's Live switch", also: "a live form takes public responses", description: "Turn a form live (true) or off.", params: { form: ref("form", "the form"), live: { t: "bool", d: "live or off", req: true } } },
  delete_form: { group: "forms", kind: "write", scope: "project", minRole: "editor", destructive: true, undo: "no", label: "Delete a form", where: "the form editor → Settings → Delete", description: "Delete a form.", params: { form: ref("form", "the form") } },

  // ---- Workspace: portfolios, goals, teams ----------------------------------------------------------
  create_portfolio: { group: "workspace", kind: "write", scope: "workspace", undo: "yes", label: "Create a portfolio", where: "Create → Portfolio", also: "you own it", description: "Make a portfolio in the Testing data workspace.", params: { name: s("the name", 100) } },
  update_portfolio: { group: "workspace", kind: "write", scope: "workspace", undo: "yes", label: "Rename a portfolio", where: "the portfolio header", also: "portfolio Editors+", description: "Change a portfolio's name or notes.", params: { portfolio: ref("portfolio", "the portfolio"), name: so("new name", 100), notes: so("notes", 5000) } },
  add_project_to_portfolio: { group: "workspace", kind: "write", scope: "workspace", undo: "yes", label: "Add a project to a portfolio", where: "the portfolio's Add to portfolio", also: "portfolio Editors+ who can read the project", description: "Add a project to a portfolio.", params: { portfolio: ref("portfolio", "the portfolio"), project: ref("project", "the project") } },
  remove_project_from_portfolio: { group: "workspace", kind: "write", scope: "workspace", destructive: true, undo: "yes", label: "Remove a project from a portfolio", where: "a portfolio card's Remove", also: "portfolio Editors+", description: "Take a project out of a portfolio.", params: { portfolio: ref("portfolio", "the portfolio"), project: ref("project", "the project") } },
  create_goal: { group: "workspace", kind: "write", scope: "workspace", undo: "yes", label: "Create a goal", where: "Goals → New goal", also: "Goals must be on in the workspace", description: "Make a goal (you own it).", params: { title: s("the title", 200), status: { t: "enum", values: ["on_track", "at_risk", "off_track"], d: "status" } } },
  update_goal: { group: "workspace", kind: "write", scope: "workspace", undo: "yes", label: "Edit a goal", where: "the goal page", also: "its owner, a lead of its team, or a workspace admin", description: "Rename a goal or set its manual progress.", params: { goal: ref("goal", "the goal"), title: so("new title", 200), progress: { t: "int", d: "manual progress 0–100", min: 0, max: 100 } } },
  post_goal_status: { group: "workspace", kind: "write", scope: "workspace", undo: "no", label: "Post a goal status update", where: "the goal page", also: "goal editors", description: "Post a status update on a goal (sets its status).", params: { goal: ref("goal", "the goal"), status: { t: "enum", values: ["on_track", "at_risk", "off_track", "achieved", "missed", "dropped"], d: "status", req: true }, body: so("the update", 5000) } },
  create_team: { group: "workspace", kind: "write", scope: "workspace", undo: "no", label: "Create a team", where: "Teams → Create team", also: "you become its lead", description: "Make a team in the Testing data workspace.", params: { name: s("the name", 100), description: so("what it's for", 2000) } },
  update_team: { group: "workspace", kind: "write", scope: "workspace", undo: "yes", label: "Rename / describe a team", where: "the team page", also: "its leads and workspace admins", description: "Change a team's name or description.", params: { team: ref("team", "the team"), name: so("new name", 100), description: so("new description", 2000) } },

  // ---- Personal ---------------------------------------------------------------------------------------
  create_my_section: { group: "personal", kind: "write", scope: "personal", undo: "yes", label: "Add a My Tasks section", where: "My tasks (classic views) → Add section", description: "Add one of your own My Tasks sections.", params: { name: s("the name", 100) } },
  rename_my_section: { group: "personal", kind: "write", scope: "personal", undo: "yes", label: "Rename a My Tasks section", where: "My tasks → a section's …", description: "Rename one of your My Tasks sections.", params: { section: ref("my_section", "the section"), name: s("the new name", 100) } },
  move_to_my_section: { group: "personal", kind: "write", scope: "personal", undo: "yes", label: "Move a task in My Tasks", where: "drag in My tasks", also: "tasks assigned to you", description: "Put one of your tasks in one of your My Tasks sections.", params: { task: ref("task", "a task assigned to you"), section: ref("my_section", "your section") } },
  star_project: { group: "personal", kind: "write", scope: "personal", undo: "yes", label: "Star a project", where: "the star in the project header", description: "Star (true) or unstar a project in your sidebar.", params: { project: ref("project", "the project"), starred: { t: "bool", d: "star or unstar", req: true } } },
  create_sidebar_folder: { group: "personal", kind: "write", scope: "personal", undo: "yes", label: "Add a sidebar folder", where: "the sidebar's Projects", description: "Add one of your own sidebar folders.", params: { name: s("the name", 100) } },
  file_project: { group: "personal", kind: "write", scope: "personal", undo: "yes", label: "Put a project in a sidebar folder", where: "drag in the sidebar", description: "Put a project in one of your sidebar folders (leave out the folder to take it out).", params: { project: ref("project", "the project"), folder: opt(ref("folder", "your folder")) } },
  mark_inbox: { group: "personal", kind: "write", scope: "personal", undo: "yes", label: "Read / archive / bookmark Inbox items", where: "the Inbox", description: "Mark Inbox items read, archived, or bookmarked (or the reverse).", params: { items: { t: "refs", kind: "inbox_item", d: "the items (from list_my_things inbox)", req: true, max: 50 }, action: { t: "enum", values: ["read", "unread", "archive", "unarchive", "bookmark", "unbookmark"], d: "what to do", req: true } } },
  create_dashboard: { group: "personal", kind: "write", scope: "personal", undo: "no", label: "Create a personal dashboard", where: "Reports → My dashboards", description: "Make a personal dashboard with starter widgets.", params: { name: s("the name", 100) } },
} as const satisfies Record<string, ToolMeta>;

export type ToolName = keyof typeof AI_TOOLS;
export const TOOL_NAMES = Object.keys(AI_TOOLS) as ToolName[];
export const isToolName = (v: unknown): v is ToolName => typeof v === "string" && Object.prototype.hasOwnProperty.call(AI_TOOLS, v);
export const toolMeta = (name: ToolName): ToolMeta => AI_TOOLS[name] as ToolMeta;
export const WRITE_TOOLS = TOOL_NAMES.filter((n) => toolMeta(n).kind === "write");
export const READ_TOOLS = TOOL_NAMES.filter((n) => toolMeta(n).kind === "read");

// Tools that would mean nothing as a bulk change beyond this many items.
export const BIG_CHANGE_ITEMS = 10;

// ---- Permission (the role rule; the same words at stage time and again at Confirm) --------------------

export type CapabilityFacts = {
  projectName: string;
  role: ProjectRole | null;
  archived: boolean;
  sectionsLocked?: boolean;
  field?: {
    name: string;
    locked: boolean;
    boundToSections: boolean;
    shared: boolean;
    definitionEditable: boolean | null;
    definitionManageable: boolean | null;
  };
};

const FIELD_DEFINITION_TOOLS: ReadonlySet<string> = new Set(["rename_field", "update_field_options", "set_field_description", "lock_field"]);

const articleRole = (role: ProjectRole) => `${/^[AEIOU]/.test(ROLE_LABELS[role]) ? "an" : "a"} ${ROLE_LABELS[role]}`;

// Why this person may not use this tool in this project, or null when they may (project-scope tools; the
// typed API's own checks — RLS, the RPCs — still decide on the write).
export function capabilityRefusal(tool: ToolName, facts: CapabilityFacts): string | null {
  const cap = toolMeta(tool);
  if (cap.scope !== "project" || !cap.minRole) return null;
  const p = `“${facts.projectName}”`;
  if (facts.archived) return `${p} is archived`;
  if (!facts.role) return `you’re not a member of ${p}`;
  if (!hasRole(facts.role, cap.minRole)) {
    if (cap.group === "automations") return `only Owners and Editors of ${p} change its automations`;
    if (cap.group === "forms") return `only Owners and Editors of ${p} change its forms`;
    if (cap.minRole === "owner") return `only Owners of ${p} can ${cap.label.charAt(0).toLowerCase()}${cap.label.slice(1)}`;
    if (cap.minRole === "admin") return `only Owners and Admins of ${p} can ${cap.label.charAt(0).toLowerCase()}${cap.label.slice(1)}`;
    return `your role in ${p} doesn’t allow that (you’re ${articleRole(facts.role)}); ask an Owner`;
  }
  if (cap.sectionLock && facts.sectionsLocked && facts.role !== "owner") return `${p}’s sections are locked (only its Owners change them)`;
  const f = facts.field;
  if (!f) return null;
  const name = `“${f.name}”`;
  if (tool === "set_field_value") {
    if (f.boundToSections) return `${name} follows the section; move the task instead`;
    if (f.locked && !hasRole(facts.role, "admin")) return `${name} is locked (only Owners and Admins change its values)`;
    return null;
  }
  if (f.boundToSections && tool !== "rename_field") return `${name} follows the sections; change it in Edit field yourself`;
  if (FIELD_DEFINITION_TOOLS.has(tool)) {
    if (f.shared && f.definitionEditable === false) return `${name} is shared from the field library; only editors of the project that published it change it`;
    if (f.locked && tool !== "lock_field" && !(f.definitionManageable ?? hasRole(facts.role, "admin"))) return `${name} is locked (only Owners and Admins change it)`;
  }
  if (tool === "remove_field" && f.locked && !hasRole(facts.role, "admin")) return `${name} is locked (only Owners and Admins remove it)`;
  return null;
}

// Whether the person may change anything at all in a project (Editor+ and not archived). Below that the
// in-app assistant only answers questions.
export function canChangeIn(role: ProjectRole | null, archived: boolean): boolean {
  return !archived && hasRole(role, "editor");
}

// The kinds of change the person may ask for in a project (for the model's context).
export function allowedGroups(role: ProjectRole | null, archived: boolean, sectionsLocked: boolean): ToolGroup[] {
  if (!canChangeIn(role, archived)) return [];
  const groups = new Set<ToolGroup>();
  for (const name of WRITE_TOOLS) {
    const cap = toolMeta(name);
    if (cap.scope !== "project" || !cap.minRole || !hasRole(role, cap.minRole)) continue;
    if (cap.sectionLock && sectionsLocked && role !== "owner" && cap.minRole !== "owner") continue;
    groups.add(cap.group);
  }
  return [...groups];
}

export const ANSWER_ONLY_NOTE = "Your role here doesn’t allow changes, so the assistant only answers questions. Ask an Owner to make changes.";

// The role matrix (the PR, docs/ai-builder-pilot.md, and the tests read the same table).
export function capabilityMatrix() {
  return WRITE_TOOLS.map((name) => {
    const cap = toolMeta(name);
    const can = (role: ProjectRole) => cap.scope !== "project" || (hasRole(role, cap.minRole ?? "viewer") && hasRole(role, "editor"));
    return {
      tool: name,
      group: cap.group,
      label: cap.label,
      scope: cap.scope,
      minRole: cap.minRole ?? null,
      owner: can("owner"),
      admin: can("admin"),
      editor: can("editor"),
      commenter: cap.scope === "project" ? false : can("commenter"),
      viewer: cap.scope === "project" ? false : can("viewer"),
      destructive: Boolean(cap.destructive),
      notifies: Boolean(cap.notifies),
      undo: cap.undo,
      also: cap.also ?? "",
    };
  });
}

// The matrix as Markdown (generated into the PR and the docs).
export function capabilityMatrixMarkdown(): string {
  const yes = (b: boolean) => (b ? "✓" : "");
  const rows = capabilityMatrix().map(
    (r) => `| \`${r.tool}\` | ${r.label} | ${r.scope === "project" ? `${ROLE_LABELS[r.minRole ?? "editor"]}+` : r.scope === "personal" ? "you (your own)" : "its own rule"} | ${yes(r.owner)} | ${yes(r.admin)} | ${yes(r.editor)} | ${r.destructive ? "destructive" : ""}${r.notifies ? " notifies" : ""} | ${r.undo === "yes" ? "Undo" : "no Undo"} | ${r.also} |`,
  );
  return ["| Tool | What | Who | Owner | Admin | Editor | Flags | Undo | Also |", "|---|---|---|:-:|:-:|:-:|---|---|---|", ...rows].join("\n");
}

// Answer mode's help, generated from the registry (bounded).
export function registryHelp(maxChars = 6000): string {
  const lines: string[] = [];
  for (const group of Object.keys(TOOL_GROUP_LABELS) as ToolGroup[]) {
    if (group === "read") continue;
    const tools = WRITE_TOOLS.filter((n) => toolMeta(n).group === group);
    if (!tools.length) continue;
    const items = tools.map((n) => {
      const c = toolMeta(n);
      const who = c.scope === "project" ? `${ROLE_LABELS[c.minRole ?? "editor"]}+` : c.scope === "personal" ? "yours" : (c.also ?? "");
      return `${c.label} (${c.where}; ${who})`;
    });
    lines.push(`${TOOL_GROUP_LABELS[group]}: ${items.join("; ")}.`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// ---- Input schemas ----------------------------------------------------------------------------------
// One per tool. Flat, no anyOf / oneOf, no nullable union: within Anthropic's tool-schema limits (16
// unions per schema; the test walks every tool). "assistant" names things by refs (T3) and aliases
// (member:1); "mcp" by ids.

export type Audience = "assistant" | "mcp";

const KIND_WORD: Record<RefKind, string> = {
  task: "task", project: "project", section: "section", field: "field", rule: "automation", comment: "comment", tag: "tag", dependency: "dependency",
  attachment: "file", approval: "approval request", view: "view", widget: "widget", form: "form", portfolio: "portfolio", goal: "goal", team: "team",
  my_section: "My Tasks section", my_rule: "My Tasks automation", portfolio_rule: "portfolio automation", project_role: "project role",
  template: "template", dashboard: "dashboard", folder: "folder", inbox_item: "Inbox item",
};

function refDescription(kind: RefKind, d: string, audience: Audience) {
  return audience === "assistant" ? `${d} — a ${KIND_WORD[kind]} ref like ${REF_PREFIX[kind]}3` : `${d} — the ${KIND_WORD[kind]}'s id`;
}

function personDescription(d: string, audience: Audience) {
  return audience === "assistant" ? `${d} — an alias (member:1), a name, "me", or "none"` : `${d} — a person's id, a name, "me", or "none"`;
}

export function paramSchema(p: Param, audience: Audience): Record<string, unknown> {
  switch (p.t) {
    case "ref":
      return { type: "string", description: refDescription(p.kind, p.d, audience) };
    case "refs":
      return { type: "array", items: { type: "string" }, ...(p.max ? { maxItems: p.max } : {}), description: refDescription(p.kind, p.d, audience) };
    case "str":
      return { type: "string", description: p.d };
    case "int":
      return { type: "integer", description: p.d, ...(p.min !== undefined ? { minimum: p.min } : {}), ...(p.max !== undefined ? { maximum: p.max } : {}) };
    case "bool":
      return { type: "boolean", description: p.d };
    case "enum":
      return { type: "string", enum: [...p.values], description: p.d };
    case "strs":
      return { type: "array", items: { type: "string" }, ...(p.max ? { maxItems: p.max } : {}), description: p.d };
    case "date":
      return { type: "string", description: `${p.d} (YYYY-MM-DD, or "none" to clear)` };
    case "person":
      return { type: "string", description: personDescription(p.d, audience) };
    case "people":
      return { type: "array", items: { type: "string" }, maxItems: 20, description: personDescription(p.d, audience) };
    case "automation": {
      const step = { type: "object", properties: { type: { type: "string" } }, required: ["type"], additionalProperties: true };
      return {
        type: "object",
        description: `${p.d}: { name, trigger: {type, …settings}, conditions: [{type, …}], actions: [{type, …}] }. Settings use the engine's keys (vocabulary in the system prompt); name sections, fields, options, tags, forms, and projects by name or ref, people by alias / name / "me" / "assignee" / "creator".`,
        properties: { name: { type: "string" }, trigger: step, conditions: { type: "array", items: step }, actions: { type: "array", items: step } },
        required: ["trigger", "actions"],
        additionalProperties: false,
      };
    }
  }
}

export function toolInputSchema(name: ToolName, audience: Audience): Record<string, unknown> {
  const cap = toolMeta(name);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, p] of Object.entries(cap.params)) {
    properties[key] = paramSchema(p, audience);
    if ("req" in p && p.req) required.push(key);
  }
  if (audience === "mcp" && cap.kind === "write") {
    // Security audit 2 (Nov 12, batch 41): every MCP change waits for confirm: true.
    properties.confirm = { type: "boolean", description: `must be true to make this change${cap.destructive ? " (it deletes something)" : cap.notifies ? " (it messages people)" : ""}; without it you get a preview and nothing changes` };
  }
  return { type: "object", properties, required, additionalProperties: false };
}

// Tools offered to an audience.
export function toolsFor(audience: Audience): ToolName[] {
  return TOOL_NAMES.filter((n) => {
    const only = (toolMeta(n) as { only?: Audience }).only;
    return !only || only === audience;
  });
}

// The tool groups the assistant starts with on a page (the rest come through find_tools).
export function startingGroups(page: string): ToolGroup[] {
  const core: ToolGroup[] = ["read", "tasks", "approvals", "collaboration", "sections", "fields", "automations"];
  if (page === "my_tasks") return ["read", "tasks", "approvals", "collaboration", "personal", "my_automations"];
  if (page === "other") return ["read", "tasks", "projects", "workspace", "personal"];
  return core;
}

// find_tools: tools whose label, description, or group match the words.
export function findTools(query: string, audience: Audience = "assistant"): ToolName[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  return toolsFor(audience).filter((n) => {
    const c = toolMeta(n);
    const hay = `${n} ${c.label} ${c.description} ${c.group} ${TOOL_GROUP_LABELS[c.group]}`.toLowerCase();
    return words.some((w) => hay.includes(w.replace(/s$/, "")));
  });
}
