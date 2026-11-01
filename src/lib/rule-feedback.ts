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
  const ran = new Map<string, { run: FeedbackRun; tasks: Set<string>; readable: FeedbackRun | null; nullTasks: number }>();
  const stops: StopNote[] = [];
  const seenStop = new Set<string>();
  const ordered = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const run of ordered) {
    if (run.status === "succeeded" || run.status === "scheduled") {
      const entry = ran.get(run.ruleId) ?? { run, tasks: new Set<string>(), readable: null, nullTasks: 0 };
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
  const notes: FeedbackNote[] = [...ran.values()].map(({ run, tasks, readable, nullTasks }) => {
    const taskCount = tasks.size + nullTasks;
    return {
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

// The quiet note's text.
export function ranText(note: RanNote): string {
  if (note.taskTitle) return `Automation “${note.ruleName}” ran on “${note.taskTitle}”`;
  return `Automation “${note.ruleName}” ran on ${plural(note.taskCount, "task")}`;
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
