// Big move 1: My Tasks automations' writes (Automations V3, batch E; Nov 4 notes, batch 20, 149). Every
// function takes the caller's ApiContext first, validates its own input, writes only through ctx.db (own
// rows only, through RLS), and throws ApiError on any refusal.
import { checkRuleSteps } from "@/lib/api/automations/shared";
import { hasMyTaskRulesV2 } from "@/lib/api/automations/queries";
import type { ApiContext } from "@/lib/api/core/context";
import { check, checkUpdated, nowIso } from "@/lib/api/core/db";
import { invalid, type DbErrorDetail } from "@/lib/api/core/errors";
import { id, text } from "@/lib/api/core/validate";
import { MY_TASK_TRIGGERS, myTaskTriggerToDb, needsMyTaskV2 } from "@/lib/my-task-rules";
import type { Json } from "@/lib/supabase/database.types";

export type MyTaskRuleInput = {
  name: string;
  enabled: boolean;
  triggerType: string;
  triggerConfig: Record<string, Json>;
  conditions: Record<string, Json>[];
  actions: Record<string, Json>[];
  timeZone?: string;
};

const NOT_YOURS = "That isn’t one of your automations";

async function myTaskRuleRow(ctx: ApiContext, input: MyTaskRuleInput) {
  if (!MY_TASK_TRIGGERS.some((t) => t.value === input.triggerType)) throw invalid("Choose a trigger");
  if (!Array.isArray(input.actions) || input.actions.length === 0) throw invalid("Add at least one action");
  checkRuleSteps(input, "my_tasks");
  // Nov 4 notes (batch 20, 149): the wider vocabulary only once the database takes it (an older database would
  // run an event trigger as "a task is assigned to me").
  const usesV2 =
    needsMyTaskV2("trigger", input.triggerType) ||
    (input.conditions ?? []).some((c) => typeof c.type === "string" && needsMyTaskV2("condition", c.type)) ||
    input.actions.some((a) => typeof a.type === "string" && needsMyTaskV2("action", a.type));
  if (usesV2 && !(await hasMyTaskRulesV2(ctx))) throw invalid("That step needs this release’s database update");
  const stored = myTaskTriggerToDb(input.triggerType, input.triggerConfig ?? {});
  const triggerConfig: Record<string, Json> = { ...stored.triggerConfig };
  if (input.timeZone && input.timeZone.length <= 64) triggerConfig.timezone = input.timeZone;
  return {
    name: text(input.name, "Automation name", { max: 200 }),
    enabled: Boolean(input.enabled),
    trigger_type: stored.triggerType,
    trigger_config: triggerConfig,
    conditions: Array.isArray(input.conditions) ? input.conditions : [],
    actions: Array.isArray(input.actions) ? input.actions : [],
  };
}

function myTaskRuleError(result: { error: DbErrorDetail | null }) {
  if (result.error && (result.error.code === "PGRST205" || result.error.code === "42P01")) throw invalid("My Tasks automations need this release’s database update");
  check(result, NOT_YOURS);
}

// A new automation (no id) or a change to one of the person's own.
export async function saveMyTaskRule(ctx: ApiContext, ruleId: string | null, input: MyTaskRuleInput): Promise<void> {
  const supabase = ctx.db;
  if (ruleId) {
    const updated = await supabase.from("my_task_rules").update(await myTaskRuleRow(ctx, input)).eq("id", id(ruleId, "rule")).select("id");
    myTaskRuleError(updated);
    checkUpdated(updated, NOT_YOURS);
  } else {
    myTaskRuleError(await supabase.from("my_task_rules").insert(await myTaskRuleRow(ctx, input)));
  }
}

export async function setMyTaskRuleEnabled(ctx: ApiContext, ruleId: string, enabled: boolean): Promise<void> {
  const supabase = ctx.db;
  const updated = await supabase.from("my_task_rules").update({ enabled: Boolean(enabled) }).eq("id", id(ruleId, "rule")).select("id");
  myTaskRuleError(updated);
  checkUpdated(updated, NOT_YOURS);
}

export async function deleteMyTaskRule(ctx: ApiContext, ruleId: string): Promise<void> {
  const supabase = ctx.db;
  const updated = await supabase.from("my_task_rules").update({ deleted_at: nowIso(), enabled: false }).eq("id", id(ruleId, "rule")).select("id");
  myTaskRuleError(updated);
  checkUpdated(updated, NOT_YOURS);
}
