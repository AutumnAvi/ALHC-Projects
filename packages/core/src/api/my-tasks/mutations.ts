// Big move 1: the my-tasks area's writes (the person's own My Tasks sections and placements, quick add,
// the checklist's settings and Undo, remembered expanded rows). Every function takes the caller's
// ApiContext first, validates its own input, writes only through ctx.db (RLS and the RPCs decide), and
// throws ApiError on any refusal; no Next.js here.
import { getSignedInUser } from "../auth/queries";
import { ORDER_STEP } from "../core/constants";
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { ApiError, invalid } from "../core/errors";
import { id, text } from "../core/validate";
import type { QuickAddTaskInput } from "./model";
import { recurrenceInput } from "../tasks/inputs";
import { isCheckedMode, type CheckedMode } from "../../checklist";
import type { Json } from "../../supabase/database.types";
import { isIsoDate } from "../../views";

// ---------------------------------------------------------------------------------------------
// My Tasks sections and placements
// ---------------------------------------------------------------------------------------------

export async function createMyTaskSection(ctx: ApiContext, name: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("ensure_my_task_sections"));
  const { data: last } = await supabase
    .from("my_task_sections")
    .select("sort_order")
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  check(
    await supabase.from("my_task_sections").insert({
      name: text(name, "Section name", { max: 100 }),
      sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
    }),
  );
}

// Only custom sections can be renamed or deleted (the database refuses the system ones).
export async function renameMyTaskSection(ctx: ApiContext, sectionId: string, name: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("my_task_sections")
      .update({ name: text(name, "Section name", { max: 100 }) })
      .eq("id", id(sectionId, "section"))
      .select("id"),
  );
}

// Its tasks move to the end of Recently assigned (database trigger).
export async function deleteMyTaskSection(ctx: ApiContext, sectionId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("my_task_sections")
      .update({ deleted_at: nowIso() })
      .eq("id", id(sectionId, "section"))
      .select("id"),
  );
}

export async function placeMyTaskSection(ctx: ApiContext, sectionId: string, beforeId: string | null): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("place_my_task_section", {
      target_section: id(sectionId, "section"),
      before_section: beforeId ? id(beforeId, "section") : null,
    }),
  );
}

// Places one of the viewer's tasks in one of their sections, before `beforeId` (null = end).
export async function placeMyTask(ctx: ApiContext, taskId: string, sectionId: string, beforeId: string | null): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("place_my_task", {
      target_task: id(taskId, "task"),
      target_section: id(sectionId, "section"),
      before_task: beforeId ? id(beforeId, "task") : null,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------------------------

// The My tasks / Home quick-add bar. Answers the new task's id, and a note when the @person couldn't be
// added as a follower (or the task is private).
export async function quickAddTask(ctx: ApiContext, input: QuickAddTaskInput): Promise<{ taskId: string; note?: string }> {
  let note: string | undefined;
  const title = text(input?.title, "Task name", { max: 1000 });
  const dueOn = input.dueOn ? (isIsoDate(input.dueOn) ? input.dueOn : null) : null;
  if (input.dueOn && !dueOn) throw invalid("Choose a valid due date");
  const rule = input.repeat
    ? recurrenceInput({
        freq: input.repeat.freq,
        interval: input.repeat.interval,
        weekdays: input.repeat.weekdays,
        ends: { type: "never" },
        timezone: input.timeZone,
        fromCompletion: input.repeat.fromCompletion,
      })
    : null;
  const mentionId = input.mentionId ? id(input.mentionId, "person") : null;
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) throw invalid("Sign in to add tasks");
  const created = input.projectId
    ? await supabase.rpc("create_task", { target_project: id(input.projectId, "project"), target_section: null, task_title: title })
    : await supabase.rpc("create_private_task", { task_title: title });
  check(created);
  const taskId = created.data ?? undefined;
  if (!taskId) throw new ApiError("failed", "Couldn’t add the task");
  const update: { assignee_id?: string; due_on?: string; recurrence?: Json } = {};
  // create_private_task assigns the task to its creator already; a project task is assigned to me too.
  if (input.projectId) update.assignee_id = user.id;
  if (dueOn) update.due_on = dueOn;
  if (rule) update.recurrence = rule;
  if (Object.keys(update).length > 0) checkUpdated(await supabase.from("tasks").update(update).eq("id", taskId).select("id"));
  if (!mentionId || mentionId === user.id) return { taskId, note };
  if (!input.projectId) {
    note = "Added to your tasks. Private tasks are only yours — add a #project to share it with them.";
    return { taskId, note };
  }
  // The follower insert policy refuses (or follow rules skip) someone who can't read the task.
  const followed = await supabase
    .from("task_followers")
    .upsert({ task_id: taskId, profile_id: mentionId, deleted_at: null }, { onConflict: "task_id,profile_id" })
    .select("profile_id");
  if (followed.error || !followed.data?.length) note = "Added, assigned to you. That person can’t open this project, so they weren’t added as a follower.";
  return { taskId, note };
}

// ---------------------------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------------------------

// Nov 1 notes (batch 9b): "Checked items" on My tasks (stay | sink | hide), saved on the account.
export async function setMyTasksChecked(ctx: ApiContext, mode: CheckedMode): Promise<void> {
  if (!isCheckedMode(mode)) throw invalid("Choose what checked items do");
  const supabase = ctx.db;
  const result = await supabase.rpc("set_my_tasks_checked", { mode });
  // A database without this release: the choice lasts for the visit.
  if (result.error?.code === "PGRST202") return;
  check(result);
}

// Nov 1 notes (batch 9b): "Not now" on a task's "Set a date" prompt.
export async function dismissDatePrompt(ctx: ApiContext, taskId: string): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase.rpc("dismiss_task_date_prompt", { target_task: id(taskId) });
  if (result.error?.code === "PGRST202") return;
  check(result);
}

// Undo a tick (the checklist's Undo): reopens the task, and when completing it just made the next
// occurrence of a repeating task (in the last ten minutes, still open), moves that occurrence to the
// Trash so the list doesn't hold both. Both are ordinary edits through RLS.
export async function undoTaskCompleted(ctx: ApiContext, taskId: string): Promise<void> {
  const supabase = ctx.db;
  const task = id(taskId);
  const before = await supabase.from("tasks").select("recurrence_next_id").eq("id", task).maybeSingle();
  check(before);
  checkUpdated(await supabase.from("tasks").update({ completed_at: null }).eq("id", task).select("id"));
  const nextId = before.data?.recurrence_next_id;
  if (!nextId) return;
  await supabase
    .from("tasks")
    .update({ deleted_at: nowIso() })
    .eq("id", nextId)
    .is("completed_at", null)
    .is("deleted_at", null)
    .gt("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
    .select("id");
}

// ---------------------------------------------------------------------------------------------
// Expanded rows
// ---------------------------------------------------------------------------------------------

export async function setTaskRowExpanded(ctx: ApiContext, taskId: string, expanded: boolean): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase.rpc("set_task_row_expanded", { target_task: id(taskId, "task"), expanded: expanded === true });
  // A database without this release: the row stays open for the visit only.
  if (result.error?.code === "PGRST202") return;
  check(result);
}
