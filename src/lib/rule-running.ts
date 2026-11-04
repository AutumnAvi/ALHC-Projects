// Nov 3 notes (batch 19, 141): long-running automations. Automations run inside the write that starts them
// (the database runs them in the same transaction), so "running" is honest only for what the browser is
// waiting on:
//   - an automation the person runs by hand (the task's "Run an automation…", the bulk bar's "Run
//     automation"): its name and target task(s) are known up front;
//   - any other write that is still saving after a moment ("Saving your change"): the automations it starts
//     run with it, and their names arrive with the feedback check right after (rule-feedback.tsx).
// The indicator (bottom left) appears once something has been running for LONG_MS, counts what's running,
// and lists each entry with "Running…" until it's done, then "Ran" (or "Failed"). Pure rules here; the store
// below is a tiny external store for useSyncExternalStore.

// "partial": it finished but an action was skipped; "skipped": it didn't run at all (loop protection, a
// limit). Nov 4 notes, batch 24 (157).
export type RunningStatus = "running" | "ran" | "partial" | "skipped" | "failed";

export type RunningTask = { id: string; title: string | null };

export type RunningEntry = {
  key: string;
  // "automation": a known automation (a manual run, or a run the feedback check reported);
  // "write": a change still saving, whose automations aren't known yet.
  kind: "automation" | "write";
  ruleId: string | null;
  ruleName: string | null;
  projectId: string | null;
  tasks: RunningTask[];
  // How many tasks it runs on (a bulk run), when more than the titles listed.
  taskCount: number;
  status: RunningStatus;
  startedAt: number;
  endedAt: number | null;
  // What it did, or why it failed (one line).
  detail: string | null;
};

// Shown once something has been running this long (quick ones never flash the indicator).
export const LONG_MS = 700;
// A finished long run stays in the indicator this long ("Ran"), then the indicator goes.
export const LINGER_MS = 5000;
// The list keeps this many finished entries.
export const HISTORY = 8;
// A run the feedback check reports within this long of a manual run of the same automation is that run.
export const DEDUPE_MS = 15_000;

export function isLong(entry: RunningEntry, now: number): boolean {
  return (entry.endedAt ?? now) - entry.startedAt >= LONG_MS;
}

export function runningCount(entries: readonly RunningEntry[]): number {
  return entries.filter((e) => e.status === "running").length;
}

// Whether the indicator shows: something long is running, or a long one finished a moment ago.
export function indicatorVisible(entries: readonly RunningEntry[], lingerUntil: number, now: number): boolean {
  if (entries.some((e) => e.status === "running" && isLong(e, now))) return true;
  return now < lingerUntil;
}

// When the indicator next needs a look (a running entry crossing LONG_MS, the linger running out).
export function nextTick(entries: readonly RunningEntry[], lingerUntil: number, now: number): number | null {
  const times: number[] = [];
  for (const e of entries) if (e.status === "running" && !isLong(e, now)) times.push(e.startedAt + LONG_MS);
  if (lingerUntil > now) times.push(lingerUntil);
  return times.length ? Math.min(...times) - now : null;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// The pill's text.
export function indicatorLabel(entries: readonly RunningEntry[]): string {
  const running = entries.filter((e) => e.status === "running");
  const automations = running.filter((e) => e.kind === "automation");
  if (automations.length) return `Running ${plural(automations.length, "automation")}…`;
  if (running.length) return "Saving… automations may be running";
  const failed = entries.some((e) => e.status === "failed");
  const partial = entries.filter((e) => e.kind === "automation" && e.status === "partial").length;
  const ran = entries.filter((e) => e.kind === "automation" && e.status === "ran").length;
  if (failed) return "An automation failed";
  if (partial) return partial === 1 ? "An automation partly ran" : `${plural(partial, "automation")} partly ran`;
  if (entries.some((e) => e.kind === "automation" && e.status === "skipped")) return "An automation was skipped";
  return ran ? `Ran ${plural(ran, "automation")}` : "Saved";
}

// One entry's lines in the list.
export function entryTitle(entry: RunningEntry): string {
  if (entry.kind === "write") return "Your change";
  return `Automation “${entry.ruleName ?? "Automation"}”`;
}

export function entryTarget(entry: RunningEntry): string | null {
  const titled = entry.tasks.filter((t) => t.title);
  if (entry.taskCount > 1) return `on ${plural(entry.taskCount, "task")}`;
  if (titled.length === 1) return `on “${titled[0].title}”`;
  return null;
}

export function entryStatus(entry: RunningEntry): string {
  if (entry.status === "running") return entry.kind === "write" ? "Saving…" : "Running…";
  if (entry.status === "failed") return "Failed";
  if (entry.status === "partial") return "Partly ran";
  if (entry.status === "skipped") return "Skipped";
  return entry.kind === "write" ? "Saved" : "Ran";
}

// Whether an entry needs a look (the pill and its row go amber).
export function entryNeedsAttention(entry: RunningEntry): boolean {
  return entry.status === "failed" || entry.status === "partial" || entry.status === "skipped";
}

// Keeps running entries and the newest HISTORY finished ones, newest first.
export function trimEntries(entries: readonly RunningEntry[]): RunningEntry[] {
  const running = entries.filter((e) => e.status === "running");
  const done = entries
    .filter((e) => e.status !== "running")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, HISTORY);
  return [...running.sort((a, b) => b.startedAt - a.startedAt), ...done];
}

// ---------------------------------------------------------------------------------------------------
// The store

type State = { entries: RunningEntry[]; lingerUntil: number };
let state: State = { entries: [], lingerUntil: 0 };
const listeners = new Set<() => void>();
let seq = 0;

function set(next: State) {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeRunning(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function runningState(): State {
  return state;
}

export function startRunning(
  entry: Pick<RunningEntry, "kind" | "ruleId" | "ruleName" | "projectId" | "tasks"> & { taskCount?: number },
  now = Date.now(),
): string {
  const key = `run-${++seq}`;
  set({
    ...state,
    entries: trimEntries([
      ...state.entries,
      {
        key,
        kind: entry.kind,
        ruleId: entry.ruleId,
        ruleName: entry.ruleName,
        projectId: entry.projectId,
        tasks: entry.tasks,
        taskCount: entry.taskCount ?? entry.tasks.length,
        status: "running",
        startedAt: now,
        endedAt: null,
        detail: null,
      },
    ]),
  });
  return key;
}

export function finishRunning(key: string, status: Exclude<RunningStatus, "running">, detail: string | null = null, now = Date.now()) {
  const entry = state.entries.find((e) => e.key === key);
  if (!entry || entry.status !== "running") return;
  const done: RunningEntry = { ...entry, status, detail, endedAt: now };
  // A write that finished quickly was never shown: drop it instead of listing "Saved".
  const keep = done.kind === "automation" || isLong(done, now);
  set({
    entries: trimEntries(state.entries.flatMap((e) => (e.key === key ? (keep ? [done] : []) : [e]))),
    lingerUntil: isLong(done, now) ? Math.max(state.lingerUntil, now + LINGER_MS) : state.lingerUntil,
  });
}

// Runs the feedback check reported (the automations a write started): listed as "Ran" / "Failed". They keep
// the indicator up a little longer only when it's showing already (a long write just ended).
export type FinishedRun = {
  ruleId: string;
  ruleName: string;
  projectId: string;
  tasks: RunningTask[];
  taskCount: number;
  failed: boolean;
  partial?: boolean;
  detail: string | null;
};

export function noteFinishedRuns(runs: readonly FinishedRun[], now = Date.now()) {
  // A manual run already listed itself (finishRunning): its feedback isn't listed twice.
  const fresh = runs.filter(
    (r) => !state.entries.some((e) => e.kind === "automation" && e.ruleId === r.ruleId && e.endedAt !== null && now - e.endedAt < DEDUPE_MS),
  );
  if (fresh.length === 0) return;
  const added: RunningEntry[] = fresh.map((r) => ({
    key: `run-${++seq}`,
    kind: "automation",
    ruleId: r.ruleId,
    ruleName: r.ruleName,
    projectId: r.projectId,
    tasks: r.tasks,
    taskCount: r.taskCount,
    status: r.failed ? "failed" : r.partial ? "partial" : "ran",
    startedAt: now,
    endedAt: now,
    detail: r.detail,
  }));
  set({
    entries: trimEntries([...state.entries, ...added]),
    lingerUntil: now < state.lingerUntil ? now + LINGER_MS : state.lingerUntil,
  });
}

// A write that took long ended (optimistic-session): "Your change · Saved" stays up for a moment, and the
// automations it started join it when the feedback check reports them. Not for a manual run's own write
// (that run lists itself).
export function noteWriteEnded(startedAt: number, now = Date.now()) {
  if (now - startedAt < LONG_MS) return;
  const manual = state.entries.some((e) => e.kind === "automation" && e.startedAt >= startedAt - 2000 && e.startedAt <= now);
  if (manual) return;
  set({
    entries: trimEntries([
      ...state.entries,
      {
        key: `run-${++seq}`,
        kind: "write",
        ruleId: null,
        ruleName: null,
        projectId: null,
        tasks: [],
        taskCount: 0,
        status: "ran",
        startedAt,
        endedAt: now,
        detail: null,
      },
    ]),
    lingerUntil: Math.max(state.lingerUntil, now + LINGER_MS),
  });
}

// For tests.
export function resetRunning() {
  set({ entries: [], lingerUntil: 0 });
}
