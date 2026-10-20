// The rule templates gallery (Automations V2, batch 3; docs/AUTOMATIONS-RESEARCH.md §6). Each recipe
// builds an ordinary rule for a project: sections, fields, options, and tags are filled in by name when
// the project has a match ("Review", "Priority" → "High"), and every slot it can't fill is left empty
// and listed in `missing` — the builder highlights those, and saving asks for them (validate_rule).
// Nothing here is tied to a team: the hints are common words, never ids.

import type { Json } from "@/lib/supabase/database.types";
import type { RuleAction, RuleCondition, TriggerType } from "@/lib/rules";

export const TEMPLATE_CATEGORIES = [
  { value: "intake", label: "Intake & routing" },
  { value: "reviews", label: "Reviews & approvals" },
  { value: "requester", label: "Requester updates" },
  { value: "deadlines", label: "Deadlines" },
  { value: "handoffs", label: "Handoffs" },
  { value: "integrations", label: "Integrations" },
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]["value"];

export type TemplateContext = {
  sections: { id: string; name: string }[];
  fields: { id: string; name: string; fieldType: string; boundToSections: boolean; options: { id: string; name: string }[] }[];
  tags: { id: string; name: string; archived: boolean }[];
  otherProjects: { id: string; name: string }[];
};

export type BuiltRule = {
  name: string;
  triggerType: TriggerType;
  triggerConfig: Record<string, Json>;
  conditions: RuleCondition[];
  actions: RuleAction[];
  // What the person still has to pick ("the reviewer", "a section like “Review”").
  missing: string[];
};

export type RuleTemplate = {
  key: string;
  name: string;
  category: TemplateCategory;
  // The sentence on the card (the builder shows the real one once it's filled in).
  sentence: string;
  build: (ctx: TemplateContext) => BuiltRule;
};

// ---------------------------------------------------------------------------------------------
// Filling slots by name

function words(name: string) {
  return name.toLowerCase();
}

function byHint<T extends { name: string }>(items: T[], hints: string[]): T | undefined {
  for (const hint of hints) {
    const exact = items.find((i) => words(i.name) === hint);
    if (exact) return exact;
  }
  for (const hint of hints) {
    const partial = items.find((i) => words(i.name).includes(hint));
    if (partial) return partial;
  }
  return undefined;
}

class Slots {
  missing: string[] = [];
  constructor(private ctx: TemplateContext) {}

  section(hints: string[], what: string): string {
    const found = byHint(this.ctx.sections, hints);
    if (!found) this.missing.push(what);
    return found?.id ?? "";
  }

  // A single-select field and one of its options (both by name).
  option(fieldHints: string[], optionHints: string[], what: string): { field_id: string; value: string } {
    const field = byHint(
      this.ctx.fields.filter((f) => f.fieldType === "single_select" && !f.boundToSections),
      fieldHints,
    );
    const option = field ? byHint(field.options, optionHints) : undefined;
    if (!field || !option) this.missing.push(what);
    return { field_id: field?.id ?? "", value: option?.id ?? "" };
  }

  tag(hints: string[], what: string): string {
    const found = byHint(this.ctx.tags.filter((t) => !t.archived), hints);
    if (!found) this.missing.push(what);
    return found?.id ?? "";
  }

  person(what: string): string {
    this.missing.push(what);
    return "";
  }

  project(hints: string[], what: string): string {
    const found = byHint(this.ctx.otherProjects, hints);
    if (!found) this.missing.push(what);
    return found?.id ?? "";
  }
}

// What a recipe returns. Items are plain objects (their keys are checked by validate_rule on save).
type Draft = {
  triggerType: TriggerType;
  triggerConfig?: Record<string, Json>;
  conditions: ({ type: string } & Record<string, unknown>)[];
  actions: ({ type: string } & Record<string, unknown>)[];
};

function make(ctx: TemplateContext, name: string, fill: (s: Slots) => Draft): BuiltRule {
  const slots = new Slots(ctx);
  const built = fill(slots);
  return {
    name,
    triggerType: built.triggerType,
    triggerConfig: built.triggerConfig ?? {},
    conditions: built.conditions as RuleCondition[],
    actions: built.actions as RuleAction[],
    missing: slots.missing,
  };
}

const REVIEW = ["review", "in review", "reviewing", "qa", "proofing"];
const APPROVED = ["approved", "done", "complete", "delivered"];
const DONE = ["done", "complete", "completed", "delivered", "finished"];
const IN_PROGRESS = ["in progress", "doing", "design", "in design", "working"];
const INTAKE = ["intake", "new", "new requests", "requests", "inbox", "to do", "backlog"];
const AT_RISK = ["at risk", "blocked", "on hold", "stuck"];

// ---------------------------------------------------------------------------------------------
// The recipes

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  // Intake & routing
  {
    key: "route_by_type",
    name: "Route by request type",
    category: "intake",
    sentence: "When a form is submitted, if Request type is Video, assign the video lead and move to Video intake.",
    build: (ctx) =>
      make(ctx, "Route video requests", (s) => {
        const type = s.option(["request type", "type", "category"], ["video"], "a Request type field with a “Video” option");
        return {
          triggerType: "form_submitted",
          conditions: [{ type: "field_equals", field_id: type.field_id, value: type.value }],
          actions: [
            { type: "set_assignee", assignee: s.person("the video lead") },
            { type: "move_section", section_id: s.section(["video", "video intake", ...INTAKE], "the section for video work") },
          ],
        };
      }),
  },
  {
    key: "form_checklist",
    name: "New form request → creative checklist",
    category: "intake",
    sentence: "When a form is submitted, create the creative checklist and set the due date 5 business days out.",
    build: (ctx) =>
      make(ctx, "Creative checklist for new requests", () => ({
        triggerType: "form_submitted",
        conditions: [],
        actions: [
          { type: "create_subtasks", titles: ["Review the brief", "First draft", "Internal review", "Requester review", "Final files"] },
          { type: "set_due_date", mode: "relative", days: 5, business_days: true, from: "today" },
        ],
      })),
  },
  {
    key: "triage_owner",
    name: "New task → assign the triage owner",
    category: "intake",
    sentence: "When a task is added and nobody is assigned, assign the triage owner and tell them.",
    build: (ctx) =>
      make(ctx, "Assign new tasks for triage", (s) => {
        const owner = s.person("the triage owner");
        return {
          triggerType: "task_created",
          conditions: [{ type: "assignee_is_empty" }],
          actions: [
            { type: "set_assignee", assignee: owner },
            { type: "notify", people: ["assignee"], message: "New request to triage: {{task.name}}" },
          ],
        };
      }),
  },
  {
    key: "default_due",
    name: "New requests get a due date",
    category: "intake",
    sentence: "When a task is added without a due date, set it 5 business days from today.",
    build: (ctx) =>
      make(ctx, "Default due date", () => ({
        triggerType: "task_created",
        conditions: [{ type: "no_due_date" }],
        actions: [{ type: "set_due_date", mode: "relative", days: 5, business_days: true, from: "today" }],
      })),
  },
  {
    key: "rush_tag",
    name: "Rush requests → tag and alert",
    category: "intake",
    sentence: "When a form is submitted and an answer mentions “rush”, tag it Urgent and notify the assignee.",
    build: (ctx) =>
      make(ctx, "Flag rush requests", (s) => ({
        triggerType: "form_submitted",
        conditions: [{ type: "form_answer_contains", text: "rush" }],
        actions: [
          { type: "add_tag", tag_id: s.tag(["urgent", "rush", "priority", "hot"], "a tag like “Urgent”") },
          { type: "notify", people: ["assignee"], message: "Rush request: {{task.name}} (due {{task.due_date}})" },
        ],
      })),
  },
  {
    key: "kickoff_manual",
    name: "Kick off a request (run by hand)",
    category: "intake",
    sentence: "When someone runs it from a task, add the kickoff subtasks, follow it, and set the due date a week out.",
    build: (ctx) =>
      make(ctx, "Kick off this request", () => ({
        triggerType: "manual",
        conditions: [],
        actions: [
          { type: "create_subtasks", titles: ["Kickoff call", "Moodboard", "Timeline to requester"], assignee: "assignee" },
          { type: "add_followers", people: ["creator"] },
          { type: "set_due_date", mode: "relative", days: 5, business_days: true, from: "today" },
        ],
      })),
  },
  // Reviews & approvals
  {
    key: "review_assign",
    name: "Review → assign the reviewer",
    category: "reviews",
    sentence: "When a task moves into Review, assign the reviewer and post a comment with the link.",
    build: (ctx) =>
      make(ctx, "Assign the reviewer", (s) => ({
        triggerType: "section_changed",
        triggerConfig: { section_id: s.section(REVIEW, "a section like “Review”") },
        conditions: [],
        actions: [
          { type: "set_assignee", assignee: s.person("the reviewer") },
          { type: "add_comment", body: "{assignee} “{{task.name}}” is ready for review." },
        ],
      })),
  },
  {
    key: "review_approval",
    name: "Review → request approval",
    category: "reviews",
    sentence: "When a task moves into Review, ask the approver to approve it.",
    build: (ctx) =>
      make(ctx, "Request approval in Review", (s) => ({
        triggerType: "section_changed",
        triggerConfig: { section_id: s.section(REVIEW, "a section like “Review”") },
        conditions: [],
        actions: [{ type: "request_approval", approver: s.person("the approver"), note: "Please review “{{task.name}}”." }],
      })),
  },
  {
    key: "approved_notify",
    name: "Approved → move and notify the requester",
    category: "reviews",
    sentence: "When an approval is approved, move to Approved and email the requester.",
    build: (ctx) =>
      make(ctx, "Approved: move and tell the requester", (s) => ({
        triggerType: "approval_decided",
        triggerConfig: { statuses: ["approved"] },
        conditions: [],
        actions: [
          { type: "move_section", section_id: s.section(APPROVED, "a section like “Approved”") },
          {
            type: "send_email",
            to: "submitter",
            template: "custom",
            subject: "Approved: {{task.name}}",
            message: "Good news: “{{task.name}}” was approved. We’ll send the final files soon.",
          },
        ],
      })),
  },
  {
    key: "changes_back",
    name: "Changes requested → back to the designer",
    category: "reviews",
    sentence: "When changes are requested, move it back to In progress, reassign the designer, and comment with the feedback.",
    build: (ctx) =>
      make(ctx, "Changes requested: back to design", (s) => ({
        triggerType: "approval_decided",
        triggerConfig: { statuses: ["changes_requested"] },
        conditions: [],
        actions: [
          { type: "move_section", section_id: s.section(IN_PROGRESS, "a section like “In progress”") },
          { type: "set_assignee", assignee: s.person("the designer") },
          { type: "add_comment", body: "{assignee} changes requested: {{approval.note}}" },
        ],
      })),
  },
  {
    key: "rejected_close",
    name: "Rejected → note it and close",
    category: "reviews",
    sentence: "When an approval is rejected, comment with the reason and mark the task complete.",
    build: (ctx) =>
      make(ctx, "Rejected: close it", () => ({
        triggerType: "approval_decided",
        triggerConfig: { statuses: ["rejected"] },
        conditions: [],
        actions: [
          { type: "add_comment", body: "Closed after the approval was rejected: {{approval.note}}" },
          { type: "complete_task" },
        ],
      })),
  },
  // Requester updates
  {
    key: "stage_email",
    name: "Stage change → update the requester",
    category: "requester",
    sentence: "When a task moves into In progress, send the requester an update.",
    build: (ctx) =>
      make(ctx, "Tell the requester work started", (s) => ({
        triggerType: "section_changed",
        triggerConfig: { section_id: s.section(IN_PROGRESS, "a section like “In progress”") },
        conditions: [{ type: "source_is", source: "form" }],
        actions: [
          {
            type: "send_email",
            to: "submitter",
            template: "requester_update",
            message: "We’ve started on “{{task.name}}”. It’s due {{task.due_date}}.",
          },
        ],
      })),
  },
  {
    key: "completed_email",
    name: "Completed → email the requester",
    category: "requester",
    sentence: "When a form request is completed, email the requester that it’s done.",
    build: (ctx) =>
      make(ctx, "Tell the requester it’s done", () => ({
        triggerType: "task_completed",
        conditions: [{ type: "source_is", source: "form" }],
        actions: [
          {
            type: "send_email",
            to: "submitter",
            template: "custom",
            subject: "Done: {{task.name}}",
            message: "“{{task.name}}” is complete. Thanks for the request!",
          },
        ],
      })),
  },
  {
    key: "reply_notify",
    name: "New comment on a request → notify the assignee",
    category: "requester",
    sentence: "When a comment is added to a form request, notify the assignee.",
    build: (ctx) =>
      make(ctx, "New comment: tell the assignee", () => ({
        triggerType: "comment_added",
        conditions: [{ type: "source_is", source: "form" }, { type: "assignee_is_set" }],
        actions: [{ type: "notify", people: ["assignee"], message: "New comment on “{{task.name}}”" }],
      })),
  },
  // Deadlines
  {
    key: "due_soon_intake",
    name: "Due in 2 days and still in Intake → alert",
    category: "deadlines",
    sentence: "When a task is due in 2 days and still in Intake, notify the assignee and the creator.",
    build: (ctx) =>
      make(ctx, "Due soon, still in Intake", (s) => ({
        triggerType: "due_approaching",
        triggerConfig: { days: 2 },
        conditions: [{ type: "section_is", section_id: s.section(INTAKE, "a section like “Intake”") }],
        actions: [
          { type: "notify", people: ["assignee", "creator"], message: "“{{task.name}}” is due {{task.due_date}} and hasn’t started." },
        ],
      })),
  },
  {
    key: "overdue_priority",
    name: "Overdue → raise the priority",
    category: "deadlines",
    sentence: "When a task becomes overdue, set Priority to High and notify the assignee.",
    build: (ctx) =>
      make(ctx, "Overdue: raise the priority", (s) => {
        const priority = s.option(["priority"], ["high", "urgent", "p1"], "a Priority field with a “High” option");
        return {
          triggerType: "task_overdue",
          triggerConfig: { days: 1 },
          conditions: [],
          actions: [
            { type: "set_field", field_id: priority.field_id, value: priority.value },
            { type: "notify", people: ["assignee"], message: "“{{task.name}}” is overdue (was due {{task.due_date}})." },
          ],
        };
      }),
  },
  {
    key: "overdue_at_risk",
    name: "Overdue → move to At risk",
    category: "deadlines",
    sentence: "When a task is 2 days overdue, move it to At risk.",
    build: (ctx) =>
      make(ctx, "Overdue: move to At risk", (s) => ({
        triggerType: "task_overdue",
        triggerConfig: { days: 2 },
        conditions: [],
        actions: [{ type: "move_section", section_id: s.section(AT_RISK, "a section like “At risk”") }],
      })),
  },
  {
    key: "due_tomorrow",
    name: "Due tomorrow → remind the assignee",
    category: "deadlines",
    sentence: "When a task is due tomorrow, remind the assignee.",
    build: (ctx) =>
      make(ctx, "Due tomorrow reminder", () => ({
        triggerType: "due_approaching",
        triggerConfig: { days: 1 },
        conditions: [{ type: "assignee_is_set" }],
        actions: [{ type: "notify", people: ["assignee"], message: "Reminder: “{{task.name}}” is due tomorrow." }],
      })),
  },
  {
    key: "weekly_digest",
    name: "Weekly Monday check-in",
    category: "deadlines",
    sentence: "Every Monday at 9:00 AM, comment on each task still in Review to ask about blockers.",
    build: (ctx) =>
      make(ctx, "Monday check-in on Review", (s) => ({
        triggerType: "scheduled",
        triggerConfig: { frequency: "weekly", weekday: 1, hour: 9 },
        conditions: [{ type: "section_is", section_id: s.section(REVIEW, "a section like “Review”") }],
        actions: [
          { type: "add_comment", body: "Weekly check-in: “{{task.name}}” is still in {{task.section}}. Any blockers, {assignee}?" },
        ],
      })),
  },
  // Handoffs
  {
    key: "subtasks_done",
    name: "All subtasks done → complete the parent",
    category: "handoffs",
    sentence: "When all of a task’s subtasks are done, mark the task complete.",
    build: (ctx) =>
      make(ctx, "Complete when the checklist is done", () => ({
        triggerType: "subtasks_completed",
        conditions: [],
        actions: [{ type: "complete_task" }],
      })),
  },
  {
    key: "completed_done",
    name: "Completed → move to Done",
    category: "handoffs",
    sentence: "When a task is completed, move it to Done.",
    build: (ctx) =>
      make(ctx, "Move finished work to Done", (s) => ({
        triggerType: "task_completed",
        conditions: [],
        actions: [{ type: "move_section", section_id: s.section(DONE, "a section like “Done”") }],
      })),
  },
  {
    key: "handoff_comment",
    name: "Reassigned → post a handoff note",
    category: "handoffs",
    sentence: "When the assignee changes, comment to the new assignee with the due date.",
    build: (ctx) =>
      make(ctx, "Handoff note", () => ({
        triggerType: "assignee_changed",
        conditions: [{ type: "assignee_is_set" }, { type: "is_incomplete" }],
        actions: [{ type: "add_comment", body: "{assignee} you’re up on “{{task.name}}” (due {{task.due_date}})." }],
      })),
  },
  {
    key: "calendar",
    name: "Dated work → add to the Creative calendar",
    category: "handoffs",
    sentence: "When a due date is set, also add the task to the Creative calendar project.",
    build: (ctx) =>
      make(ctx, "Add dated work to the calendar", (s) => ({
        triggerType: "due_date_changed",
        conditions: [{ type: "has_due_date" }],
        actions: [{ type: "add_to_project", project_id: s.project(["calendar", "creative calendar", "content calendar"], "the calendar project") }],
      })),
  },
  // Integrations
  {
    key: "slack_review",
    name: "Ready for review → Slack the team",
    category: "integrations",
    sentence: "When a task moves into Review, post a task card to Slack.",
    build: (ctx) =>
      make(ctx, "Slack the team for review", (s) => ({
        triggerType: "section_changed",
        triggerConfig: { section_id: s.section(REVIEW, "a section like “Review”") },
        conditions: [],
        actions: [{ type: "send_slack", format: "blocks", use_project_webhook: true, message: "Ready for review: {{task.name}} ({{task.assignee}})" }],
      })),
  },
  {
    key: "webhook_complete",
    name: "Completed → send to Zapier or Make",
    category: "integrations",
    sentence: "When a task is completed, call the project webhook with the task’s details.",
    build: (ctx) =>
      make(ctx, "Send finished tasks to the webhook", () => ({
        triggerType: "task_completed",
        conditions: [],
        actions: [{ type: "call_webhook", use_project_webhook: true }],
      })),
  },
];

export function findRuleTemplate(key: string | null | undefined): RuleTemplate | null {
  return RULE_TEMPLATES.find((t) => t.key === key) ?? null;
}
