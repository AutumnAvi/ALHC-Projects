// Nov 1 notes, batch 10 (77): live automation feedback. The person's own recent runs (rule_runs.actor_id,
// read with their own client through RLS) become a quiet "Automation X ran on N tasks" note per
// automation, and a warning for each run loop protection (or a limit, or an error) stopped. Pure, so it
// is unit-tested; the route is app/api/rule-feedback and the toasts are components/rules/rule-feedback.tsx.

export type FeedbackRun = {
  id: string;
  ruleId: string;
  ruleName: string;
  projectId: string;
  taskId: string | null;
  // Null when the person can't read the task (never named then).
  taskTitle: string | null;
  status: "succeeded" | "scheduled" | "skipped" | "failed";
  // skipped: loop | depth_limit | throttled | rate_limited; failed: the error.
  reason: string | null;
  createdAt: string;
  // Nov 3 notes (batch 18, 138): the type of the first step that changed something (move_section,
  // add_comment, …), so the note can say what it did: "Automation X moved 3 tasks". Null = unknown.
  action?: string | null;
};

export type FeedbackResponse = { cursor: string; runs: FeedbackRun[] };

export type RanNote = {
  kind: "ran";
  ruleId: string;
  ruleName: string;
  projectId: string;
  taskCount: number;
  // Set when it ran on one task the person can read.
  taskId: string | null;
  taskTitle: string | null;
  // What it did (the first changing step of its runs), when every run did the same.
  action?: string | null;
};

export type StopKind = "loop" | "depth_limit" | "throttled" | "rate_limited" | "failed";

export type StopNote = {
  kind: "stopped";
  stop: StopKind;
  ruleId: string;
  ruleName: string;
  projectId: string;
  taskId: string | null;
  taskTitle: string | null;
  detail: string | null;
};

export type FeedbackNote = RanNote | StopNote;

// Skipped runs worth telling someone about (other skips aren't logged at all).
export const STOP_REASONS: readonly StopKind[] = ["loop", "depth_limit", "throttled", "rate_limited"];

// How far back the first check looks when there is no cursor yet: since the change started, plus slack.
export const FEEDBACK_SLACK_SECONDS = 5;
// Later checks re-read this much before the cursor (a long transaction's runs carry its start time) and
// drop ids already shown.
export const FEEDBACK_OVERLAP_SECONDS = 30;

export function feedbackNotes(runs: readonly FeedbackRun[]): FeedbackNote[] {
  const ran = new Map<
    string,
    { run: FeedbackRun; tasks: Set<string>; readable: FeedbackRun | null; nullTasks: number; actions: Set<string> }
  >();
  const stops: StopNote[] = [];
  const seenStop = new Set<string>();
  const ordered = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const run of ordered) {
    if (run.status === "succeeded" || run.status === "scheduled") {
      const entry = ran.get(run.ruleId) ?? { run, tasks: new Set<string>(), readable: null, nullTasks: 0, actions: new Set<string>() };
      entry.actions.add(run.action ?? "");
      if (run.taskId) entry.tasks.add(run.taskId);
      else entry.nullTasks += 1;
      if (run.taskId && run.taskTitle && !entry.readable) entry.readable = run;
      ran.set(run.ruleId, entry);
      continue;
    }
    const stop: StopKind | null =
      run.status === "failed" ? "failed" : STOP_REASONS.includes(run.reason as StopKind) ? (run.reason as StopKind) : null;
    if (!stop) continue;
    // One warning per automation, kind, and task.
    const key = `${run.ruleId}:${stop}:${run.taskId ?? ""}`;
    if (seenStop.has(key)) continue;
    seenStop.add(key);
    stops.push({
      kind: "stopped",
      stop,
      ruleId: run.ruleId,
      ruleName: run.ruleName,
      projectId: run.projectId,
      taskId: run.taskTitle ? run.taskId : null,
      taskTitle: run.taskTitle,
      detail: stop === "failed" ? run.reason : null,
    });
  }
  const notes: FeedbackNote[] = [...ran.values()].map(({ run, tasks, readable, nullTasks, actions }) => {
    const taskCount = tasks.size + nullTasks;
    const only = actions.size === 1 ? [...actions][0] : "";
    return {
      action: only || null,
      kind: "ran",
      ruleId: run.ruleId,
      ruleName: run.ruleName,
      projectId: run.projectId,
      taskCount,
      taskId: taskCount === 1 && readable ? readable.taskId : null,
      taskTitle: taskCount === 1 && readable ? readable.taskTitle : null,
    };
  });
  return [...notes, ...stops];
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// What an automation's first changing step did, as a verb phrase around the task(s) (Nov 3 notes,
// batch 18, 138): [before, after] — "moved" 3 tasks, "added a comment to" “Flyer”.
const ACTION_VERBS: Record<string, [string, string]> = {
  move_section: ["moved", ""],
  set_field: ["set a field on", ""],
  set_assignee: ["assigned", ""],
  add_followers: ["added followers to", ""],
  remove_followers: ["removed followers from", ""],
  add_comment: ["commented on", ""],
  notify: ["sent a notification about", ""],
  send_email: ["sent an email about", ""],
  request_approval: ["requested approval on", ""],
  send_slack: ["posted to Slack about", ""],
  call_webhook: ["called a webhook for", ""],
  delay: ["is waiting on", ""],
  complete_task: ["completed", ""],
  reopen_task: ["reopened", ""],
  set_title: ["renamed", ""],
  create_subtasks: ["added subtasks to", ""],
  apply_task_template: ["applied a template to", ""],
  add_to_project: ["added", "to another project"],
  set_due_date: ["set the due date of", ""],
  set_start_date: ["set the start date of", ""],
  add_tag: ["tagged", ""],
  remove_tag: ["removed a tag from", ""],
  create_task: ["created a task from", ""],
  move_to_project: ["moved", "to another project"],
  remove_from_project: ["removed", "from this project"],
  set_task_type: ["changed the type of", ""],
  set_description: ["updated the description of", ""],
  convert_to_project: ["converted", "to a project"],
};

// The quiet note's text: "Automation “Triage” moved 3 tasks", else "… ran on 3 tasks".
export function ranText(note: RanNote): string {
  const [verb, after] = (note.action && ACTION_VERBS[note.action]) || ["ran on", ""];
  const what = note.taskTitle ? `“${note.taskTitle}”` : plural(note.taskCount, "task");
  return `Automation “${note.ruleName}” ${verb} ${what}${after ? ` ${after}` : ""}`;
}

// The first step of a run's log that changed something (done / queued / scheduled), else null.
export function firstChangingAction(detail: unknown): string | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const actions = (detail as Record<string, unknown>).actions;
  if (!Array.isArray(actions)) return null;
  for (const step of actions) {
    if (!step || typeof step !== "object") continue;
    const { type, outcome } = step as Record<string, unknown>;
    if (typeof type !== "string") continue;
    if (outcome === undefined || outcome === "done" || outcome === "queued" || outcome === "scheduled") return type;
  }
  return null;
}

export const STOP_HEADING: Record<StopKind, string> = {
  loop: "Loop protection stopped an automation",
  depth_limit: "Loop protection stopped a long chain of automations",
  throttled: "An automation was paused for this task",
  rate_limited: "An automation hit its hourly limit",
  failed: "An automation failed",
};

export const STOP_EXPLAIN: Record<StopKind, string> = {
  loop: "Another automation changed the task back, so running it again would repeat forever.",
  depth_limit: "Automations started by automations stop after ten in a row.",
  throttled: "It already ran 20 times on this task in the last hour.",
  rate_limited: "It already ran 1,000 times in the last hour.",
  failed: "It stopped partway; nothing it did in this run was kept.",
};

// The warning's text (also its accessible name).
export function stopText(note: StopNote): string {
  const on = note.taskTitle ? ` on “${note.taskTitle}”` : "";
  const detail = note.detail ? ` ${note.detail}` : "";
  return `${STOP_HEADING[note.stop]}: “${note.ruleName}”${on}. ${STOP_EXPLAIN[note.stop]}${detail}`;
}

// Where the warning's links go.
export function automationHref(projectId: string, ruleId: string, back?: string) {
  return `/projects/${projectId}/rules/${ruleId}${back ? `?back=${encodeURIComponent(back)}` : ""}`;
}

export function feedbackTaskHref(projectId: string, taskId: string) {
  return `/projects/${projectId}?task=${taskId}`;
}

// Where the next check starts reading: the cursor minus the overlap, else the change's start.
export function feedbackSince(cursor: string | null, startedAt: number, now: number): { since?: string; within?: number } {
  if (cursor) return { since: cursor };
  return { within: Math.min(600, Math.ceil((now - startedAt) / 1000) + FEEDBACK_SLACK_SECONDS) };
}

// Nov 3 notes (batch 19, 141): the runs a feedback check reported, for the running indicator's list
// ("Ran" / "Failed"). Loop-protection and limit stops stay toasts only.
export function finishedRunsFromNotes(notes: readonly FeedbackNote[]): {
  ruleId: string;
  ruleName: string;
  projectId: string;
  tasks: { id: string; title: string | null }[];
  taskCount: number;
  failed: boolean;
  detail: string | null;
}[] {
  const out: ReturnType<typeof finishedRunsFromNotes> = [];
  for (const note of notes) {
    const tasks = note.taskId ? [{ id: note.taskId, title: note.taskTitle }] : [];
    if (note.kind === "ran") {
      out.push({ ruleId: note.ruleId, ruleName: note.ruleName, projectId: note.projectId, tasks, taskCount: note.taskCount, failed: false, detail: ranText(note) });
    } else if (note.stop === "failed") {
      out.push({ ruleId: note.ruleId, ruleName: note.ruleName, projectId: note.projectId, tasks, taskCount: tasks.length, failed: true, detail: note.detail });
    }
  }
  return out;
}
