"use client";

import Link from "next/link";
import { CheckCircle2, Circle, EyeOff, Plus, X } from "lucide-react";
import { useTaskHref } from "@/components/project/shared";
import { useServerAction } from "@/components/toast";
import { removeTaskDependency, setTaskDependency } from "@/lib/actions";
import { slackLabel } from "@/lib/critical-path";
import { DEPENDENCY_KINDS, MAX_LAG_DAYS, dependencyLabel, isDependencyKind, type DependencyKind } from "@/lib/dependencies";
import type { TaskDependency, TaskDetail } from "@/lib/data";
import { hasRole } from "@/lib/roles";

// "Blocked by": tasks this one comes after. "Blocking": tasks that come after this one. Each link is
// finish-to-start (the later task starts on/after the earlier one's due date + lag, and can't be completed
// before it) or start-to-start (starts on/after the earlier one's start + lag; never blocks completion).
// Editors of both tasks add, change, and remove links — across projects and between subtasks too.
export function TaskDependencies({ task }: { task: TaskDetail }) {
  const canEdit = hasRole(task.viewerRole, "editor");
  const blockedBy = task.dependencies.filter((d) => d.relation === "blocked_by");
  const blocking = task.dependencies.filter((d) => d.relation === "blocking");
  if (!canEdit && task.dependencies.length === 0 && task.schedule.length === 0 && task.hiddenBlockers === 0) return null;
  const multiProject = task.schedule.length > 1;

  const linked = new Set(task.dependencies.map((d) => d.taskId));
  const candidates = task.dependencyCandidates
    .map((group) => ({ ...group, tasks: group.tasks.filter((t) => !linked.has(t.id)) }))
    .filter((group) => group.tasks.length > 0);

  return (
    <section className="mt-6" aria-labelledby="dependencies-heading">
      <h3 id="dependencies-heading" className="text-sm font-semibold text-zinc-900">
        Dependencies
      </h3>
      {task.schedule.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-xs text-zinc-600" aria-label="Schedule">
          {task.schedule.map((s) => (
            <li key={s.projectId}>
              <span className={s.critical ? "font-medium text-zinc-900" : undefined}>{slackLabel(s)}</span>
              {multiProject ? <span className="text-zinc-400"> · {s.projectName}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {task.hiddenBlockers > 0 ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-600">
          <EyeOff className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
          Also waiting on {task.hiddenBlockers === 1 ? "1 task" : `${task.hiddenBlockers} tasks`} you can’t open; it can’t be
          completed until {task.hiddenBlockers === 1 ? "that one is" : "they are"}.
        </p>
      ) : null}
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <DependencyList
          id="blocked-by"
          title="Blocked by"
          empty="Nothing — this task can be completed any time."
          items={blockedBy}
          canEdit={canEdit}
          candidates={candidates}
          addLabel="Add a task this waits on…"
          onAdd={(otherId) => setTaskDependency(otherId, task.id)}
          onChange={(item, kind, lag) => setTaskDependency(item.taskId, task.id, kind, lag)}
        />
        <DependencyList
          id="blocking"
          title="Blocking"
          empty="No tasks are waiting on this one."
          items={blocking}
          canEdit={canEdit}
          candidates={candidates}
          addLabel="Add a task waiting on this…"
          onAdd={(otherId) => setTaskDependency(task.id, otherId)}
          onChange={(item, kind, lag) => setTaskDependency(task.id, item.taskId, kind, lag)}
        />
      </div>
    </section>
  );
}

function DependencyList({
  id,
  title,
  empty,
  items,
  canEdit,
  candidates,
  addLabel,
  onAdd,
  onChange,
}: {
  id: string;
  title: string;
  empty: string;
  items: TaskDependency[];
  canEdit: boolean;
  candidates: TaskDetail["dependencyCandidates"];
  addLabel: string;
  onAdd: (otherId: string) => Promise<{ error?: string }>;
  onChange: (item: TaskDependency, kind: DependencyKind, lagDays: number) => Promise<{ error?: string }>;
}) {
  const [pending, run] = useServerAction();
  const taskHref = useTaskHref();

  return (
    <div className="rounded-md border border-zinc-200">
      <h4 id={`${id}-heading`} className="border-b border-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-600">
        {title}
        {items.length ? <span className="ml-1.5 tabular-nums text-zinc-400">{items.length}</span> : null}
      </h4>
      <ul aria-labelledby={`${id}-heading`} className="divide-y divide-zinc-100">
        {items.map((item) => (
          <li key={item.id} className="group px-3 py-1.5 text-sm">
            <div className="flex items-center gap-2">
              {item.completedAt ? (
                <CheckCircle2 className="size-4 shrink-0 text-accent-600" aria-label="Completed" />
              ) : (
                <Circle className="size-4 shrink-0 text-zinc-400" aria-label="Incomplete" />
              )}
              <Link
                href={taskHref(item.taskId)}
                scroll={false}
                className={`min-w-0 flex-1 truncate hover:underline ${
                  item.completedAt ? "text-zinc-400 line-through" : "text-zinc-800"
                }`}
              >
                {item.title}
              </Link>
              {item.isSubtask ? <span className="chip shrink-0">Subtask</span> : null}
              {canEdit ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => removeTaskDependency(item.id))}
                  aria-label={`Remove dependency on ${item.title}`}
                  title="Remove dependency"
                  className="rounded p-1 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
            {canEdit ? (
              <LinkSettings item={item} pending={pending} onChange={(kind, lag) => run(() => onChange(item, kind, lag))} />
            ) : (
              <p className="ml-6 text-xs text-zinc-500">{dependencyLabel(item.kind, item.lagDays)}</p>
            )}
          </li>
        ))}
        {items.length === 0 ? <li className="px-3 py-1.5 text-xs text-zinc-500">{empty}</li> : null}
        {canEdit && candidates.length > 0 ? (
          <li className="flex items-center gap-1.5 px-3 py-1.5">
            <Plus className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
            <label className="sr-only" htmlFor={`${id}-add`}>
              {addLabel}
            </label>
            <select
              id={`${id}-add`}
              value=""
              disabled={pending}
              onChange={(e) => {
                const otherId = e.target.value;
                if (otherId) run(() => onAdd(otherId));
              }}
              className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent py-0.5 text-xs text-zinc-500 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
            >
              <option value="">{addLabel}</option>
              {candidates.map((group) => (
                <optgroup key={group.key} label={group.label}>
                  {group.tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

// Kind and lag of one link (Editors). The lag commits on blur / Enter.
function LinkSettings({
  item,
  pending,
  onChange,
}: {
  item: TaskDependency;
  pending: boolean;
  onChange: (kind: DependencyKind, lagDays: number) => void;
}) {
  return (
    <div className="ml-6 mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
      <label className="sr-only" htmlFor={`dep-kind-${item.id}`}>
        Dependency type for {item.title}
      </label>
      <select
        id={`dep-kind-${item.id}`}
        value={item.kind}
        disabled={pending}
        onChange={(e) => {
          const kind = e.currentTarget.value;
          if (isDependencyKind(kind)) onChange(kind, item.lagDays);
        }}
        className="rounded-md border border-transparent bg-transparent py-0.5 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
      >
        {DEPENDENCY_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      <label htmlFor={`dep-lag-${item.id}`}>Lag</label>
      <input
        id={`dep-lag-${item.id}`}
        type="number"
        step={1}
        min={-MAX_LAG_DAYS}
        max={MAX_LAG_DAYS}
        key={`${item.id}-${item.lagDays}`}
        defaultValue={item.lagDays}
        disabled={pending}
        title="Days between the two tasks (negative = overlap)"
        onBlur={(e) => {
          const input = e.currentTarget;
          const lag = Number(input.value);
          if (!Number.isInteger(lag) || Math.abs(lag) > MAX_LAG_DAYS) {
            input.value = String(item.lagDays);
            return;
          }
          if (lag !== item.lagDays) onChange(item.kind, lag);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-14 rounded-md border border-zinc-200 bg-transparent px-1 py-0.5 tabular-nums focus:border-zinc-300 focus:outline-none"
      />
      <span aria-hidden>days</span>
    </div>
  );
}
