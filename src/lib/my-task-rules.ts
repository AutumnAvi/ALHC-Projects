import type { Json } from "@/lib/supabase/database.types";

// My Tasks rules (Automations V3, batch E; mirrors guard_my_task_rule() and run_my_task_rule()): each person's
// own rules on the tasks assigned to them. Nov 4 notes (batch 20, 149): the project automations' vocabulary
// wherever it makes sense for personal tasks (20261104010000_nov4_batch20_a.sql). The database keeps
// trigger_type to assigned / due_approaching / task_overdue, so the newer triggers are stored with a
// discriminator in trigger_config (myTaskTriggerToDb / toMyTaskRule do the mapping).

export const MY_TASK_TRIGGERS = [
  { value: "assigned", label: "A task is assigned to me", group: "People", description: "Right when someone (or an automation) assigns it to you.", keywords: ["new", "assign"] },
  { value: "comment_added", label: "Someone comments on a task of mine", group: "Communication", description: "A comment by anyone but you.", keywords: ["reply", "message"] },
  { value: "attachment_added", label: "Someone attaches a file", group: "Communication", description: "A file added to a task of yours by anyone but you.", keywords: ["file", "upload", "attachment"] },
  { value: "task_completed", label: "A task of mine is completed", group: "Task", description: "When someone (or a project automation) completes it.", keywords: ["done", "finished"] },
  { value: "task_reopened", label: "A task of mine is reopened", group: "Task", description: "When it's marked incomplete again.", keywords: ["incomplete", "undo"] },
  { value: "subtasks_completed", label: "All subtasks of a task of mine are done", group: "Task", description: "When the last open subtask is completed.", keywords: ["subtask", "checklist"] },
  { value: "tag_added", label: "A tag is added to a task of mine", group: "Task", description: "Any tag, or one you pick.", keywords: ["tag", "label"] },
  { value: "due_approaching", label: "A task is due soon", group: "Dates", description: "Once per task, some days before its due date.", keywords: ["deadline", "soon"] },
  { value: "task_overdue", label: "A task is overdue", group: "Dates", description: "Once per task, some days after its due date.", keywords: ["late", "past due"] },
  { value: "due_date_changed", label: "The due date of a task of mine changes", group: "Dates", description: "When someone moves, sets, or clears it.", keywords: ["deadline", "reschedule"] },
  { value: "start_approaching", label: "A task of mine starts soon", group: "Dates", description: "Once per task, some days before its start date (0 = the day it starts).", keywords: ["start", "begin"] },
  { value: "start_date_changed", label: "The start date of a task of mine changes", group: "Dates", description: "When someone moves, sets, or clears it.", keywords: ["start", "reschedule"] },
] as const;
export type MyTaskTrigger = (typeof MY_TASK_TRIGGERS)[number]["value"];

// The triggers stored as trigger_type "assigned" + trigger_config.event, and the one stored as
// "due_approaching" + date "start". These need this release's database update (MY_TASK_V2_TRIGGERS).
const EVENT_TRIGGERS = new Set<string>([
  "comment_added",
  "attachment_added",
  "task_completed",
  "task_reopened",
  "subtasks_completed",
  "tag_added",
  "due_date_changed",
  "start_date_changed",
]);
export const MY_TASK_V2_TRIGGERS: ReadonlySet<string> = new Set([...EVENT_TRIGGERS, "start_approaching"]);

export const MY_TASK_CONDITIONS = [
  { value: "in_project", label: "In project", group: "Task", description: "The task is in one of the projects you pick.", keywords: ["project"] },
  { value: "not_in_project", label: "Not in project", group: "Task", description: "The task is in none of the projects you pick.", keywords: ["project", "except"] },
  { value: "is_private", label: "Is a private task", group: "Task", description: "One of your own tasks with no project.", keywords: ["personal", "private"] },
  { value: "is_not_private", label: "Is in a project", group: "Task", description: "Not a private task: it's in at least one project.", keywords: ["project", "shared"] },
  { value: "task_type_is", label: "Task type is", group: "Task", description: "A task, a milestone, or an approval.", keywords: ["kind", "milestone", "approval"] },
  { value: "task_type_is_not", label: "Task type is not", group: "Task", description: "Anything but the type you pick.", keywords: ["kind", "milestone", "approval"] },
  { value: "title_contains", label: "Name contains", group: "Task", description: "The task's name has the text you type (any case).", keywords: ["title", "text", "word"] },
  { value: "has_open_subtasks", label: "Has open subtasks", group: "Task", description: "At least one subtask isn't done.", keywords: ["subtask"] },
  { value: "all_subtasks_done", label: "All subtasks are done", group: "Task", description: "It has subtasks and every one is complete.", keywords: ["subtask"] },
  { value: "has_attachment", label: "Has an attachment", group: "Task", description: "At least one file is attached.", keywords: ["file"] },
  { value: "no_attachment", label: "Has no attachment", group: "Task", description: "No file is attached.", keywords: ["file"] },
  { value: "is_blocked", label: "Is blocked", group: "Task", description: "Another task it depends on isn't done.", keywords: ["dependency", "waiting"] },
  { value: "is_not_blocked", label: "Isn't blocked", group: "Task", description: "Nothing it depends on is holding it up.", keywords: ["dependency"] },
  { value: "has_tag", label: "Has tag", group: "Task", description: "The tag you pick is on the task.", keywords: ["tag", "label"] },
  { value: "lacks_tag", label: "Doesn't have tag", group: "Task", description: "The tag you pick isn't on the task.", keywords: ["tag", "label"] },
  { value: "created_by_me", label: "Created by me", group: "People", description: "You made the task.", keywords: ["creator", "author"] },
  { value: "not_created_by_me", label: "Created by someone else", group: "People", description: "Someone else made it (and gave it to you).", keywords: ["creator", "author", "delegated"] },
  { value: "has_comment", label: "Has a comment", group: "Communication", description: "Someone commented on it.", keywords: ["reply"] },
  { value: "no_comment", label: "Has no comment", group: "Communication", description: "Nobody has commented yet.", keywords: ["reply"] },
  { value: "has_due_date", label: "Has a due date", group: "Dates", description: "A due date is set.", keywords: ["deadline"] },
  { value: "no_due_date", label: "Has no due date", group: "Dates", description: "No due date yet.", keywords: ["deadline"] },
  { value: "due_within", label: "Due within", group: "Dates", description: "Due today or in the next few days.", keywords: ["soon"] },
  { value: "is_overdue", label: "Is overdue", group: "Dates", description: "Its due date has passed and it isn't done.", keywords: ["late"] },
  { value: "has_start_date", label: "Has a start date", group: "Dates", description: "A start date is set.", keywords: ["start"] },
  { value: "no_start_date", label: "Has no start date", group: "Dates", description: "No start date yet.", keywords: ["start"] },
  { value: "start_within", label: "Starts within", group: "Dates", description: "Starts today or in the next few days.", keywords: ["start", "soon"] },
] as const;
export type MyTaskCondition = (typeof MY_TASK_CONDITIONS)[number]["value"];
const V1_CONDITIONS = new Set<string>(["in_project", "not_in_project", "has_due_date", "no_due_date", "due_within", "task_type_is", "is_private"]);

export const MY_TASK_ACTIONS = [
  { value: "move_to_section", label: "Move to my section", group: "My tasks", description: "Moves it to one of your My tasks sections.", keywords: ["section", "today", "later"] },
  { value: "complete_task", label: "Mark complete", group: "Task", description: "Completes it (if you can edit it and nothing blocks it). Approval tasks are skipped until they’re approved.", keywords: ["done"] },
  { value: "reopen_task", label: "Mark incomplete", group: "Task", description: "Reopens it (if you can edit it).", keywords: ["undo", "reopen"] },
  { value: "set_title", label: "Rename task", group: "Task", description: "A new name; {{task.name}} keeps the old one in it.", keywords: ["title", "name", "prefix"] },
  { value: "set_task_type", label: "Set task type", group: "Task", description: "Make it a task or a milestone.", keywords: ["kind", "milestone"] },
  { value: "create_subtasks", label: "Create subtasks", group: "Task", description: "Adds subtasks under it (if you can edit it).", keywords: ["checklist", "steps"] },
  { value: "add_to_project", label: "Add to a project", group: "Task", description: "Adds it to a project you can edit (a private task becomes part of it).", keywords: ["project", "share"] },
  { value: "add_tag", label: "Add tag", group: "Task", description: "Puts a tag on it.", keywords: ["tag", "label"] },
  { value: "remove_tag", label: "Remove tag", group: "Task", description: "Takes a tag off it.", keywords: ["tag", "label"] },
  { value: "add_comment", label: "Add comment", group: "Communication", description: "A comment posted as you; @mention people with {{task.creator}}.", keywords: ["reply", "note", "message"] },
  { value: "set_assignee", label: "Hand it to someone", group: "People", description: "Assigns it to someone else who can open it (it leaves your list).", keywords: ["assign", "delegate", "reassign"] },
  { value: "add_followers", label: "Add followers", group: "People", description: "People who can open the task follow it.", keywords: ["follow", "cc", "notify"] },
  { value: "remove_followers", label: "Remove followers", group: "People", description: "Stops people following it (others need Editor).", keywords: ["unfollow"] },
  { value: "set_due_date", label: "Set due date", group: "Dates", description: "Some days (or business days) from today.", keywords: ["deadline"] },
  { value: "set_start_date", label: "Set start date", group: "Dates", description: "Some days (or business days) from today; the due date moves if it would be earlier.", keywords: ["start"] },
] as const;
export type MyTaskAction = (typeof MY_TASK_ACTIONS)[number]["value"];
const V1_ACTIONS = new Set<string>(["move_to_section", "set_due_date", "complete_task"]);

// What needs this release's database update (the pickers grey these out until it's applied).
export function needsMyTaskV2(kind: "trigger" | "condition" | "action", value: string): boolean {
  if (kind === "trigger") return MY_TASK_V2_TRIGGERS.has(value);
  if (kind === "condition") return !V1_CONDITIONS.has(value);
  return !V1_ACTIONS.has(value);
}

// The app's trigger → what the database stores.
export function myTaskTriggerToDb(
  triggerType: string,
  triggerConfig: Record<string, Json>,
): { triggerType: "assigned" | "due_approaching" | "task_overdue"; triggerConfig: Record<string, Json> } {
  const rest: Record<string, Json> = { ...triggerConfig };
  delete rest.event;
  delete rest.date;
  if (EVENT_TRIGGERS.has(triggerType)) return { triggerType: "assigned", triggerConfig: { ...rest, event: triggerType } };
  if (triggerType === "start_approaching") return { triggerType: "due_approaching", triggerConfig: { ...rest, date: "start" } };
  if (triggerType === "due_approaching" || triggerType === "task_overdue") return { triggerType, triggerConfig: rest };
  return { triggerType: "assigned", triggerConfig: rest };
}

export type MyTaskRuleItem = { type: string } & Record<string, Json>;

export type MyTaskRule = {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: MyTaskTrigger;
  triggerConfig: Record<string, Json>;
  conditions: MyTaskRuleItem[];
  actions: MyTaskRuleItem[];
};

export type MyTaskRuleContext = {
  sections: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  // Nov 3 notes (batch 19, 140): the organization's workweek, named next to "whose workdays".
  workWeek?: number[];
  // Nov 4 notes (batch 20): the viewer's own workdays (150; null = not set), and for 149's vocabulary: people,
  // tags (and whether tags are on), projects the person can add tasks to (with their sections), and whether
  // the database takes the wider vocabulary yet (false = those steps are greyed out).
  personalWorkWeek?: number[] | null;
  people?: { id: string; name: string }[];
  tags?: { id: string; name: string; color?: string; archived?: boolean }[];
  tagsEnabled?: boolean;
  editableProjects?: { id: string; name: string; sections: { id: string; name: string }[] }[];
  v2?: boolean;
};

function record(value: Json | undefined): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {};
}

function items(value: Json): MyTaskRuleItem[] {
  return Array.isArray(value)
    ? value.flatMap((x) => {
        const r = record(x);
        return typeof r.type === "string" ? [r as MyTaskRuleItem] : [];
      })
    : [];
}

// What the database stores → the app's trigger (an unknown one reads as "assigned to me").
function fromDbTrigger(type: string, config: Record<string, Json>): { triggerType: MyTaskTrigger; triggerConfig: Record<string, Json> } {
  const rest: Record<string, Json> = { ...config };
  const event = typeof rest.event === "string" ? rest.event : null;
  const date = rest.date;
  delete rest.event;
  delete rest.date;
  if (type === "assigned" && event && EVENT_TRIGGERS.has(event)) return { triggerType: event as MyTaskTrigger, triggerConfig: rest };
  if (type === "due_approaching" && date === "start") return { triggerType: "start_approaching", triggerConfig: rest };
  if (type === "due_approaching" || type === "task_overdue") return { triggerType: type, triggerConfig: rest };
  return { triggerType: "assigned", triggerConfig: rest };
}

export function toMyTaskRule(row: {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: string;
  trigger_config: Json;
  conditions: Json;
  actions: Json;
}): MyTaskRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    ...fromDbTrigger(row.trigger_type, record(row.trigger_config)),
    conditions: items(row.conditions),
    actions: items(row.actions),
  };
}

const whole = (v: Json | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
const strings = (v: Json | undefined) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function joinOr(words: string[]) {
  if (words.length <= 2) return words.join(" or ");
  return `${words.slice(0, -1).join(", ")}, or ${words[words.length - 1]}`;
}

const personName = (id: Json | undefined, ctx: MyTaskRuleContext) =>
  typeof id === "string" ? (ctx.people?.find((p) => p.id === id)?.name ?? "someone") : "someone";
const tagName = (id: Json | undefined, ctx: MyTaskRuleContext) =>
  typeof id === "string" && id ? `“${ctx.tags?.find((t) => t.id === id)?.name ?? "a removed tag"}”` : null;
const kindWord = (kind: Json | undefined) =>
  kind === "approval" ? "an approval" : kind === "milestone" ? "a milestone" : kind === "task" ? "a task" : null;
const quoted = (text: Json | undefined, max = 60) => {
  if (typeof text !== "string" || !text.trim()) return null;
  const t = text.trim();
  return `“${t.length > max ? `${t.slice(0, max)}…` : t}”`;
};

export function describeMyTaskTrigger(rule: Pick<MyTaskRule, "triggerType" | "triggerConfig">, ctx?: MyTaskRuleContext) {
  const n = whole(rule.triggerConfig.days) ?? 1;
  switch (rule.triggerType) {
    case "assigned":
      return "a task is assigned to me";
    case "due_approaching":
      return n === 0 ? "a task of mine is due today" : `a task of mine is due in ${n} day${n === 1 ? "" : "s"}`;
    case "start_approaching":
      return n === 0 ? "a task of mine starts today" : `a task of mine starts in ${n} day${n === 1 ? "" : "s"}`;
    case "task_overdue":
      return n <= 1 ? "a task of mine becomes overdue" : `a task of mine is ${n} days overdue`;
    case "comment_added":
      return "someone comments on a task of mine";
    case "attachment_added":
      return "someone attaches a file to a task of mine";
    case "task_completed":
      return "a task of mine is completed";
    case "task_reopened":
      return "a task of mine is reopened";
    case "subtasks_completed":
      return "all subtasks of a task of mine are done";
    case "tag_added": {
      const tag = ctx ? tagName(rule.triggerConfig.tag_id, ctx) : null;
      return tag ? `the tag ${tag} is added to a task of mine` : "a tag is added to a task of mine";
    }
    case "due_date_changed":
      return "the due date of a task of mine changes";
    case "start_date_changed":
      return "the start date of a task of mine changes";
    default:
      return "a task is assigned to me";
  }
}

export function describeMyTaskCondition(c: MyTaskRuleItem, ctx: MyTaskRuleContext) {
  switch (c.type) {
    case "in_project":
    case "not_in_project": {
      const names = strings(c.project_ids).map((id) => ctx.projects.find((p) => p.id === id)?.name ?? "a project");
      return `it’s ${c.type === "in_project" ? "in" : "not in"} ${names.length ? joinOr(names.map((x) => `“${x}”`)) : "(choose projects)"}`;
    }
    case "due_within":
    case "start_within": {
      const n = whole(c.days);
      const lead = c.type === "due_within" ? "it’s due" : "it starts";
      if (n === null) return `${lead} within (enter a number of days)`;
      if (n === 0) return `${lead} today`;
      return `${lead} within ${n} day${n === 1 ? "" : "s"}`;
    }
    case "task_type_is":
    case "task_type_is_not": {
      const word = kindWord(c.kind);
      if (!word) return "it’s (choose a task type)";
      return `it’s ${c.type === "task_type_is_not" ? "not " : ""}${word}`;
    }
    case "has_tag":
    case "lacks_tag": {
      const tag = tagName(c.tag_id, ctx) ?? "(choose a tag)";
      return c.type === "has_tag" ? `it has the tag ${tag}` : `it doesn’t have the tag ${tag}`;
    }
    case "title_contains":
      return `its name contains ${quoted(c.text) ?? "(enter some text)"}`;
    case "has_due_date":
      return "it has a due date";
    case "no_due_date":
      return "it has no due date";
    case "is_overdue":
      return "it’s overdue";
    case "has_start_date":
      return "it has a start date";
    case "no_start_date":
      return "it has no start date";
    case "is_private":
      return "it’s a private task";
    case "is_not_private":
      return "it’s in a project";
    case "has_open_subtasks":
      return "it has open subtasks";
    case "all_subtasks_done":
      return "all its subtasks are done";
    case "is_blocked":
      return "it’s blocked";
    case "is_not_blocked":
      return "it isn’t blocked";
    case "has_attachment":
      return "it has an attachment";
    case "no_attachment":
      return "it has no attachment";
    case "has_comment":
      return "it has a comment";
    case "no_comment":
      return "it has no comment";
    case "created_by_me":
      return "I created it";
    case "not_created_by_me":
      return "someone else created it";
    default:
      return c.type;
  }
}

function dateAction(a: MyTaskRuleItem, what: string) {
  const n = whole(a.days);
  if (n === null) return `set its ${what} to (enter a number of days)`;
  const unit = `${a.business_days === true ? "business " : ""}day${n === 1 ? "" : "s"}`;
  return n === 0 ? `set its ${what} to today` : `set its ${what} to ${n} ${unit} from today`;
}

export function describeMyTaskAction(a: MyTaskRuleItem, ctx: MyTaskRuleContext) {
  switch (a.type) {
    case "move_to_section":
      if (typeof a.section_id !== "string" || !a.section_id) return "move it to (choose one of your sections)";
      return `move it to “${ctx.sections.find((s) => s.id === a.section_id)?.name ?? "a removed section"}”`;
    case "set_due_date":
      return dateAction(a, "due date");
    case "set_start_date":
      return dateAction(a, "start date");
    case "complete_task":
      return "mark it complete";
    case "reopen_task":
      return "mark it incomplete";
    case "add_comment":
      return `comment ${quoted(a.body) ?? "(write the comment)"}`;
    case "set_title":
      return `rename it to ${quoted(a.title) ?? "(write the new name)"}`;
    case "set_task_type":
      return `make it ${kindWord(a.kind) ?? "(choose a task type)"}`;
    case "add_tag":
      return `add the tag ${tagName(a.tag_id, ctx) ?? "(choose a tag)"}`;
    case "remove_tag":
      return `remove the tag ${tagName(a.tag_id, ctx) ?? "(choose a tag)"}`;
    case "add_followers":
    case "remove_followers": {
      const names = strings(a.people).map((id) => personName(id, ctx));
      const who = names.length ? names.join(", ") : "(choose people)";
      return a.type === "add_followers" ? `add ${who} as followers` : `remove ${who} as followers`;
    }
    case "set_assignee":
      return typeof a.assignee === "string" && a.assignee ? `hand it to ${personName(a.assignee, ctx)}` : "hand it to (choose a person)";
    case "create_subtasks": {
      const titles = strings(a.titles).filter((t) => t.trim());
      return titles.length ? `create subtask${titles.length === 1 ? "" : "s"} ${titles.map((t) => `“${t.trim()}”`).join(", ")}` : "create subtasks (name at least one)";
    }
    case "add_to_project": {
      if (typeof a.project_id !== "string" || !a.project_id) return "add it to (choose a project)";
      const project = ctx.editableProjects?.find((p) => p.id === a.project_id) ?? ctx.projects.find((p) => p.id === a.project_id);
      const section = typeof a.section_id === "string" && a.section_id && ctx.editableProjects?.find((p) => p.id === a.project_id)?.sections.find((x) => x.id === a.section_id);
      return `add it to “${project?.name ?? "a project"}”${section ? ` in “${section.name}”` : ""}`;
    }
    default:
      return a.type;
  }
}

export function myTaskRuleSentence(rule: Pick<MyTaskRule, "triggerType" | "triggerConfig" | "conditions" | "actions">, ctx: MyTaskRuleContext) {
  const conditions = rule.conditions.map((c) => describeMyTaskCondition(c, ctx)).join(" and ");
  const actions = rule.actions.map((a) => describeMyTaskAction(a, ctx)).join(", then ") || "do nothing yet";
  return `When ${describeMyTaskTrigger(rule, ctx)}, ${conditions ? `if ${conditions}, ` : ""}${actions}.`;
}
