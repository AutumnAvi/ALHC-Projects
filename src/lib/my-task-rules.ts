import type { Json } from "@/lib/supabase/database.types";

// My Tasks rules (Automations V3, batch E; mirrors guard_my_task_rule() and run_my_task_rule() in
// 20261021010000_automations_v3_a.sql): each person's own rules on the tasks assigned to them.

export const MY_TASK_TRIGGERS = [
  { value: "assigned", label: "A task is assigned to me", description: "Right when someone (or a rule) assigns it to you.", keywords: ["new", "assign"] },
  { value: "due_approaching", label: "A task is due soon", description: "Once per task, some days before its due date.", keywords: ["deadline", "soon"] },
  { value: "task_overdue", label: "A task is overdue", description: "Once per task, some days after its due date.", keywords: ["late", "past due"] },
] as const;
export type MyTaskTrigger = (typeof MY_TASK_TRIGGERS)[number]["value"];

export const MY_TASK_CONDITIONS = [
  { value: "in_project", label: "In project", description: "The task is in one of the projects you pick.", keywords: ["project"] },
  { value: "not_in_project", label: "Not in project", description: "The task is in none of the projects you pick.", keywords: ["project", "except"] },
  { value: "has_due_date", label: "Has a due date", description: "A due date is set.", keywords: ["deadline"] },
  { value: "no_due_date", label: "Has no due date", description: "No due date yet.", keywords: ["deadline"] },
  { value: "due_within", label: "Due within", description: "Due today or in the next few days.", keywords: ["soon"] },
  { value: "task_type_is", label: "Task type is", description: "A task, a milestone, or an approval.", keywords: ["kind", "milestone", "approval"] },
  { value: "is_private", label: "Is a private task", description: "One of your own tasks with no project.", keywords: ["personal", "private"] },
] as const;
export type MyTaskCondition = (typeof MY_TASK_CONDITIONS)[number]["value"];

export const MY_TASK_ACTIONS = [
  { value: "move_to_section", label: "Move to my section", description: "Moves it to one of your My tasks sections.", keywords: ["section", "today", "later"] },
  { value: "set_due_date", label: "Set due date", description: "Some days (or business days) from today.", keywords: ["deadline"] },
  { value: "complete_task", label: "Mark complete", description: "Completes it (if you can edit it and nothing blocks it).", keywords: ["done"] },
] as const;
export type MyTaskAction = (typeof MY_TASK_ACTIONS)[number]["value"];

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
    triggerType: (MY_TASK_TRIGGERS.some((t) => t.value === row.trigger_type) ? row.trigger_type : "assigned") as MyTaskTrigger,
    triggerConfig: record(row.trigger_config),
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

export function describeMyTaskTrigger(rule: Pick<MyTaskRule, "triggerType" | "triggerConfig">) {
  const n = whole(rule.triggerConfig.days) ?? 1;
  switch (rule.triggerType) {
    case "assigned":
      return "a task is assigned to me";
    case "due_approaching":
      return n === 0 ? "a task of mine is due today" : `a task of mine is due in ${n} day${n === 1 ? "" : "s"}`;
    default:
      return n <= 1 ? "a task of mine becomes overdue" : `a task of mine is ${n} days overdue`;
  }
}

export function describeMyTaskCondition(c: MyTaskRuleItem, ctx: MyTaskRuleContext) {
  switch (c.type) {
    case "in_project":
    case "not_in_project": {
      const names = strings(c.project_ids).map((id) => ctx.projects.find((p) => p.id === id)?.name ?? "a project");
      return `it’s ${c.type === "in_project" ? "in" : "not in"} ${names.length ? joinOr(names.map((x) => `“${x}”`)) : "…"}`;
    }
    case "due_within": {
      const n = whole(c.days);
      return n === null ? "it’s due soon" : n === 0 ? "it’s due today" : `it’s due within ${n} day${n === 1 ? "" : "s"}`;
    }
    case "task_type_is":
      return `it’s a${c.kind === "approval" ? "n approval" : c.kind === "milestone" ? " milestone" : " task"}`;
    case "has_due_date":
      return "it has a due date";
    case "no_due_date":
      return "it has no due date";
    case "is_private":
      return "it’s a private task";
    default:
      return c.type;
  }
}

export function describeMyTaskAction(a: MyTaskRuleItem, ctx: MyTaskRuleContext) {
  switch (a.type) {
    case "move_to_section":
      return `move it to “${ctx.sections.find((s) => s.id === a.section_id)?.name ?? "a removed section"}”`;
    case "set_due_date": {
      const n = whole(a.days) ?? 0;
      const unit = `${a.business_days === true ? "business " : ""}day${n === 1 ? "" : "s"}`;
      return n === 0 ? "set its due date to today" : `set its due date to ${n} ${unit} from today`;
    }
    case "complete_task":
      return "mark it complete";
    default:
      return a.type;
  }
}

export function myTaskRuleSentence(rule: Pick<MyTaskRule, "triggerType" | "triggerConfig" | "conditions" | "actions">, ctx: MyTaskRuleContext) {
  const conditions = rule.conditions.map((c) => describeMyTaskCondition(c, ctx)).join(" and ");
  const actions = rule.actions.map((a) => describeMyTaskAction(a, ctx)).join(", then ") || "do nothing yet";
  return `When ${describeMyTaskTrigger(rule)}, ${conditions ? `if ${conditions}, ` : ""}${actions}.`;
}
