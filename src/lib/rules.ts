import type { Json } from "@/lib/supabase/database.types";

// Vocabulary of the rules engine (see the workflows migration). The database validates every rule
// (`validate_rule`) and runs it; this module only describes rules for the builder UI.

// Each entry has a group, a one-line description, and search keywords for the rule builder's picker.
export const TRIGGERS = [
  { value: "task_created", label: "Task is added to this project", group: "Task", description: "Fires when a task is created in this project or a form or webhook adds one.", keywords: ["new", "created", "added"] },
  { value: "section_changed", label: "Task moves into a section", group: "Task", description: "Fires when a task enters a section you pick (or any section).", keywords: ["moved", "column", "status", "stage"] },
  { value: "field_changed", label: "A field changes", group: "Fields", description: "Fires when a custom field changes, or changes to a value you pick.", keywords: ["custom field", "priority", "value"] },
  { value: "assignee_changed", label: "Assignee changes", group: "People", description: "Fires when someone is assigned, reassigned, or unassigned.", keywords: ["assign", "owner", "person"] },
  { value: "due_approaching", label: "Due date is approaching", group: "Dates", description: "Fires once per open task a number of days before its due date.", keywords: ["deadline", "reminder", "soon"] },
  { value: "approval_decided", label: "An approval is decided", group: "Approvals and forms", description: "Fires when an approver approves, requests changes, or rejects.", keywords: ["approve", "review", "rejected", "changes requested"] },
  { value: "form_submitted", label: "A form is submitted", group: "Approvals and forms", description: "Fires when someone submits one of this project's forms.", keywords: ["intake", "request", "submission"] },
  { value: "inbound_received", label: "Created by inbound webhook", group: "Integrations", description: "Fires when a task comes in through one of this project's inbound webhooks.", keywords: ["api", "zapier", "make", "webhook"] },
  // Automations V2 (20261020010000_automations_v2.sql).
  { value: "task_completed", label: "Task is completed", group: "Task", description: "Fires when someone (or a rule) marks a task complete.", keywords: ["done", "finished", "complete"] },
  { value: "task_reopened", label: "Task is reopened", group: "Task", description: "Fires when a completed task is marked incomplete again.", keywords: ["undo", "incomplete", "reopen"] },
  { value: "subtasks_completed", label: "All subtasks are done", group: "Task", description: "Fires on a task when its last open subtask is completed.", keywords: ["checklist", "children", "parent"] },
  { value: "task_added_from_project", label: "Task is added from another project", group: "Task", description: "Fires when a task that lives in another project is also added here.", keywords: ["multi-home", "multihome", "cross-project", "calendar"] },
  { value: "comment_added", label: "A comment is added", group: "Communication", description: "Fires when someone comments on a task (or a submitter replies by email).", keywords: ["reply", "message", "feedback"] },
  { value: "attachment_added", label: "A file is attached", group: "Task", description: "Fires when a file is attached to a task.", keywords: ["upload", "file", "attachment", "asset"] },
  { value: "tag_added", label: "A tag is added", group: "Fields", description: "Fires when a task gets a tag, or a tag you pick.", keywords: ["label", "tag"] },
  { value: "due_date_changed", label: "Due date changes", group: "Dates", description: "Fires when a task's due date is set, moved, or cleared.", keywords: ["deadline", "reschedule", "moved"] },
  { value: "task_overdue", label: "Task becomes overdue", group: "Dates", description: "Fires once per open task the day after its due date (or later).", keywords: ["late", "missed", "past due"] },
  { value: "scheduled", label: "On a schedule", group: "Flow", description: "Runs every day, workday, week, or month for the open tasks that match.", keywords: ["cron", "daily", "weekly", "every", "recurring", "time"] },
  { value: "manual", label: "Run manually", group: "Flow", description: "Runs when someone picks it from a task's … menu (Run a rule).", keywords: ["button", "on demand", "by hand", "click"] },
  // Automations V3 (20261021010000_automations_v3_a.sql).
  { value: "follower_added", label: "A collaborator is added", group: "People", description: "Fires when someone starts following a task (anyone, or people you pick).", keywords: ["follower", "collaborator", "watch", "follow"] },
  // Batch B: start dates.
  { value: "start_date_changed", label: "Start date changes", group: "Dates", description: "Fires when a task's start date is set, moved, or cleared.", keywords: ["begin", "kickoff", "reschedule"] },
  { value: "start_approaching", label: "Start date is approaching", group: "Dates", description: "Fires once per open task some hours, days, or weeks before it starts.", keywords: ["begin", "kickoff", "soon", "reminder"] },
  { value: "start_reached", label: "Start date arrives", group: "Dates", description: "Fires once per open task when its start date comes (or a while after).", keywords: ["begin", "kickoff", "started", "passed"] },
  // Batch C: flow.
  { value: "task_unblocked", label: "Task is no longer blocked", group: "Flow", description: "Fires when the last task it waits on is done (or has started, for start dependencies).", keywords: ["dependency", "dependencies", "blocked", "waiting", "handoff", "ready"] },
  { value: "task_type_changed", label: "Task type changes", group: "Task", description: "Fires when a task becomes a task, a milestone, or an approval.", keywords: ["kind", "milestone", "approval"] },
  { value: "section_left", label: "Task moves out of a section", group: "Task", description: "Fires when a task leaves a section you pick.", keywords: ["moved", "column", "stage", "leaves", "out of"] },
] as const;

export type TriggerType = (typeof TRIGGERS)[number]["value"];

export const CONDITIONS = [
  { value: "section_is", label: "Section is", group: "Task", description: "The task is in a section you pick.", keywords: ["column", "stage"] },
  { value: "section_is_not", label: "Section is not", group: "Task", description: "The task is in any other section.", keywords: ["column", "stage", "not"] },
  { value: "is_incomplete", label: "Task is incomplete", group: "Task", description: "The task isn't marked complete.", keywords: ["open", "not done"] },
  { value: "is_complete", label: "Task is complete", group: "Task", description: "The task is marked complete.", keywords: ["done", "finished"] },
  { value: "source_is", label: "Task came from", group: "Task", description: "Created in the app, by a form, an import, or an inbound webhook.", keywords: ["source", "form", "import", "origin"] },
  { value: "field_equals", label: "Field equals", group: "Fields", description: "A custom field has the value you pick.", keywords: ["custom field", "value", "is"] },
  { value: "field_is_set", label: "Field is set", group: "Fields", description: "A custom field has any value.", keywords: ["custom field", "filled", "not empty"] },
  { value: "field_is_empty", label: "Field is empty", group: "Fields", description: "A custom field has no value.", keywords: ["custom field", "blank", "missing"] },
  { value: "assignee_is_set", label: "Has an assignee", group: "People", description: "Someone is assigned.", keywords: ["assign", "assigned"] },
  { value: "assignee_is_empty", label: "Has no assignee", group: "People", description: "Nobody is assigned yet.", keywords: ["assign", "unassigned"] },
  // Automations V2.
  { value: "field_compare", label: "Field compares", group: "Fields", description: "Greater or less than, before or after, contains, or is not.", keywords: ["custom field", "more than", "less than", "contains", "not", "number", "date"] },
  { value: "has_tag", label: "Has tag", group: "Fields", description: "The task has a tag you pick.", keywords: ["label"] },
  { value: "lacks_tag", label: "Doesn't have tag", group: "Fields", description: "The task doesn't have a tag you pick.", keywords: ["label", "without", "not"] },
  { value: "assignee_is", label: "Assignee is", group: "People", description: "Assigned to one of the people you pick.", keywords: ["assign", "person", "owner"] },
  { value: "assignee_is_not", label: "Assignee is not", group: "People", description: "Unassigned, or assigned to someone else.", keywords: ["assign", "person", "not"] },
  { value: "creator_is", label: "Created by", group: "People", description: "One of the people you pick created the task.", keywords: ["creator", "author", "requester"] },
  { value: "is_overdue", label: "Is overdue", group: "Dates", description: "Open, and due before today.", keywords: ["late", "past due"] },
  { value: "due_within", label: "Due within", group: "Dates", description: "Due today or in the next few days.", keywords: ["soon", "deadline", "upcoming"] },
  { value: "has_due_date", label: "Has a due date", group: "Dates", description: "A due date is set.", keywords: ["deadline", "scheduled"] },
  { value: "no_due_date", label: "Has no due date", group: "Dates", description: "No due date yet.", keywords: ["deadline", "unscheduled", "missing"] },
  { value: "task_type_is", label: "Task type is", group: "Task", description: "A task, a milestone, or an approval.", keywords: ["kind", "milestone", "approval"] },
  { value: "has_open_subtasks", label: "Has open subtasks", group: "Task", description: "At least one subtask isn't done.", keywords: ["checklist", "children", "incomplete"] },
  { value: "all_subtasks_done", label: "All subtasks are done", group: "Task", description: "It has subtasks and every one is complete.", keywords: ["checklist", "children", "finished"] },
  { value: "title_contains", label: "Name contains", group: "Task", description: "The task's name includes some text (any case).", keywords: ["title", "text", "keyword"] },
  { value: "form_answer_contains", label: "Form answer contains", group: "Approvals and forms", description: "An answer on the task's form submission includes some text.", keywords: ["form", "request", "submission", "answer", "intake"] },
  // Automations V3.
  { value: "person_compare", label: "Compare people", group: "People", description: "The assignee, creator, collaborators, or a People field is (or isn't) someone — e.g. the assignee is the creator.", keywords: ["dynamic", "same", "creator", "assignee", "people field", "collaborator", "follower", "equals"] },
  // Batch B: dates.
  { value: "date_compare", label: "Date is", group: "Dates", description: "The due or start date is before, after, on, or between dates you pick.", keywords: ["due", "start", "before", "after", "between", "range", "on"] },
  { value: "has_start_date", label: "Has a start date", group: "Dates", description: "A start date is set.", keywords: ["begin", "kickoff"] },
  { value: "no_start_date", label: "Has no start date", group: "Dates", description: "No start date yet.", keywords: ["begin", "missing"] },
  { value: "has_started", label: "Start date has arrived", group: "Dates", description: "It starts today or started earlier.", keywords: ["begin", "started", "passed", "in progress"] },
  { value: "start_within", label: "Starts within", group: "Dates", description: "Starts today or in the next few days.", keywords: ["begin", "soon", "upcoming"] },
  // Batch C: flow.
  { value: "section_is_one_of", label: "Section is one of", group: "Task", description: "The task is in any of the sections you pick.", keywords: ["column", "stage", "any of", "multiple"] },
  { value: "section_is_none_of", label: "Section is none of", group: "Task", description: "The task is in none of the sections you pick.", keywords: ["column", "stage", "not", "except"] },
  { value: "task_type_is_not", label: "Task type is not", group: "Task", description: "Not a task, a milestone, or an approval (your pick).", keywords: ["kind", "milestone", "approval", "not"] },
  { value: "is_blocked", label: "Is blocked", group: "Flow", description: "It waits on a task that isn't done (or hasn't started).", keywords: ["dependency", "waiting", "blocked by"] },
  { value: "is_not_blocked", label: "Isn't blocked", group: "Flow", description: "Nothing it depends on holds it up.", keywords: ["dependency", "ready", "unblocked"] },
  { value: "approval_status_is", label: "Approval status is", group: "Approvals and forms", description: "The task's latest approval is pending, approved, changes requested, rejected, or there isn't one.", keywords: ["approve", "review", "pending", "rejected"] },
  { value: "has_attachment", label: "Has an attachment", group: "Task", description: "At least one file is attached.", keywords: ["file", "upload", "asset"] },
  { value: "no_attachment", label: "Has no attachment", group: "Task", description: "No file is attached yet.", keywords: ["file", "upload", "missing"] },
  { value: "has_comment", label: "Has a comment", group: "Communication", description: "Someone (or a rule) commented.", keywords: ["reply", "message", "feedback"] },
  { value: "no_comment", label: "Has no comment", group: "Communication", description: "Nobody has commented yet.", keywords: ["reply", "message", "silent"] },
] as const;

export type ConditionType = (typeof CONDITIONS)[number]["value"];

export const ACTIONS = [
  { value: "move_section", label: "Move to section", group: "Task", description: "Moves the task to a section of this project.", keywords: ["column", "stage", "status"] },
  { value: "set_field", label: "Set field", group: "Fields", description: "Writes a value into a custom field (Status moves the section).", keywords: ["custom field", "priority", "value"] },
  { value: "set_assignee", label: "Set assignee", group: "People", description: "Assigns a person, the creator, or nobody.", keywords: ["assign", "owner", "unassign", "remove assignee"] },
  { value: "add_followers", label: "Add followers", group: "People", description: "Adds collaborators who'll hear about updates.", keywords: ["collaborator", "follow", "watch"] },
  { value: "add_comment", label: "Add comment", group: "Communication", description: "Posts a comment on the task as this rule.", keywords: ["message", "note", "mention"] },
  { value: "notify", label: "Send inbox notification", group: "Communication", description: "Puts a message in people's Inbox.", keywords: ["alert", "inbox", "ping", "tell"] },
  { value: "send_email", label: "Send email", group: "Communication", description: "Emails the submitter, the assignee, an address in a field, or a fixed address.", keywords: ["mail", "requester", "submitter"] },
  { value: "request_approval", label: "Request approval (approval subtask)", group: "Approvals", description: "Asks someone to approve, with an approval subtask.", keywords: ["approve", "review", "sign off"] },
  { value: "send_slack", label: "Send Slack message", group: "Integrations", description: "Posts to a Slack channel through an incoming webhook.", keywords: ["chat", "channel"] },
  { value: "call_webhook", label: "Call webhook", group: "Integrations", description: "POSTs a JSON summary of the task to an https:// address.", keywords: ["api", "zapier", "make", "http"] },
  { value: "delay", label: "Wait, then continue", group: "Flow", description: "Pauses for some hours, then runs the remaining actions.", keywords: ["delay", "later", "pause", "hours"] },
  // Automations V2.
  { value: "complete_task", label: "Mark complete", group: "Task", description: "Completes the task.", keywords: ["done", "finish", "close"] },
  { value: "reopen_task", label: "Mark incomplete", group: "Task", description: "Reopens a completed task.", keywords: ["reopen", "undo", "incomplete"] },
  { value: "set_title", label: "Rename task", group: "Task", description: "Changes the task's name (placeholders work here).", keywords: ["title", "name", "prefix"] },
  { value: "create_subtasks", label: "Create subtasks", group: "Task", description: "Adds a checklist of subtasks, optionally assigned.", keywords: ["checklist", "steps", "children", "todo"] },
  { value: "apply_task_template", label: "Apply task template", group: "Task", description: "Adds a task template's subtasks, tags, and field values.", keywords: ["template", "checklist", "preset"] },
  { value: "add_to_project", label: "Add to another project", group: "Task", description: "Also lists the task in another project (multi-home), in a section you pick.", keywords: ["multi-home", "copy", "calendar", "cross-project"] },
  { value: "set_due_date", label: "Set due date", group: "Dates", description: "Sets the due date a number of days (or business days) from today or another date, or clears it.", keywords: ["deadline", "relative", "business days", "workdays", "clear"] },
  { value: "add_tag", label: "Add tag", group: "Fields", description: "Tags the task.", keywords: ["label"] },
  { value: "remove_tag", label: "Remove tag", group: "Fields", description: "Removes a tag from the task.", keywords: ["label", "untag"] },
  // Automations V3.
  { value: "remove_followers", label: "Remove followers", group: "People", description: "People stop following the task (they no longer hear about updates).", keywords: ["collaborator", "unfollow", "watch", "remove"] },
  // Batch B.
  { value: "set_start_date", label: "Set start date", group: "Dates", description: "Sets the start date on a day, some days, weeks, or hours from a date, or clears it.", keywords: ["begin", "kickoff", "relative", "business days", "clear"] },
  // Batch C.
  { value: "create_task", label: "Create a task", group: "Task", description: "Makes a new task, milestone, or approval here or in another project, optionally linked to this one.", keywords: ["new", "spawn", "follow-up", "milestone", "approval", "handoff"] },
  { value: "move_to_project", label: "Move to another project", group: "Task", description: "Moves the task to another project (it leaves this one).", keywords: ["transfer", "cross-project", "relocate"] },
  { value: "remove_from_project", label: "Remove from this project", group: "Task", description: "Takes the task out of this project when it also lives in another one.", keywords: ["multi-home", "unlist", "remove"] },
  { value: "set_task_type", label: "Set task type", group: "Task", description: "Makes it a task, a milestone, or an approval.", keywords: ["kind", "milestone", "approval"] },
  { value: "set_description", label: "Set description", group: "Task", description: "Replaces the description, or adds text to its start or end (placeholders work).", keywords: ["notes", "details", "brief", "append"] },
] as const;

export type ActionType = (typeof ACTIONS)[number]["value"];

export const APPROVAL_DECISIONS = [
  { value: "approved", label: "Approved" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "rejected", label: "Rejected" },
] as const;

export const EMAIL_RECIPIENTS = [
  { value: "submitter", label: "Form submitter", description: "Whoever submitted the form that made this task." },
  { value: "assignee", label: "Assignee", description: "The task's assignee." },
  { value: "field", label: "Email in a field", description: "The address written in a text field." },
  { value: "address", label: "Fixed address", description: "Always the same address." },
] as const;

export const EMAIL_TEMPLATES = [
  { value: "requester_update", label: "Requester update", description: "“Your request moved to …” with the task, project, and section." },
  { value: "due_tomorrow", label: "Due tomorrow", description: "A reminder that the task is due tomorrow." },
  { value: "custom", label: "Plain message", description: "Just your subject and message." },
] as const;

// Where a task can come from (the "Task came from" condition; mirrors validate_rule).
export const TASK_SOURCES = [
  { value: "manual", label: "Created in the app", description: "Someone added it in a list, board, or My tasks." },
  { value: "form", label: "A form", description: "A form submission made it." },
  { value: "import", label: "An import", description: "The Asana importer brought it in." },
  { value: "inbound", label: "An inbound webhook", description: "Another tool sent it in." },
] as const;

// People slots accept a profile id, one of these roles, or (Automations V3) "field:<id>" — a People
// field of the project (its first person where one is needed, everyone in it where several are).
export const PERSON_ROLES = [
  { value: "assignee", label: "Task assignee" },
  { value: "creator", label: "Task creator" },
] as const;

export const TEXT_TOKENS = "{assignee} {creator} {task} {section} {project} {req} {due} {approval_note}";

// Integration actions (see the integrations migration). Stored shapes, as the builder reads them:
//   send_slack   { message, format?: "text" | "blocks", use_project_webhook?, webhook_ref?, webhook_hint? }
//   call_webhook { use_project_webhook?, url_ref?, url_hint?, secret_ref?, secret_set?, secret_header?,
//                  signing_ref?, signing_set? }
// Slack messages also take {task_link}. A Call webhook action's own signing secret is generated by the
// Server Action (the builder sends generate_signing_secret: true; "" for signing_secret removes it).
// To set or replace a value the builder sends webhook_url / url / secret (plain text) instead of the
// ref; a database trigger stores it out of reach of clients and writes back a ref + redacted hint.
// Sending "" for url / secret clears it. Without use_project_webhook the action's own URL wins and
// the project default (Settings → Integrations) is the fallback.
export const INTEGRATION_KEYS = {
  send_slack: { plain: "webhook_url", ref: "webhook_ref", hint: "webhook_hint" },
  call_webhook: { plain: "url", ref: "url_ref", hint: "url_hint" },
} as const;

// Triggers, conditions, and actions that arrive with Automations V2's database update.
export const V2_TRIGGERS: ReadonlySet<string> = new Set([
  "task_completed", "task_reopened", "subtasks_completed", "task_added_from_project", "comment_added",
  "attachment_added", "tag_added", "due_date_changed", "task_overdue", "scheduled", "manual",
]);
export const V2_CONDITIONS: ReadonlySet<string> = new Set([
  "field_compare", "has_tag", "lacks_tag", "assignee_is", "assignee_is_not", "creator_is", "is_overdue",
  "due_within", "has_due_date", "no_due_date", "task_type_is", "has_open_subtasks", "all_subtasks_done",
  "title_contains", "form_answer_contains",
]);
export const V2_ACTIONS: ReadonlySet<string> = new Set([
  "complete_task", "reopen_task", "set_title", "create_subtasks", "apply_task_template", "add_to_project",
  "set_due_date", "add_tag", "remove_tag",
]);

// Triggers, conditions, and actions that arrive with Automations V3's database update (new triggers
// also need its tail: the old trigger CHECK refuses them until then).
export const V3_TRIGGERS: ReadonlySet<string> = new Set([
  "follower_added",
  "start_date_changed", "start_approaching", "start_reached",
  "task_unblocked", "task_type_changed", "section_left",
]);
export const V3_CONDITIONS: ReadonlySet<string> = new Set([
  "person_compare",
  "date_compare", "has_start_date", "no_start_date", "has_started", "start_within",
  "section_is_one_of", "section_is_none_of", "task_type_is_not", "is_blocked", "is_not_blocked", "approval_status_is",
  "has_attachment", "no_attachment", "has_comment", "no_comment",
]);
export const V3_ACTIONS: ReadonlySet<string> = new Set([
  "remove_followers", "set_start_date",
  "create_task", "move_to_project", "remove_from_project", "set_task_type", "set_description",
]);

// A People field as a person slot.
export const FIELD_SLOT_PREFIX = "field:";
export function fieldSlot(fieldId: string) {
  return `${FIELD_SLOT_PREFIX}${fieldId}`;
}
export function fieldOfSlot(value: unknown): string | null {
  return typeof value === "string" && value.startsWith(FIELD_SLOT_PREFIX) ? value.slice(FIELD_SLOT_PREFIX.length) : null;
}

// "Set assignee" (mirrors execute_rule_actions / rule_pick_assignee): one person (a profile, a role, or
// a People field), take turns (round robin), or whoever has the fewest open tasks in the project.
export const ASSIGN_MODES = [
  { value: "person", label: "to", description: "A person, the task's creator, a People field, or nobody" },
  { value: "round_robin", label: "round robin among", description: "Takes turns through the people you pick" },
  { value: "balanced", label: "to the least busy of", description: "Whoever has the fewest open tasks in this project (ties take turns)" },
] as const;
export type AssignMode = (typeof ASSIGN_MODES)[number]["value"];

// "Compare people" sides (mirrors rule_side_people): plus "field:<id>" for a People field.
export const PERSON_SIDES = [
  { value: "assignee", label: "Assignee" },
  { value: "creator", label: "Creator" },
  { value: "followers", label: "Collaborators" },
] as const;

// "On a schedule" (mirrors rule_schedule_next_at): when, at a time of the rule's time zone. Automations
// V3 adds minutes, every N days / weeks (counted from `anchor`), and several weekdays (`weekdays`).
export const SCHEDULE_FREQUENCIES = [
  { value: "daily", label: "Every day", description: "Every day, or every few days" },
  { value: "workdays", label: "Every workday", description: "The workspace's workweek (Admin console → Organization)" },
  { value: "weekly", label: "Every week", description: "On the days you pick, every week or every few weeks" },
  { value: "monthly", label: "Every month", description: "On a day from 1 to 28" },
] as const;

// "Field compares" operators by field type (mirrors validate_rule).
export const COMPARE_OPS = [
  { value: "gt", label: "is greater than", types: ["number"] },
  { value: "gte", label: "is at least", types: ["number"] },
  { value: "lt", label: "is less than", types: ["number"] },
  { value: "lte", label: "is at most", types: ["number"] },
  { value: "before", label: "is before", types: ["date"] },
  { value: "after", label: "is after", types: ["date"] },
  { value: "contains", label: "contains", types: ["text", "multi_select"] },
  { value: "not_contains", label: "doesn't contain", types: ["text", "multi_select"] },
  { value: "not_equals", label: "is not", types: ["number", "date", "text", "single_select", "boolean", "status"] },
  // Automations V3 (batch B).
  { value: "between", label: "is between", types: ["number", "date"] },
  { value: "not_between", label: "isn't between", types: ["number", "date"] },
  // Batch C.
  { value: "one_of", label: "is one of", types: ["single_select", "status"] },
  { value: "none_of", label: "is none of", types: ["single_select", "status"] },
] as const;

// Compare ops whose value is a list of options.
export const LIST_OPS: ReadonlySet<string> = new Set(["one_of", "none_of"]);

// "Approval status is" (mirrors rule_condition_ok: the latest request that isn't cancelled).
export const APPROVAL_STATUSES = [
  { value: "none", label: "No approval", description: "Nobody has been asked" },
  { value: "pending", label: "Pending" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
] as const;

// "Task is no longer blocked": which kinds of link (mirrors task_dependencies' four kinds).
export const UNBLOCK_KINDS = [
  { value: "finish_to_start", label: "Finish → start", description: "It can start once the other task is done" },
  { value: "start_to_start", label: "Start → start", description: "It can start once the other task starts" },
  { value: "finish_to_finish", label: "Finish → finish", description: "It can finish once the other task is done" },
  { value: "start_to_finish", label: "Start → finish", description: "It can finish once the other task starts" },
] as const;

// "Create a task": how the new task relates to the one that triggered the rule.
export const CREATE_LINKS = [
  { value: "none", label: "not linked", description: "Just a new task" },
  { value: "blocked_by", label: "waiting on this task", description: "The new task is blocked by this one (finish → start)" },
  { value: "blocking", label: "holding this task up", description: "This task is blocked by the new one (finish → start)" },
] as const;

// "Set description": replace, or add to the start or the end.
export const DESCRIPTION_MODES = [
  { value: "replace", label: "to", description: "Replaces the whole description" },
  { value: "append", label: "by adding at the end", description: "Keeps what's there" },
  { value: "prepend", label: "by adding at the start", description: "Keeps what's there" },
] as const;

// Compare ops that need a second value (`to`).
export const RANGE_OPS: ReadonlySet<string> = new Set(["between", "not_between"]);

// "Date is" (mirrors rule_date_matches): which date, and how it compares with one or two days.
export const DATE_SUBJECTS = [
  { value: "due", label: "Due date" },
  { value: "start", label: "Start date" },
] as const;

export const DATE_OPS = [
  { value: "before", label: "is before" },
  { value: "after", label: "is after" },
  { value: "on", label: "is on" },
  { value: "on_or_before", label: "is on or before" },
  { value: "on_or_after", label: "is on or after" },
  { value: "between", label: "is between" },
  { value: "not_between", label: "isn't between" },
] as const;

// Date triggers' offsets (mirrors rule_trigger_offset): { amount, unit } or the older { days }.
export const OFFSET_UNITS = [
  { value: "hours", label: "hours", one: "hour", max: 720, min: 1 },
  { value: "days", label: "days", one: "day", max: 90, min: 0 },
  { value: "weeks", label: "weeks", one: "week", max: 12, min: 1 },
] as const;
export type OffsetUnit = (typeof OFFSET_UNITS)[number]["value"];

export function triggerOffset(cfg: Record<string, Json>, defaultDays = 1): { amount: number; unit: OffsetUnit } {
  const whole = (v: Json | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
  if (typeof cfg.unit === "string") {
    const unit = (["hours", "weeks"].includes(cfg.unit) ? cfg.unit : "days") as OffsetUnit;
    return { amount: whole(cfg.amount) ?? defaultDays, unit };
  }
  return { amount: whole(cfg.days) ?? defaultDays, unit: "days" };
}

// "Due / start date changes": any change, only to a new date, or only when it's cleared.
export const DATE_CHANGES = [
  { value: "any", label: "in any way", description: "Set, moved, or cleared" },
  { value: "set", label: "to a new date", description: "Set or moved (not cleared)" },
  { value: "cleared", label: "and is cleared", description: "Removed" },
] as const;

export function compareOpsFor(fieldType: string, boundToSections = false) {
  const key = boundToSections ? "status" : fieldType;
  return COMPARE_OPS.filter((op) => (op.types as readonly string[]).includes(key));
}

// "Set due / start date": counted from (mirrors rule_set_task_date). Hours always count from now.
export const DUE_FROM = [
  { value: "today", label: "today", description: "The day the rule runs" },
  { value: "due_date", label: "the current due date", description: "Today if there isn't one" },
  { value: "start_date", label: "the start date", description: "Today if there isn't one" },
] as const;

export const TASK_KIND_OPTIONS = [
  { value: "task", label: "Task" },
  { value: "milestone", label: "Milestone" },
  { value: "approval", label: "Approval" },
] as const;

export type RuleCondition = { type: ConditionType } & Record<string, Json>;
export type RuleAction = { type: ActionType } & Record<string, Json>;

export type RuleDef = {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  triggerType: TriggerType;
  triggerConfig: Record<string, Json>;
  conditions: RuleCondition[];
  actions: RuleAction[];
  presetKey: string | null;
  // Automations V2: who the rule acts for, and a scheduled rule's next run.
  ownerId?: string | null;
  nextRunAt?: string | null;
  // Batch 4: who changed it last, the rule-caused switch, and its health (auto-pause).
  lastEditedBy?: string | null;
  lastEditedAt?: string | null;
  runOnRuleChanges?: boolean;
  pausedAt?: string | null;
  pauseReason?: string | null;
  consecutiveFailures?: number;
};

export type RuleRunStats = {
  ruleId: string;
  lastRunAt: string | null;
  lastStatus: RuleRun["status"] | null;
  runs7d: number;
  failures7d: number;
};

export type RuleRun = {
  id: string;
  ruleId: string;
  taskId: string | null;
  taskTitle: string | null;
  status: "succeeded" | "failed" | "skipped" | "scheduled";
  detail: Json;
  createdAt: string;
};

export type PresetInput = {
  key: string;
  label: string;
  kind: "section" | "field" | "person" | "text" | "number";
  default?: Json;
};

export type RulePreset = {
  key: string;
  name: string;
  description: string;
  inputs: PresetInput[];
  ruleCount: number;
};

export function isTriggerType(value: unknown): value is TriggerType {
  return TRIGGERS.some((t) => t.value === value);
}

export function labelOf<T extends readonly { value: string; label: string }[]>(list: T, value: unknown) {
  return list.find((item) => item.value === value)?.label ?? String(value);
}

function record(value: Json): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {};
}

function typedList<T extends { type: string }>(value: Json): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const r = record(item);
    return typeof r.type === "string" ? [r as T] : [];
  });
}

export function toRuleDef(row: {
  id: string;
  project_id: string;
  name: string;
  enabled: boolean;
  trigger_type: string;
  trigger_config: Json;
  conditions: Json;
  actions: Json;
  preset_key: string | null;
  owner_id?: string | null;
  next_run_at?: string | null;
  last_edited_by?: string | null;
  last_edited_at?: string | null;
  run_on_rule_changes?: boolean;
  paused_at?: string | null;
  pause_reason?: string | null;
  consecutive_failures?: number;
}): RuleDef {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    enabled: row.enabled,
    triggerType: isTriggerType(row.trigger_type) ? row.trigger_type : "task_created",
    triggerConfig: record(row.trigger_config),
    conditions: typedList<RuleCondition>(row.conditions),
    actions: typedList<RuleAction>(row.actions),
    presetKey: row.preset_key,
    ownerId: row.owner_id ?? null,
    nextRunAt: row.next_run_at ?? null,
    lastEditedBy: row.last_edited_by ?? null,
    lastEditedAt: row.last_edited_at ?? null,
    runOnRuleChanges: row.run_on_rule_changes ?? true,
    pausedAt: row.paused_at ?? null,
    pauseReason: row.pause_reason ?? null,
    consecutiveFailures: row.consecutive_failures ?? 0,
  };
}

export function parsePresetInputs(value: Json): PresetInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const r = record(item);
    if (typeof r.key !== "string" || typeof r.label !== "string" || typeof r.kind !== "string") return [];
    return [{ key: r.key, label: r.label, kind: r.kind as PresetInput["kind"], ...(r.default !== undefined ? { default: r.default } : {}) }];
  });
}

export function runReason(detail: Json): string | null {
  const d = record(detail);
  if (typeof d.reason === "string") {
    return (
      {
        loop: "loop prevented (a rule can’t trigger itself)",
        depth_limit: "chain too deep (rules started by rules stop after three)",
        throttled: "throttled (20 runs an hour on one task)",
        rate_limited: "rate limited (1,000 runs an hour)",
      }[d.reason] ?? d.reason
    );
  }
  if (typeof d.error === "string") return d.error;
  // Failed runs log { actions: { error } } (run_rule catches the error around all actions).
  const actions = record(d.actions ?? null);
  if (typeof actions.error === "string") return actions.error;
  return null;
}

export function triggerLabel(type: TriggerType): string {
  return labelOf(TRIGGERS, type);
}

// Rule branches (Asana parity, batch 4; mirrors rule_item_branch() / validate_rule_branches() in
// 20261011040000_asana_parity_4.sql): conditions and actions may carry "branch": 0–4 (missing = 0).
// Branch 0 is "Check if", the next ones "Else if"; the first branch whose conditions pass runs its
// actions, and a last branch without conditions is "Otherwise". A rule without branch keys is one
// branch, exactly as before.
export const MAX_RULE_BRANCHES = 5;
export const MAX_BRANCH_ACTIONS = 10;
export const MAX_BRANCH_CONDITIONS = 20;

export type RuleBranch = { conditions: RuleCondition[]; actions: RuleAction[] };

export function itemBranch(item: Record<string, Json>): number {
  const value = item.branch;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MAX_RULE_BRANCHES ? value : 0;
}

export function ruleBranchCount(rule: Pick<RuleDef, "conditions" | "actions">): number {
  return 1 + Math.max(0, ...rule.conditions.map(itemBranch), ...rule.actions.map(itemBranch));
}

function withoutBranch<T extends Record<string, Json>>(item: T): T {
  const copy = { ...item };
  delete copy.branch;
  return copy;
}

// The rule's branches in order, without their branch keys (for the builder).
export function splitBranches(rule: Pick<RuleDef, "conditions" | "actions">): RuleBranch[] {
  return Array.from({ length: ruleBranchCount(rule) }, (_, b) => ({
    conditions: rule.conditions.filter((c) => itemBranch(c) === b).map(withoutBranch),
    actions: rule.actions.filter((a) => itemBranch(a) === b).map(withoutBranch),
  }));
}

// Back to the stored lists. A single branch writes no branch keys (byte-for-byte the old shape).
export function joinBranches(branches: RuleBranch[]): Pick<RuleDef, "conditions" | "actions"> {
  if (branches.length <= 1) {
    return { conditions: branches[0]?.conditions ?? [], actions: branches[0]?.actions ?? [] };
  }
  return {
    conditions: branches.flatMap((b, i) => b.conditions.map((c) => (i === 0 ? withoutBranch(c) : { ...c, branch: i }))),
    actions: branches.flatMap((b, i) => b.actions.map((a) => (i === 0 ? withoutBranch(a) : { ...a, branch: i }))),
  };
}

// The same checks as validate_rule_branches(), for a clear message before saving.
export function branchProblem(branches: RuleBranch[]): string | null {
  if (branches.length > MAX_RULE_BRANCHES) return `A rule can have up to ${MAX_RULE_BRANCHES} branches`;
  for (const [i, b] of branches.entries()) {
    const name = i === 0 ? "Check if" : i === branches.length - 1 && b.conditions.length === 0 ? "Otherwise" : `Else if ${i}`;
    if (b.actions.length === 0) return `${name}: add at least one action`;
    if (b.actions.length > MAX_BRANCH_ACTIONS) return `${name}: up to ${MAX_BRANCH_ACTIONS} actions`;
    if (b.conditions.length > MAX_BRANCH_CONDITIONS) return `${name}: up to ${MAX_BRANCH_CONDITIONS} conditions`;
    if (branches.length > 1 && b.conditions.length === 0 && i < branches.length - 1) {
      return `${name}: add a condition (only the last branch, Otherwise, can run without one)`;
    }
  }
  return null;
}

// OR groups inside a branch (Automations V2; mirrors rule_item_group() / rule_conditions_pass()): a
// condition may carry "group": 0–9 (missing = 0). A branch passes when every condition of any one group
// passes. One group writes no group keys (exactly the old shape).
export const MAX_CONDITION_GROUPS = 10;

export function conditionGroup(item: Record<string, Json>): number {
  const value = item.group;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MAX_CONDITION_GROUPS ? value : 0;
}

// The branch's conditions as groups in order (empty groups dropped), without their group keys.
export function splitGroups(conditions: RuleCondition[]): RuleCondition[][] {
  const groups = new Map<number, RuleCondition[]>();
  for (const c of conditions) {
    const g = conditionGroup(c);
    const copy = { ...c };
    delete copy.group;
    groups.set(g, [...(groups.get(g) ?? []), copy]);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, items]) => items);
}

// Back to one list: group keys 0, 1, 2… in order (the first group writes none); a single group writes
// no keys at all.
export function joinGroups(groups: RuleCondition[][]): RuleCondition[] {
  const kept = groups.filter((g) => g.length > 0);
  return kept.flatMap((g, i) =>
    g.map((c) => {
      const copy: RuleCondition = { ...c };
      delete copy.group;
      return kept.length > 1 && i > 0 ? { ...copy, group: i } : copy;
    }),
  );
}

// The same evaluation rule_conditions_pass makes, given each condition's own result (for previews,
// the dry run's explanation, and tests).
export function groupsPass<T>(conditions: T[], groupOf: (c: T) => number, ok: (c: T) => boolean): boolean {
  if (conditions.length === 0) return true;
  const groups = new Map<number, T[]>();
  for (const c of conditions) groups.set(groupOf(c), [...(groups.get(groupOf(c)) ?? []), c]);
  return [...groups.values()].some((g) => g.every(ok));
}
