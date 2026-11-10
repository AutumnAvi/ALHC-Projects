// AI builder round 5 (note 178): the registry's task, approval, and collaboration tools. Every write is an
// existing typed-API mutation run with the person's own context (RLS, the guards, the blocked-completion
// guard decide as by hand); nothing here uses the service role.
import { APPROVAL_SETUP_UNFINISHED, approvalSetupUnfinished } from "../../approval-setup";
import { BIG_CHANGE_ITEMS } from "../../ai-tools";
import { blockedCompletionReason, parseBlockerCounts } from "../../blocked-completion";
import { isRealDate } from "../../ai-builder";
import { describeRecurrence, parseRecurrence, recurrenceJson, type Recurrence } from "../../recurrence";
import type { Json } from "../../supabase/database.types";
import type { ApiContext } from "../core/context";
import { maybe, rows } from "../core/db";
import { ApiError, invalid } from "../core/errors";
import { acknowledgeApproval, cancelApproval, handOffApproval, requestApproval, resubmitApproval, sendForApproval, setApprovalFollowUp, setTaskApprovers, withdrawApproval } from "../approvals/mutations";
import { addComment, deleteAttachment, deleteComment, editComment, setCommentPinned, setFollowing, toggleReaction } from "../comments/mutations";
import { previewDependencyShift } from "../dependencies/queries";
import { applyDependencyShift, removeTaskDependency, setTaskDependency } from "../dependencies/mutations";
import { addNewTaskTag, addTaskTag, createTag, removeTaskTag, updateTag } from "../tags/mutations";
import {
  addTaskToProject,
  convertToSubtask,
  convertToTask,
  createSubtask,
  createTask,
  deleteTask,
  duplicateTask,
  moveTask,
  removeTaskFromProject,
  restoreTask,
  setTaskCompleted,
  setTaskKind,
  setTaskRecurrence,
  updateTask,
} from "../tasks/mutations";
import {
  allowedIn,
  clean,
  existingTask,
  isProvisional,
  loadTasks,
  personArg,
  personName,
  placeholder,
  projectArg,
  provisionalRef,
  refArg,
  sectionArg,
  staged,
  strs,
  taskArg,
  taskInProjectNow,
} from "./env";
import { refuse, ToolRefusal, type Handler, type OpState, type StagedOp, type ToolEnv } from "./types";

const lower = (v: string) => v.toLowerCase();
const KEEP = Symbol("keep");
type DateArg = string | null | typeof KEEP;

function dateArg(v: unknown, what: string): DateArg {
  const t = clean(v);
  if (!t) return KEEP;
  if (lower(t) === "none") return null;
  return isRealDate(t) ? t : refuse(`${what}: dates are YYYY-MM-DD`);
}

const showDates = (start: string | null, due: string | null) => [start ? `start ${start}` : null, due ? `due ${due}` : "no due date"].filter(Boolean).join(" · ");

// ---- Reading a task's state ------------------------------------------------------------------------------

type TaskRowState = { title: string; notes: string | null; assignee_id: string | null; due_on: string | null; start_on: string | null; completed_at: string | null; kind: string; recurrence: Json | null; deleted_at: string | null; parent_task_id: string | null };
async function taskRow(ctx: ApiContext, taskId: string): Promise<TaskRowState | null> {
  return maybe(
    await ctx.db.from("tasks").select("title, notes, assignee_id, due_on, start_on, completed_at, kind, recurrence, deleted_at, parent_task_id").eq("id", taskId).maybeSingle(),
    "task",
  ) as TaskRowState | null;
}
const taskId = (op: StagedOp) => String(op.args.task_id);

// The state of a task an operation compares (only the keys it changes).
function readTaskKeys(...keys: string[]) {
  return async (ctx: ApiContext, op: StagedOp): Promise<OpState> => {
    const t = await taskRow(ctx, taskId(op));
    if (!t) return { missing: true };
    const all: OpState = {
      title: t.title,
      notes: t.notes?.trim() ? t.notes : null,
      assignee_id: t.assignee_id ? lower(t.assignee_id) : null,
      due_on: t.due_on,
      start_on: t.start_on,
      completed: Boolean(t.completed_at),
      kind: t.kind,
      recurrence: t.recurrence,
      deleted: Boolean(t.deleted_at),
      parent: t.parent_task_id,
    };
    if (t.deleted_at && !keys.includes("deleted")) return { missing: true };
    return Object.fromEntries(keys.map((k) => [k, all[k] ?? null]));
  };
}

async function verifyTask(ctx: ApiContext, _ws: string, op: StagedOp, opts: { undoing: boolean }) {
  if (op.projectId) await taskInProjectNow(ctx, taskId(op), op.projectId, { deleted: op.op === "delete_task" ? opts.undoing : op.op === "restore_task" ? !opts.undoing : false });
}

// A task tool's common start: the task, checked against the tool's role in its project.
async function editableTask(env: ToolEnv, tool: Parameters<typeof allowedIn>[1], input: Record<string, unknown>, what: string, key = "task", opts: { deleted?: boolean } = {}) {
  const t = await existingTask(env, input[key], what, opts);
  const p = allowedIn(env, tool, t.projectId, what);
  return { t, p };
}

// ---- Tasks -----------------------------------------------------------------------------------------------

const createTaskTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "create_task", p.id, what);
    const title = clean(input.title);
    if (!title || title.length > 500) refuse(`${what}: a task name is 1–500 characters`);
    const section = clean(input.section) ? sectionArg(env, input.section, p.id, what, true) : null;
    const assignee = clean(input.assignee) ? personArg(env, input.assignee, what, { among: p.memberIds, allowNone: true, amongLabel: `a member of “${p.name}”` }) : null;
    const due = dateArg(input.due, what);
    const start = dateArg(input.start, what);
    const kind = clean(input.kind) || "task";
    if (!["task", "milestone", "approval"].includes(kind)) refuse(`${what}: the type is task, milestone, or approval`);
    if (typeof due === "string" && typeof start === "string" && start > due) refuse(`${what}: the start date must be on or before the due date`);
    const notes = typeof input.description === "string" ? input.description.trim().slice(0, 10000) : "";
    const index = env.staged.length;
    const ref = provisionalRef(env, "task", index, title);
    const sectionId = section ? (isProvisional(section) ? placeholder(section.index) : section.id) : null;
    const bits = [
      section ? `in ${isProvisional(section) ? `${section.label} (new)` : section.name}` : null,
      assignee ? `for ${personName(env, assignee)}` : null,
      typeof due === "string" ? `due ${due}` : null,
      kind !== "task" ? kind : null,
    ].filter(Boolean);
    return staged("create_task", p.id, `New task in “${p.name}” (${ref})`, "—", `${title}${bits.length ? ` · ${bits.join(" · ")}` : ""}`, {
      project_id: p.id, section_id: sectionId, title, assignee_id: assignee, due_on: typeof due === "string" ? due : null, start_on: typeof start === "string" ? start : null, kind, notes: notes || null,
    }, { dependsOn: section && isProvisional(section) ? [section.index] : [] });
  },
  async read(ctx, _op, created) {
    if (!created) return {};
    const t = await taskRow(ctx, created);
    return t ? { title: t.title, deleted: Boolean(t.deleted_at), completed: Boolean(t.completed_at) } : { missing: true };
  },
  async apply(ctx, _op, a) {
    const res = await createTask(ctx, String(a.project_id), (a.section_id as string | null) ?? null, String(a.title), (a.kind as "task") ?? "task");
    const id = res.taskId ?? null;
    if (!id) throw new ApiError("failed", "The task wasn’t created");
    const patch: Parameters<typeof updateTask>[2] = {};
    if (a.assignee_id) patch.assigneeId = String(a.assignee_id);
    if (a.due_on) patch.dueOn = String(a.due_on);
    if (a.start_on && a.kind !== "milestone") patch.startOn = String(a.start_on);
    if (a.notes) patch.notes = String(a.notes);
    if (Object.keys(patch).length) await updateTask(ctx, id, patch);
    return id;
  },
  async undo(ctx, _op, _before, created) {
    if (created) await deleteTask(ctx, created);
  },
};

const createSubtaskTool: Handler = {
  async stage(env, input, what) {
    const parent = await taskArg(env, input.parent, what, { allowNew: true });
    const projectId = isProvisional(parent) ? env.staged[parent.index].projectId! : parent.projectId;
    const p = allowedIn(env, "create_subtask", projectId, what);
    const title = clean(input.title);
    if (!title || title.length > 500) refuse(`${what}: a subtask name is 1–500 characters`);
    const assignee = clean(input.assignee) ? personArg(env, input.assignee, what, { among: p.memberIds, allowNone: true, amongLabel: `a member of “${p.name}”` }) : null;
    const due = dateArg(input.due, what);
    const parentLabel = isProvisional(parent) ? parent.label : parent.title;
    const ref = provisionalRef(env, "task", env.staged.length, title);
    return staged("create_subtask", projectId, `New subtask of “${parentLabel}” (${ref})`, "—", [title, assignee ? `for ${personName(env, assignee)}` : null, typeof due === "string" ? `due ${due}` : null].filter(Boolean).join(" · "), {
      parent_id: isProvisional(parent) ? placeholder(parent.index) : parent.id, title, assignee_id: assignee, due_on: typeof due === "string" ? due : null,
    }, { dependsOn: isProvisional(parent) ? [parent.index] : [] });
  },
  read: createTaskTool.read,
  async apply(ctx, _op, a) {
    const res = await createSubtask(ctx, String(a.parent_id), String(a.title));
    const id = res.taskId ?? null;
    if (!id) throw new ApiError("failed", "The subtask wasn’t created");
    if (a.assignee_id || a.due_on) await updateTask(ctx, id, { ...(a.assignee_id ? { assigneeId: String(a.assignee_id) } : {}), ...(a.due_on ? { dueOn: String(a.due_on) } : {}) });
    return id;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteTask(ctx, created);
  },
};

const duplicateTaskTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "duplicate_task", input, what);
    const title = clean(input.title) || `Copy of ${t.title}`;
    return staged("duplicate_task", t.projectId, `Duplicate “${t.title}”`, "—", `${title} (with its subtasks, assignee, dates, tags, and field values)`, { task_id: t.id, title });
  },
  read: createTaskTool.read,
  verify: verifyTask,
  async apply(ctx, _op, a) {
    const { result } = await duplicateTask(ctx, String(a.task_id), { title: String(a.title), subtasks: true, assignee: true, dates: true, tags: true, fields: true, followers: false, attachments: false, dependencies: false } as Parameters<typeof duplicateTask>[2]);
    return result.taskId;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteTask(ctx, created);
  },
};

const renameTaskTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "rename_task", input, what);
    const name = clean(input.name);
    if (!name || name.length > 500) refuse(`${what}: a task name is 1–500 characters`);
    if (name === t.title) refuse(`${what}: the task is already called that`);
    return staged("rename_task", t.projectId, "Rename task", t.title, name, { task_id: t.id, title: name });
  },
  read: readTaskKeys("title"),
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await updateTask(ctx, String(a.task_id), { title: String(a.title) });
    return null;
  },
  async undo(ctx, op, before) {
    await updateTask(ctx, taskId(op), { title: String(before.title ?? "") });
  },
};

const setDescriptionTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "set_description", input, what);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (text.length > 10_000) refuse(`${what}: the description is too long`);
    const notes = text || null;
    if ((t.notes?.trim() || null) === notes) refuse(`${what}: the description already says that`);
    return staged("set_description", t.projectId, `Description of “${t.title}”`, t.notes?.trim() ? t.notes.slice(0, 200) : "—", notes ? notes.slice(0, 200) : "—", { task_id: t.id, notes });
  },
  read: readTaskKeys("notes"),
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await updateTask(ctx, String(a.task_id), { notes: (a.notes as string | null) ?? null });
    return null;
  },
  async undo(ctx, op, before) {
    await updateTask(ctx, taskId(op), { notes: (before.notes as string | null) ?? null });
  },
};

async function membershipState(ctx: ApiContext, task: string, projectId: string) {
  return maybe(await ctx.db.from("task_projects").select("section_id, sort_order").eq("task_id", task).eq("project_id", projectId).is("deleted_at", null).maybeSingle(), "task project");
}

const moveTaskTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "move_task", input, what);
    if (t.parentId) refuse(`${what}: “${t.title}” is a subtask; it moves with its parent`);
    const from = env.context.projects.find((p) => p.id === t.projectId)!;
    const to = clean(input.project) ? await projectArg(env, input.project, what) : from;
    allowedIn(env, "move_task", to.id, what);
    const sectionText = clean(input.section);
    let sectionId: string | null = null;
    let label = "No section";
    let dependsOn: number[] = [];
    if (sectionText && lower(sectionText) !== "none") {
      const s = sectionArg(env, sectionText, to.id, what, true);
      if (isProvisional(s)) {
        sectionId = placeholder(s.index);
        dependsOn = [s.index];
        label = `${s.label} (new)`;
      } else {
        sectionId = s.id;
        label = s.name;
      }
    } else if (!sectionText && to.id === t.projectId) refuse(`${what}: say which section`);
    const other = to.id !== t.projectId;
    if (!other && sectionId === t.sectionId) refuse(`${what}: “${t.title}” is already there`);
    const sectionName = (id: string | null) => (id ? (from.sections.find((s) => s.id === id)?.name ?? "a section") : "No section");
    return staged("move_task", t.projectId, `Move “${t.title}”`, other ? `${from.name} · ${sectionName(t.sectionId)}` : sectionName(t.sectionId), other ? `${to.name} · ${label}` : label, {
      task_id: t.id, from_project_id: t.projectId, to_project_id: to.id, section_id: sectionId,
    }, { projects: other ? [t.projectId, to.id] : [t.projectId], dependsOn });
  },
  async read(ctx, op) {
    const from = await membershipState(ctx, taskId(op), String(op.args.from_project_id));
    const state: OpState = { section_id: from?.section_id ?? null, sort_order: from?.sort_order ?? null, member: Boolean(from) };
    if (op.args.to_project_id !== op.args.from_project_id) {
      const to = await membershipState(ctx, taskId(op), String(op.args.to_project_id));
      state.to_member = Boolean(to);
      state.to_section_id = to?.section_id ?? null;
    }
    return state;
  },
  async verify(ctx, _ws, op, opts) {
    await taskInProjectNow(ctx, taskId(op), opts.undoing && op.args.to_project_id !== op.args.from_project_id ? String(op.args.to_project_id) : String(op.args.from_project_id));
  },
  async apply(ctx, _op, a) {
    const task = String(a.task_id);
    const from = String(a.from_project_id);
    const to = String(a.to_project_id);
    const section = (a.section_id as string | null) ?? null;
    if (to === from) await moveTask(ctx, task, from, section);
    else {
      await addTaskToProject(ctx, task, to);
      if (section) await moveTask(ctx, task, to, section);
      await removeTaskFromProject(ctx, task, from);
    }
    return null;
  },
  async undo(ctx, op, before) {
    const task = taskId(op);
    const from = String(op.args.from_project_id);
    const to = String(op.args.to_project_id);
    const section = (before.section_id as string | null) ?? null;
    const order = typeof before.sort_order === "number" ? before.sort_order : undefined;
    if (to === from) await moveTask(ctx, task, from, section, order);
    else {
      await addTaskToProject(ctx, task, from);
      await moveTask(ctx, task, from, section, order);
      await removeTaskFromProject(ctx, task, to);
    }
  },
};

const addToProjectTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "add_task_to_project", input, what);
    if (t.parentId) refuse(`${what}: a subtask lives in its parent’s projects`);
    const to = await projectArg(env, input.project, what);
    allowedIn(env, "add_task_to_project", to.id, what);
    if (to.id === t.projectId) refuse(`${what}: “${t.title}” is already in “${to.name}”`);
    return staged("add_task_to_project", t.projectId, `Also show “${t.title}” in “${to.name}”`, "—", `in “${to.name}” too`, { task_id: t.id, project_id: to.id }, { projects: [t.projectId, to.id] });
  },
  async read(ctx, op) {
    return { member: Boolean(await membershipState(ctx, taskId(op), String(op.args.project_id))) };
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await addTaskToProject(ctx, String(a.task_id), String(a.project_id));
    return null;
  },
  async undo(ctx, op, before) {
    if (!before.member) await removeTaskFromProject(ctx, taskId(op), String(op.args.project_id));
  },
};

const removeFromProjectTool: Handler = {
  async stage(env, input, what) {
    const t = await existingTask(env, input.task, what);
    const from = await projectArg(env, input.project, what);
    allowedIn(env, "remove_task_from_project", from.id, what);
    const memberships = rows(await env.ctx.db.from("task_projects").select("project_id").eq("task_id", t.id).is("deleted_at", null), "task projects");
    if (!memberships.some((m) => m.project_id === from.id)) refuse(`${what}: “${t.title}” isn’t in “${from.name}”`);
    if (memberships.length < 2) refuse(`${what}: “${from.name}” is “${t.title}”’s only project (delete the task instead)`);
    return staged("remove_task_from_project", from.id, `Remove “${t.title}” from “${from.name}”`, `in “${from.name}”`, "not in it any more (stays in its other projects)", { task_id: t.id, project_id: from.id });
  },
  async read(ctx, op) {
    const m = await membershipState(ctx, taskId(op), String(op.args.project_id));
    return { member: Boolean(m), section_id: m?.section_id ?? null, sort_order: m?.sort_order ?? null };
  },
  async apply(ctx, _op, a) {
    await removeTaskFromProject(ctx, String(a.task_id), String(a.project_id));
    return null;
  },
  async undo(ctx, op, before) {
    await addTaskToProject(ctx, taskId(op), String(op.args.project_id));
    await moveTask(ctx, taskId(op), String(op.args.project_id), (before.section_id as string | null) ?? null, typeof before.sort_order === "number" ? before.sort_order : undefined);
  },
};

const assignTaskTool: Handler = {
  async stage(env, input, what) {
    const { t, p } = await editableTask(env, "assign_task", input, what);
    const assignee = personArg(env, input.person, what, { among: p.memberIds, allowNone: true, amongLabel: `a member of “${p.name}”` });
    if (assignee === t.assigneeId) refuse(`${what}: “${t.title}” is already assigned to ${personName(env, assignee)}`);
    return staged("assign_task", t.projectId, `Assign “${t.title}”`, personName(env, t.assigneeId), personName(env, assignee), { task_id: t.id, assignee_id: assignee });
  },
  read: readTaskKeys("assignee_id"),
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await updateTask(ctx, String(a.task_id), { assigneeId: (a.assignee_id as string | null) ?? null });
    return null;
  },
  async undo(ctx, op, before) {
    await updateTask(ctx, taskId(op), { assigneeId: (before.assignee_id as string | null) ?? null });
  },
};

const setDatesTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "set_dates", input, what);
    const due = dateArg(input.due, what);
    const start = t.kind === "milestone" ? KEEP : dateArg(input.start, what);
    const dueOn = due === KEEP ? t.dueOn : due;
    const startOn = start === KEEP ? t.startOn : start;
    if (dueOn && startOn && startOn > dueOn) refuse(`${what}: the start date must be on or before the due date`);
    if (dueOn === t.dueOn && startOn === t.startOn) refuse(`${what}: the dates are already so`);
    return staged("set_dates", t.projectId, `Dates of “${t.title}”`, showDates(t.startOn, t.dueOn), showDates(startOn, dueOn), { task_id: t.id, due_on: dueOn, start_on: startOn });
  },
  read: readTaskKeys("due_on", "start_on"),
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await updateTask(ctx, String(a.task_id), { dueOn: (a.due_on as string | null) ?? null, startOn: (a.start_on as string | null) ?? null });
    return null;
  },
  async undo(ctx, op, before) {
    await updateTask(ctx, taskId(op), { dueOn: (before.due_on as string | null) ?? null, startOn: (before.start_on as string | null) ?? null });
  },
};

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const setRecurrenceTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "set_recurrence", input, what);
    const current = (await readTaskKeys("recurrence")(env.ctx, { args: { task_id: t.id } } as unknown as StagedOp)).recurrence ?? null;
    const freq = clean(input.frequency);
    let rule: Recurrence | null = null;
    if (freq !== "never") {
      if (!["daily", "weekly", "monthly", "yearly"].includes(freq)) refuse(`${what}: how often (daily, weekly, monthly, yearly, or never)`);
      const interval = typeof input.interval === "number" && Number.isInteger(input.interval) && input.interval >= 1 && input.interval <= 365 ? input.interval : 1;
      const weekdays = freq === "weekly" && Array.isArray(input.weekdays) ? [...new Set(input.weekdays.map((d) => WEEKDAYS.indexOf(lower(clean(d)).slice(0, 3))).filter((d) => d >= 0))] : [];
      const until = clean(input.until);
      if (until && !isRealDate(until)) refuse(`${what}: “until” is a date (YYYY-MM-DD)`);
      rule = { freq: freq as Recurrence["freq"], interval, weekdays, ends: until ? { type: "until", until } : { type: "never" } };
    }
    const before = parseRecurrence(current as Json);
    if (!rule && !before) refuse(`${what}: “${t.title}” doesn’t repeat`);
    return staged("set_recurrence", t.projectId, `Repeat “${t.title}”`, before ? describeRecurrence(before) : "Doesn’t repeat", rule ? describeRecurrence(rule) : "Doesn’t repeat", { task_id: t.id, recurrence: rule ? recurrenceJson(rule) : null });
  },
  read: readTaskKeys("recurrence"),
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await setTaskRecurrence(ctx, String(a.task_id), a.recurrence ? parseRecurrence(a.recurrence) : null);
    return null;
  },
  async undo(ctx, op, before) {
    await setTaskRecurrence(ctx, taskId(op), before.recurrence ? parseRecurrence(before.recurrence) : null);
  },
};

// Never a blocked task (notes 155 / 163): the same count the automations' check uses; the database's
// dependency guard refuses the write again. An approval task only by its approvers.
async function verifyCompletable(ctx: ApiContext, task: string) {
  const t = maybe(await ctx.db.from("tasks").select("kind").eq("id", task).maybeSingle(), "task");
  if (t?.kind === "approval") throw invalid("Only its approvers complete an approval task");
  const n = parseBlockerCounts((await ctx.db.rpc("open_blocker_counts", { task_ids: [task] })).data ?? null).get(task) ?? 0;
  if (n > 0) throw invalid(`Not completed: ${blockedCompletionReason(n).replace("this automation", "this change")}`);
}

function completeStage(done: boolean): Handler["stage"] {
  return async (env, input, what) => {
    const { t } = await editableTask(env, done ? "complete_task" : "reopen_task", input, what);
    if (t.completed === done) refuse(`${what}: “${t.title}” is already ${done ? "complete" : "open"}`);
    if (done) {
      if (t.openBlockers > 0) refuse(`${what}: not completed — ${blockedCompletionReason(t.openBlockers).replace("this automation", "this change")}`);
      if (t.kind === "approval") refuse(`${what}: only its approvers complete an approval task`);
      if (t.recurring) refuse(`${what}: “${t.title}” repeats; complete it yourself so its next one is made`);
    }
    return staged(done ? "complete_task" : "reopen_task", t.projectId, `${done ? "Complete" : "Reopen"} “${t.title}”`, t.completed ? "Complete" : "Open", done ? "Complete" : "Open", { task_id: t.id });
  };
}
const completeTool = (done: boolean): Handler => ({
  stage: completeStage(done),
  read: readTaskKeys("completed"),
  async verify(ctx, ws, op, opts) {
    await verifyTask(ctx, ws, op, opts);
    // Completing (or undoing a reopen, which completes again): the blocked / approval checks.
    if (done !== opts.undoing) await verifyCompletable(ctx, taskId(op));
  },
  async apply(ctx, _op, a) {
    await setTaskCompleted(ctx, String(a.task_id), done);
    return null;
  },
  async undo(ctx, op, before) {
    await setTaskCompleted(ctx, taskId(op), Boolean(before.completed));
  },
});

const deleteTaskTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "delete_task", input, what);
    const direct = rows(await env.ctx.db.from("tasks").select("id").eq(t.parentId ? "parent_task_id" : "root_task_id", t.id).is("deleted_at", null).limit(1000), "subtasks").length;
    return staged("delete_task", t.projectId, `Delete “${t.title}”${direct ? ` and its ${direct} subtask${direct === 1 ? "" : "s"}` : ""}`, t.title, "In the Trash (Undo brings it back)", { task_id: t.id }, { count: 1 + direct });
  },
  read: readTaskKeys("deleted"),
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await deleteTask(ctx, String(a.task_id));
    return null;
  },
  async undo(ctx, op) {
    await restoreTask(ctx, taskId(op));
  },
};

const restoreTaskTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "restore_task", input, what, "task", { deleted: true });
    const row = await taskRow(env.ctx, t.id);
    if (!row?.deleted_at) refuse(`${what}: “${t.title}” isn’t in the Trash`);
    return staged("restore_task", t.projectId, `Restore “${t.title}”`, "In the Trash", "Back in its projects", { task_id: t.id });
  },
  read: readTaskKeys("deleted"),
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await restoreTask(ctx, String(a.task_id));
    return null;
  },
  async undo(ctx, op) {
    await deleteTask(ctx, taskId(op));
  },
};

const convertToSubtaskTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "convert_to_subtask", input, what);
    const parent = await existingTask(env, input.parent, what);
    allowedIn(env, "convert_to_subtask", parent.projectId, what);
    if (parent.id === t.id) refuse(`${what}: a task can’t be its own parent`);
    if (t.parentId) refuse(`${what}: “${t.title}” is already a subtask`);
    return staged("convert_to_subtask", t.projectId, `Make “${t.title}” a subtask`, "a task", `a subtask of “${parent.title}”`, { task_id: t.id, parent_id: parent.id, project_id: t.projectId, section_id: t.sectionId }, { projects: [...new Set([t.projectId, parent.projectId])] });
  },
  read: readTaskKeys("parent"),
  async apply(ctx, _op, a) {
    await convertToSubtask(ctx, String(a.task_id), String(a.parent_id));
    return null;
  },
  async undo(ctx, op) {
    await convertToTask(ctx, taskId(op), String(op.args.project_id), (op.args.section_id as string | null) ?? null);
  },
};

const convertToTaskTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "convert_to_task", input, what);
    if (!t.parentId) refuse(`${what}: “${t.title}” is already a task`);
    const p = clean(input.project) ? await projectArg(env, input.project, what) : env.context.projects.find((x) => x.id === t.projectId)!;
    allowedIn(env, "convert_to_task", p.id, what);
    const s = clean(input.section) ? sectionArg(env, input.section, p.id, what) : null;
    if (s && "index" in s) refuse(`${what}: pick a section that exists`);
    return staged("convert_to_task", t.projectId, `Make “${t.title}” a task`, "a subtask", `a task in “${p.name}”${s && !("index" in s) ? ` · ${s.name}` : ""}`, { task_id: t.id, parent_id: t.parentId, project_id: p.id, section_id: s && !("index" in s) ? s.id : null }, { projects: [...new Set([t.projectId, p.id])] });
  },
  read: readTaskKeys("parent"),
  async apply(ctx, _op, a) {
    await convertToTask(ctx, String(a.task_id), String(a.project_id), (a.section_id as string | null) ?? null);
    return null;
  },
  async undo(ctx, op) {
    await convertToSubtask(ctx, taskId(op), String(op.args.parent_id));
  },
};

// ---- Approvals ---------------------------------------------------------------------------------------

async function approvalSetup(ctx: ApiContext, task: string): Promise<OpState> {
  const approvers = rows(await ctx.db.from("task_approvers").select("profile_id").eq("task_id", task).is("deleted_at", null).order("created_at"), "approvers").map((a) => lower(a.profile_id));
  const settings = maybe(await ctx.db.from("task_approval_settings").select("mode, due_on").eq("task_id", task).maybeSingle(), "approval settings");
  return { approvers, mode: (settings?.mode as string | undefined) ?? "any", approval_due: (settings?.due_on as string | null | undefined) ?? null };
}

// Approvers: people of the project (the database refuses anyone below Commenter, as by hand).
function approverIds(env: ToolEnv, raw: unknown, members: string[], projectName: string, what: string): string[] {
  const list = Array.isArray(raw) ? raw : clean(raw) ? [raw] : [];
  if (!list.length || list.length > 10) refuse(`${what}: name 1–10 approvers`);
  return [...new Set(list.map((v) => personArg(env, v, what, { among: members, amongLabel: `a member of “${projectName}”` })!))];
}

const setTaskTypeTool: Handler = {
  async stage(env, input, what) {
    const { t, p } = await editableTask(env, "set_task_type", input, what);
    const kind = clean(input.kind);
    if (!["task", "milestone", "approval"].includes(kind)) refuse(`${what}: the type is task, milestone, or approval`);
    const hasApprovers = Array.isArray(input.approvers) ? input.approvers.length > 0 : Boolean(clean(input.approvers));
    if (hasApprovers && kind !== "approval") refuse(`${what}: approvers only go with an approval task`);
    if (kind === t.kind && !hasApprovers) refuse(`${what}: “${t.title}” is already ${kind === "approval" ? "an approval" : `a ${kind}`}`);
    const approvers = hasApprovers ? approverIds(env, input.approvers, p.memberIds, p.name, what) : null;
    const mode = clean(input.mode) === "all" ? "all" : "any";
    const label = (k: string) => (k === "approval" ? "Approval" : k === "milestone" ? "Milestone" : "Task");
    const after = approvers ? `${label(kind)} · approvers ${approvers.map((a) => personName(env, a)).join(", ")} (${mode === "all" ? "everyone must approve" : "any one can approve"})` : label(kind);
    const extra = kind === "milestone" && t.startOn ? " (its start date is cleared)" : "";
    return staged("set_task_type", t.projectId, `Type of “${t.title}”`, label(t.kind), `${after}${extra}`, { task_id: t.id, kind, approvers: approvers ?? null, mode });
  },
  async read(ctx, op) {
    const base = await readTaskKeys("kind", "start_on")(ctx, op);
    return op.args.approvers ? { ...base, ...(await approvalSetup(ctx, taskId(op))) } : base;
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    const task = String(a.task_id);
    if (a.kind) await setTaskKind(ctx, task, a.kind as "task");
    if (Array.isArray(a.approvers)) await setTaskApprovers(ctx, task, { approverIds: a.approvers as string[], mode: a.mode === "all" ? "all" : "any", dueOn: null });
    return null;
  },
  async undo(ctx, op, before) {
    const task = taskId(op);
    if (Array.isArray(op.args.approvers) && before.kind === "approval") {
      await setTaskApprovers(ctx, task, { approverIds: (before.approvers as string[]) ?? [], mode: before.mode === "all" ? "all" : "any", dueOn: (before.approval_due as string | null) ?? null });
    }
    if (before.kind !== op.args.kind) await setTaskKind(ctx, task, before.kind as "task");
    if (before.start_on && op.args.kind === "milestone") await updateTask(ctx, task, { startOn: before.start_on as string });
  },
};

const setApproversTool: Handler = {
  async stage(env, input, what) {
    const { t, p } = await editableTask(env, "set_approvers", input, what);
    const pending = await env.ctx.db.from("approval_rounds").select("id").eq("task_id", t.id).eq("status", "pending").limit(1);
    const staging = env.staged.some((s) => s.op === "set_task_type" && s.args.task_id === t.id && s.args.kind === "approval");
    if (t.kind !== "approval" && !staging) refuse(`${what}: “${t.title}” isn’t an approval task (set its type to approval first)`);
    if ((pending.data?.length ?? 0) > 0 && !(p.role === "owner" || p.role === "admin")) refuse(`${what}: a round is pending; only Owners and Admins change who approves now`);
    const approvers = approverIds(env, input.approvers, p.memberIds, p.name, what);
    const mode = clean(input.mode) === "all" ? "all" : "any";
    const due = dateArg(input.due, what);
    const current = await approvalSetup(env.ctx, t.id);
    const show = (ids: string[], m: string) => `${ids.length ? ids.map((x) => personName(env, x)).join(", ") : "nobody"} (${m === "all" ? "everyone must approve" : "any one can approve"})`;
    return staged("set_approvers", t.projectId, `Approvers of “${t.title}”`, show((current.approvers as string[]) ?? [], String(current.mode)), show(approvers, mode), {
      task_id: t.id, approvers, mode, approval_due: due === KEEP ? ((current.approval_due as string | null) ?? null) : due,
    });
  },
  async read(ctx, op) {
    return approvalSetup(ctx, taskId(op));
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await setTaskApprovers(ctx, String(a.task_id), { approverIds: a.approvers as string[], mode: a.mode === "all" ? "all" : "any", dueOn: (a.approval_due as string | null) ?? null });
    return null;
  },
  async undo(ctx, op, before) {
    await setTaskApprovers(ctx, taskId(op), { approverIds: (before.approvers as string[]) ?? [], mode: before.mode === "all" ? "all" : "any", dueOn: (before.approval_due as string | null) ?? null });
  },
};

async function followUpState(ctx: ApiContext, task: string): Promise<OpState> {
  const s = maybe(await ctx.db.from("task_approval_settings").select("after_approval, after_section_id, reminders").eq("task_id", task).maybeSingle(), "approval settings");
  return { after: (s?.after_approval as string | undefined) ?? "complete", section_id: (s?.after_section_id as string | null | undefined) ?? null, reminders: s?.reminders !== false };
}

const followUpTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "set_approval_follow_up", input, what);
    if (t.kind !== "approval") refuse(`${what}: “${t.title}” isn’t an approval task`);
    const after = clean(input.after);
    if (!["complete", "move_section", "notify"].includes(after)) refuse(`${what}: complete, move_section, or notify`);
    const s = after === "move_section" ? sectionArg(env, input.section, t.projectId, what) : null;
    if (s && "index" in s) refuse(`${what}: pick a section that exists`);
    const reminders = typeof input.reminders === "boolean" ? input.reminders : true;
    const cur = await followUpState(env.ctx, t.id);
    const say = (a: string, sec: string | null) => (a === "move_section" ? `move to ${env.context.projects.flatMap((p) => p.sections).find((x) => x.id === sec)?.name ?? "a section"}` : a === "notify" ? "just notify" : "complete the task");
    return staged("set_approval_follow_up", t.projectId, `After approval of “${t.title}”`, say(String(cur.after), cur.section_id as string | null), say(after, s && !("index" in s) ? s.id : null), {
      task_id: t.id, after, section_id: s && !("index" in s) ? s.id : null, reminders,
    });
  },
  async read(ctx, op) {
    return followUpState(ctx, taskId(op));
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await setApprovalFollowUp(ctx, String(a.task_id), { followUp: a.after as "complete", sectionId: (a.section_id as string | null) ?? null, reminders: Boolean(a.reminders) });
    return null;
  },
  async undo(ctx, op, before) {
    await setApprovalFollowUp(ctx, taskId(op), { followUp: before.after as "complete", sectionId: (before.section_id as string | null) ?? null, reminders: Boolean(before.reminders) });
  },
};

const sendForApprovalTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "send_for_approval", input, what);
    if (t.kind !== "approval") refuse(`${what}: “${t.title}” isn’t an approval task`);
    const setup = await approvalSetup(env.ctx, t.id);
    const approvers = (setup.approvers as string[]) ?? [];
    if (approvalSetupUnfinished(approvers.length)) refuse(`${what}: ${APPROVAL_SETUP_UNFINISHED} — “${t.title}” has no approvers yet (set_approvers first)`);
    const follow = await followUpState(env.ctx, t.id);
    if (follow.after === "move_section" && !follow.section_id) refuse(`${what}: “${t.title}” is set to move after approval, but no section is chosen (set_approval_follow_up)`);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const files: string[] = [];
    for (const f of Array.isArray(input.files) ? input.files : []) files.push((await refArg(env, "attachment", f, what)).id);
    if (!text && !files.length) refuse(`${what}: add the final text or a file`);
    const who = approvers.map((a) => personName(env, a)).join(", ");
    const afterBit = follow.after === "move_section" ? "then move to a section" : follow.after === "notify" ? "then just notify" : "then complete the task";
    return staged("send_for_approval", t.projectId, `Send “${t.title}” for approval`, "Not sent", `Pending with ${who} (${afterBit})`, { task_id: t.id, text, files }, { notifies: `${who} (an approval request in their Inbox and email)` });
  },
  async read(ctx, op) {
    const r = maybe(await ctx.db.from("approval_rounds").select("id, status").eq("task_id", taskId(op)).order("created_at", { ascending: false }).limit(1).maybeSingle(), "round");
    return { round: r?.id ?? null, status: r?.status ?? null };
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    const follow = await followUpState(ctx, String(a.task_id));
    const after = follow.after === "move_section" || follow.after === "notify" ? follow.after : "complete";
    const res = await sendForApproval(ctx, String(a.task_id), {
      finalText: String(a.text ?? ""),
      attachmentIds: (a.files as string[]) ?? [],
      moreSteps: after !== "complete",
      afterApproval: after,
      moveSectionId: after === "move_section" ? ((follow.section_id as string | null) ?? null) : null,
    });
    return res.roundId ?? null;
  },
  async undo(ctx, op) {
    await withdrawApproval(ctx, taskId(op));
  },
};

function simpleApprovalTask(tool: "withdraw_approval" | "acknowledge_approval", label: string, fn: (ctx: ApiContext, task: string) => Promise<void>): Handler {
  return {
    async stage(env, input, what) {
      const { t } = await editableTask(env, tool, input, what);
      if (t.kind !== "approval") refuse(`${what}: “${t.title}” isn’t an approval task`);
      return staged(tool, t.projectId, `${label} “${t.title}”`, "—", label, { task_id: t.id });
    },
    verify: verifyTask,
    async apply(ctx, _op, a) {
      await fn(ctx, String(a.task_id));
      return null;
    },
  };
}

const handOffTool: Handler = {
  async stage(env, input, what) {
    const { t, p } = await editableTask(env, "hand_off_approval", input, what);
    if (t.kind !== "approval") refuse(`${what}: “${t.title}” isn’t an approval task`);
    const to = personArg(env, input.person, what, { among: p.memberIds, amongLabel: `a member of “${p.name}”` })!;
    const note = clean(input.note).slice(0, 2000);
    return staged("hand_off_approval", t.projectId, `Hand off your approval of “${t.title}”`, personName(env, env.me), personName(env, to), { task_id: t.id, person: to, note }, { notifies: `${personName(env, to)} (Inbox)` });
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await handOffApproval(ctx, String(a.task_id), String(a.person), String(a.note ?? ""));
    return null;
  },
};

const requestApprovalTool: Handler = {
  async stage(env, input, what) {
    const { t, p } = await editableTask(env, "request_approval", input, what);
    const approver = personArg(env, input.approver, what, { among: p.memberIds, amongLabel: `a member of “${p.name}”` })!;
    const note = clean(input.note).slice(0, 2000);
    return staged("request_approval", t.projectId, `Ask ${personName(env, approver)} to approve “${t.title}”`, "—", "Pending (an approval subtask)", { task_id: t.id, approver, note }, { notifies: `${personName(env, approver)} (an approval request)` });
  },
  async read(ctx, op) {
    const r = maybe(await ctx.db.from("approval_requests").select("id, status").eq("task_id", taskId(op)).eq("approver_id", String(op.args.approver)).order("created_at", { ascending: false }).limit(1).maybeSingle(), "approval");
    return { request: r?.id ?? null, status: r?.status ?? null };
  },
  verify: verifyTask,
  async apply(ctx, op, a) {
    await requestApproval(ctx, String(a.task_id), { approverId: String(a.approver), note: String(a.note ?? "") || undefined });
    const r = await requestApprovalTool.read!(ctx, op, null);
    return (r.request as string | null) ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await cancelApproval(ctx, created);
  },
};

async function approvalArg(env: ToolEnv, value: unknown, what: string) {
  const ref = await refArg(env, "approval", value, what, async (id) => {
    const r = maybe(await env.ctx.db.from("approval_requests").select("id").eq("id", id).maybeSingle(), "approval");
    return r ? "an approval request" : null;
  });
  const r = maybe(await env.ctx.db.from("approval_requests").select("id, task_id, status").eq("id", ref.id).maybeSingle(), "approval");
  if (!r) refuse(`${what}: that approval request isn’t available`);
  const tasks = await loadTasksFor(env, r!.task_id);
  return { request: r!, task: tasks };
}
async function loadTasksFor(env: ToolEnv, id: string) {
  const [t] = await loadTasks(env, [id]);
  return t ?? refuse("That task isn’t in a project you can change here");
}

const cancelApprovalTool: Handler = {
  async stage(env, input, what) {
    const { request, task } = await approvalArg(env, input.approval, what);
    allowedIn(env, "cancel_approval", task.projectId, what);
    if (!["pending", "changes_requested"].includes(request.status)) refuse(`${what}: that request isn’t open`);
    return staged("cancel_approval", task.projectId, `Cancel the approval request on “${task.title}”`, request.status.replace(/_/g, " "), "cancelled", { task_id: task.id, approval_id: request.id });
  },
  async apply(ctx, _op, a) {
    await cancelApproval(ctx, String(a.approval_id));
    return null;
  },
};

const resubmitApprovalTool: Handler = {
  async stage(env, input, what) {
    const { request, task } = await approvalArg(env, input.approval, what);
    allowedIn(env, "resubmit_approval", task.projectId, what);
    if (request.status !== "changes_requested") refuse(`${what}: only a request with changes requested is resubmitted`);
    return staged("resubmit_approval", task.projectId, `Resubmit the approval request on “${task.title}”`, "changes requested", "pending", { task_id: task.id, approval_id: request.id, note: clean(input.note).slice(0, 2000) }, { notifies: "the approver (an approval request)" });
  },
  async apply(ctx, _op, a) {
    await resubmitApproval(ctx, String(a.approval_id), String(a.note ?? "") || undefined);
    return null;
  },
};

// ---- Collaboration -----------------------------------------------------------------------------------

const addCommentTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "add_comment", input, what);
    const body = typeof input.text === "string" ? input.text.trim() : "";
    if (!body || body.length > 5000) refuse(`${what}: a comment is 1–5,000 characters`);
    return staged("add_comment", t.projectId, `Comment on “${t.title}”`, "—", body.slice(0, 300), { task_id: t.id, body }, { notifies: "the task’s followers and anyone @mentioned" });
  },
  async read(ctx, _op, created) {
    if (!created) return {};
    const c = maybe(await ctx.db.from("comments").select("body, deleted_at, edited_at").eq("id", created).maybeSingle(), "comment");
    return c ? { body: c.body, deleted: Boolean(c.deleted_at) } : { missing: true };
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    const res = await addComment(ctx, String(a.task_id), String(a.body));
    return res.commentId ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteComment(ctx, created);
  },
};

async function commentArg(env: ToolEnv, value: unknown, what: string, own: boolean) {
  const ref = await refArg(env, "comment", value, what, async (id) => {
    const c = maybe(await env.ctx.db.from("comments").select("id").eq("id", id).maybeSingle(), "comment");
    return c ? "a comment" : null;
  });
  const c = maybe(await env.ctx.db.from("comments").select("id, task_id, author_id, body, pinned_at, deleted_at, email_direction").eq("id", ref.id).maybeSingle(), "comment");
  if (!c || c.deleted_at) refuse(`${what}: that comment isn’t available`);
  if (own && lower(String(c!.author_id ?? "")) !== env.me) refuse(`${what}: only your own comments`);
  const task = await loadTasksFor(env, c!.task_id);
  return { c: c!, task };
}

async function readComment(ctx: ApiContext, op: StagedOp): Promise<OpState> {
  const c = maybe(await ctx.db.from("comments").select("body, pinned_at, deleted_at").eq("id", String(op.args.comment_id)).maybeSingle(), "comment");
  return c ? { body: c.body, pinned: Boolean(c.pinned_at), deleted: Boolean(c.deleted_at) } : { missing: true };
}

const editCommentTool: Handler = {
  async stage(env, input, what) {
    const { c, task } = await commentArg(env, input.comment, what, true);
    allowedIn(env, "edit_comment", task.projectId, what);
    if (c.email_direction) refuse(`${what}: an emailed comment can’t be edited`);
    const body = typeof input.text === "string" ? input.text.trim() : "";
    if (!body || body.length > 5000) refuse(`${what}: a comment is 1–5,000 characters`);
    return staged("edit_comment", task.projectId, `Edit your comment on “${task.title}”`, String(c.body).slice(0, 200), body.slice(0, 200), { comment_id: c.id, task_id: task.id, body });
  },
  read: readComment,
  async apply(ctx, _op, a) {
    await editComment(ctx, String(a.comment_id), String(a.body));
    return null;
  },
  async undo(ctx, op, before) {
    await editComment(ctx, String(op.args.comment_id), String(before.body ?? ""));
  },
};

const deleteCommentTool: Handler = {
  async stage(env, input, what) {
    const { c, task } = await commentArg(env, input.comment, what, true);
    allowedIn(env, "delete_comment", task.projectId, what);
    return staged("delete_comment", task.projectId, `Delete your comment on “${task.title}”`, String(c.body).slice(0, 200), "Deleted (can’t be undone)", { comment_id: c.id, task_id: task.id });
  },
  read: readComment,
  async apply(ctx, _op, a) {
    await deleteComment(ctx, String(a.comment_id));
    return null;
  },
};

const pinCommentTool: Handler = {
  async stage(env, input, what) {
    const { c, task } = await commentArg(env, input.comment, what, false);
    allowedIn(env, "pin_comment", task.projectId, what);
    const pinned = input.pinned !== false;
    if (Boolean(c.pinned_at) === pinned) refuse(`${what}: it’s already ${pinned ? "pinned" : "not pinned"}`);
    return staged("pin_comment", task.projectId, `${pinned ? "Pin" : "Unpin"} a comment on “${task.title}”`, c.pinned_at ? "Pinned" : "Not pinned", pinned ? "Pinned" : "Not pinned", { comment_id: c.id, task_id: task.id, pinned });
  },
  read: readComment,
  async apply(ctx, _op, a) {
    await setCommentPinned(ctx, String(a.comment_id), Boolean(a.pinned));
    return null;
  },
  async undo(ctx, op, before) {
    await setCommentPinned(ctx, String(op.args.comment_id), Boolean(before.pinned));
  },
};

async function myReaction(ctx: ApiContext, comment: string, me: string, emoji: string) {
  const r = maybe(await ctx.db.from("comment_reactions").select("id").eq("comment_id", comment).eq("profile_id", me).eq("emoji", emoji).is("deleted_at", null).maybeSingle(), "reaction");
  return Boolean(r);
}
const reactTool: Handler = {
  async stage(env, input, what) {
    const { c, task } = await commentArg(env, input.comment, what, false);
    allowedIn(env, "react_to_comment", task.projectId, what);
    const emoji = clean(input.emoji);
    const has = await myReaction(env.ctx, c.id, env.me, emoji);
    return staged("react_to_comment", task.projectId, `Your ${emoji.replace(/_/g, " ")} on a comment of “${task.title}”`, has ? "on" : "off", has ? "off" : "on", { comment_id: c.id, task_id: task.id, emoji, me: env.me });
  },
  async read(ctx, op) {
    return { on: await myReaction(ctx, String(op.args.comment_id), String(op.args.me), String(op.args.emoji)) };
  },
  async apply(ctx, _op, a) {
    await toggleReaction(ctx, String(a.comment_id), String(a.emoji));
    return null;
  },
  async undo(ctx, op) {
    await toggleReaction(ctx, String(op.args.comment_id), String(op.args.emoji));
  },
};

async function following(ctx: ApiContext, task: string, person: string) {
  return Boolean(maybe(await ctx.db.from("task_followers").select("profile_id").eq("task_id", task).eq("profile_id", person).is("deleted_at", null).maybeSingle(), "follower"));
}
const followTool: Handler = {
  async stage(env, input, what) {
    const { t, p } = await editableTask(env, "follow_task", input, what);
    const person = clean(input.person) ? personArg(env, input.person, what, { among: p.memberIds, amongLabel: `a member of “${p.name}”` })! : env.me;
    const on = input.following !== false;
    if (!on && person !== env.me && !(p.role === "owner" || p.role === "admin" || p.role === "editor")) refuse(`${what}: removing someone else as a follower needs Editor`);
    const now = await following(env.ctx, t.id, person);
    if (now === on) refuse(`${what}: ${personName(env, person)} ${on ? "already follows" : "doesn’t follow"} “${t.title}”`);
    return staged("follow_task", t.projectId, `${personName(env, person)} ${on ? "follows" : "stops following"} “${t.title}”`, now ? "Following" : "Not following", on ? "Following" : "Not following", { task_id: t.id, person, following: on });
  },
  async read(ctx, op) {
    return { following: await following(ctx, taskId(op), String(op.args.person)) };
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await setFollowing(ctx, String(a.task_id), String(a.person), Boolean(a.following));
    return null;
  },
  async undo(ctx, op, before) {
    await setFollowing(ctx, taskId(op), String(op.args.person), Boolean(before.following));
  },
};

async function tagByName(env: ToolEnv, name: string) {
  return maybe(await env.ctx.db.from("tags").select("id, name, archived_at").eq("workspace_id", env.workspaceId).ilike("name", name.replace(/[%_\\]/g, "\\$&")).is("deleted_at", null).limit(1).maybeSingle(), "tag");
}
async function tagged(ctx: ApiContext, task: string, tag: string | null) {
  if (!tag) return false;
  return Boolean(maybe(await ctx.db.from("task_tags").select("tag_id").eq("task_id", task).eq("tag_id", tag).is("deleted_at", null).maybeSingle(), "task tag"));
}

const addTagTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "add_tag", input, what);
    const name = clean(input.tag);
    if (!name || name.length > 50) refuse(`${what}: a tag name is 1–50 characters`);
    const tag = await tagByName(env, name);
    if (tag?.archived_at) refuse(`${what}: the tag “${tag.name}” is archived`);
    if (tag && (await tagged(env.ctx, t.id, tag.id))) refuse(`${what}: “${t.title}” already has “${tag.name}”`);
    return staged("add_tag", t.projectId, `Tag “${t.title}”`, "—", tag ? tag.name : `${name} (a new tag)`, { task_id: t.id, tag_id: tag?.id ?? null, name });
  },
  async read(ctx, op) {
    return { tagged: await tagged(ctx, taskId(op), (op.args.tag_id as string | null) ?? null) };
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    if (a.tag_id) await addTaskTag(ctx, String(a.task_id), String(a.tag_id));
    else await addNewTaskTag(ctx, String(a.task_id), String(a.name));
    return null;
  },
  async undo(ctx, op) {
    let tag = (op.args.tag_id as string | null) ?? null;
    if (!tag) {
      const t = maybe(await ctx.db.from("tags").select("id").ilike("name", String(op.args.name)).is("deleted_at", null).limit(1).maybeSingle(), "tag");
      tag = t?.id ?? null;
    }
    if (tag) await removeTaskTag(ctx, taskId(op), tag);
  },
};

const removeTagTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "remove_tag", input, what);
    const tag = await tagByName(env, clean(input.tag));
    if (!tag || !(await tagged(env.ctx, t.id, tag.id))) refuse(`${what}: “${t.title}” has no tag “${clean(input.tag)}”`);
    return staged("remove_tag", t.projectId, `Untag “${t.title}”`, tag!.name, "—", { task_id: t.id, tag_id: tag!.id });
  },
  async read(ctx, op) {
    return { tagged: await tagged(ctx, taskId(op), String(op.args.tag_id)) };
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await removeTaskTag(ctx, String(a.task_id), String(a.tag_id));
    return null;
  },
  async undo(ctx, op) {
    await addTaskTag(ctx, taskId(op), String(op.args.tag_id));
  },
};

const createTagTool: Handler = {
  async stage(env, input, what) {
    const name = clean(input.name);
    if (!name || name.length > 50) refuse(`${what}: a tag name is 1–50 characters`);
    if (await tagByName(env, name)) refuse(`${what}: a tag “${name}” already exists`);
    const color = clean(input.color) || "zinc";
    return staged("create_tag", null, "New tag", "—", name, { name, color });
  },
  async apply(ctx, _op, a) {
    const res = await createTag(ctx, String(a.name), String(a.color));
    return res.tagId ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) {
      await updateTag(ctx, created, { archived: true });
    }
  },
};

async function linkOf(ctx: ApiContext, predecessor: string, successor: string) {
  return maybe(await ctx.db.from("task_dependencies").select("id, kind, lag_days").eq("predecessor_id", predecessor).eq("successor_id", successor).is("deleted_at", null).maybeSingle(), "dependency");
}

const addDependencyTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "add_dependency", input, what);
    const pre = await existingTask(env, input.blocked_by, what);
    allowedIn(env, "add_dependency", pre.projectId, what);
    if (pre.id === t.id) refuse(`${what}: a task can’t wait on itself`);
    const kind = clean(input.kind) || "finish_to_start";
    const lag = typeof input.lag_days === "number" && Number.isInteger(input.lag_days) ? input.lag_days : 0;
    if (await linkOf(env.ctx, pre.id, t.id)) refuse(`${what}: “${t.title}” already waits on “${pre.title}”`);
    return staged("add_dependency", t.projectId, `“${t.title}” waits on “${pre.title}”`, "—", `${kind.replace(/_/g, " → ").replace(" → to → ", " → ")}${lag ? `, lag ${lag} days` : ""}`, { task_id: t.id, predecessor_id: pre.id, kind, lag }, { projects: [...new Set([t.projectId, pre.projectId])] });
  },
  async read(ctx, op) {
    const l = await linkOf(ctx, String(op.args.predecessor_id), taskId(op));
    return { link: l?.id ?? null };
  },
  async apply(ctx, _op, a) {
    await setTaskDependency(ctx, String(a.predecessor_id), String(a.task_id), a.kind as "finish_to_start", Number(a.lag ?? 0));
    const l = await linkOf(ctx, String(a.predecessor_id), String(a.task_id));
    return l?.id ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await removeTaskDependency(ctx, created);
  },
};

const removeDependencyTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "remove_dependency", input, what);
    const pre = await existingTask(env, input.blocked_by, what);
    allowedIn(env, "remove_dependency", pre.projectId, what);
    const link = await linkOf(env.ctx, pre.id, t.id);
    if (!link) refuse(`${what}: “${t.title}” doesn’t wait on “${pre.title}”`);
    return staged("remove_dependency", t.projectId, `“${t.title}” stops waiting on “${pre.title}”`, "waits on it", "—", { task_id: t.id, predecessor_id: pre.id, dependency_id: link!.id, kind: link!.kind, lag: link!.lag_days }, { projects: [...new Set([t.projectId, pre.projectId])] });
  },
  async read(ctx, op) {
    const l = await linkOf(ctx, String(op.args.predecessor_id), taskId(op));
    return { link: l ? true : false };
  },
  async apply(ctx, _op, a) {
    await removeTaskDependency(ctx, String(a.dependency_id));
    return null;
  },
  async undo(ctx, op) {
    await setTaskDependency(ctx, String(op.args.predecessor_id), taskId(op), op.args.kind as "finish_to_start", Number(op.args.lag ?? 0));
  },
};

// Dates with their dependents: the plan (preview_dependency_shift) is the preview; Undo puts every moved
// task's dates back through ordinary task edits.
const shiftTool: Handler = {
  async stage(env, input, what) {
    const { t } = await editableTask(env, "shift_with_dependents", input, what);
    const due = dateArg(input.due, what);
    const start = dateArg(input.start, what);
    const dueOn = due === KEEP ? t.dueOn : due;
    const startOn = start === KEEP ? t.startOn : start;
    if (dueOn && startOn && startOn > dueOn) refuse(`${what}: the start date must be on or before the due date`);
    const plan = await previewDependencyShift(env.ctx, t.id, { startOn, dueOn });
    const moves = plan.filter((r) => r.status === "move");
    const skipped = plan.filter((r) => r.status !== "move");
    const after = `${showDates(startOn, dueOn)}${moves.length ? `; moves ${moves.map((m) => `“${m.title}” (+${m.shiftDays}d)`).join(", ")}` : "; nothing else moves"}${skipped.length ? `; won’t move ${skipped.length}` : ""}`;
    return staged("shift_with_dependents", t.projectId, `Dates of “${t.title}” and what waits on it`, showDates(t.startOn, t.dueOn), after, { task_id: t.id, due_on: dueOn, start_on: startOn, dependents: moves.map((m) => m.taskId) }, { count: 1 + moves.length });
  },
  async read(ctx, op) {
    const ids = [taskId(op), ...strs(op.args, "dependents")];
    const list = rows(await ctx.db.from("tasks").select("id, due_on, start_on").in("id", ids), "tasks");
    return { dates: Object.fromEntries(list.map((r) => [r.id, [r.start_on, r.due_on]])) as Json };
  },
  verify: verifyTask,
  async apply(ctx, _op, a) {
    await applyDependencyShift(ctx, String(a.task_id), { startOn: (a.start_on as string | null) ?? null, dueOn: (a.due_on as string | null) ?? null }, strs(a, "dependents"));
    return null;
  },
  async undo(ctx, _op, before) {
    const dates = (before.dates ?? {}) as Record<string, [string | null, string | null]>;
    for (const [id, [start, due]] of Object.entries(dates)) await updateTask(ctx, id, { startOn: start, dueOn: due });
  },
};

const deleteAttachmentTool: Handler = {
  async stage(env, input, what) {
    const a = await refArg(env, "attachment", input.attachment, what, async (id) => {
      const r = maybe(await env.ctx.db.from("task_attachments").select("file_name").eq("id", id).is("deleted_at", null).maybeSingle(), "file");
      return r ? String(r.file_name) : null;
    });
    const row = maybe(await env.ctx.db.from("task_attachments").select("task_id, file_name").eq("id", a.id).is("deleted_at", null).maybeSingle(), "file");
    if (!row) refuse(`${what}: that file isn’t available`);
    const task = await loadTasksFor(env, row!.task_id);
    allowedIn(env, "delete_attachment", task.projectId, what);
    return staged("delete_attachment", task.projectId, `Remove “${row!.file_name}” from “${task.title}”`, String(row!.file_name), "Removed (can’t be undone)", { attachment_id: a.id, task_id: task.id });
  },
  async apply(ctx, _op, a) {
    await deleteAttachment(ctx, String(a.attachment_id));
    return null;
  },
};

// Bulk: one change on up to 50 tasks, staged as one change per task (each checked and undone on its own).
const BULK_TOOL: Record<string, string> = { complete: "complete_task", reopen: "reopen_task", delete: "delete_task", assign: "assign_task", set_due: "set_dates", move_section: "move_task", add_tag: "add_tag", remove_tag: "remove_tag" };
export function bulkEditTool(handlers: () => Record<string, Handler>): Handler {
  return {
    async stage(env, input, what) {
      const list = Array.isArray(input.tasks) ? input.tasks : [];
      if (!list.length || list.length > 50) refuse(`${what}: name 1–50 tasks`);
      const tool = BULK_TOOL[clean(input.action)] ?? refuse(`${what}: that bulk change isn’t one of ${Object.keys(BULK_TOOL).join(", ")}`);
      const out: StagedOp[] = [];
      const reasons: string[] = [];
      for (const [i, ref] of list.entries()) {
        const sub: Record<string, unknown> = { task: ref, person: input.person, due: input.due, section: input.section, tag: input.tag };
        try {
          const op = await handlers()[tool].stage(env, sub, `${what}, task ${i + 1}`);
          for (const o of Array.isArray(op) ? op : [op]) out.push(o);
        } catch (error) {
          if (error instanceof ToolRefusal) reasons.push(error.message);
          else throw error;
        }
      }
      if (!out.length) refuse(reasons[0] ?? `${what}: nothing to change`);
      if (out.length > BIG_CHANGE_ITEMS) for (const o of out) o.destructive = true;
      return out;
    },
    async apply() {
      throw new ApiError("failed", "A bulk change is applied task by task");
    },
  };
}

export const TASK_HANDLERS: Record<string, Handler> = {
  create_task: createTaskTool,
  create_subtask: createSubtaskTool,
  duplicate_task: duplicateTaskTool,
  rename_task: renameTaskTool,
  set_description: setDescriptionTool,
  move_task: moveTaskTool,
  add_task_to_project: addToProjectTool,
  remove_task_from_project: removeFromProjectTool,
  assign_task: assignTaskTool,
  set_dates: setDatesTool,
  set_recurrence: setRecurrenceTool,
  complete_task: completeTool(true),
  reopen_task: completeTool(false),
  delete_task: deleteTaskTool,
  restore_task: restoreTaskTool,
  convert_to_subtask: convertToSubtaskTool,
  convert_to_task: convertToTaskTool,
  set_task_type: setTaskTypeTool,
  set_approvers: setApproversTool,
  set_approval_follow_up: followUpTool,
  send_for_approval: sendForApprovalTool,
  withdraw_approval: simpleApprovalTask("withdraw_approval", "Withdraw the approval round of", withdrawApproval),
  acknowledge_approval: simpleApprovalTask("acknowledge_approval", "Mark the feedback received on", acknowledgeApproval),
  hand_off_approval: handOffTool,
  request_approval: requestApprovalTool,
  cancel_approval: cancelApprovalTool,
  resubmit_approval: resubmitApprovalTool,
  add_comment: addCommentTool,
  edit_comment: editCommentTool,
  delete_comment: deleteCommentTool,
  pin_comment: pinCommentTool,
  react_to_comment: reactTool,
  follow_task: followTool,
  add_tag: addTagTool,
  remove_tag: removeTagTool,
  create_tag: createTagTool,
  add_dependency: addDependencyTool,
  remove_dependency: removeDependencyTool,
  shift_with_dependents: shiftTool,
  delete_attachment: deleteAttachmentTool,
};
