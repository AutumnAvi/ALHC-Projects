"use client";

import Link from "next/link";
import { CheckCircle2, Circle, Plus, X } from "lucide-react";
import { useTaskHref } from "@/components/project/shared";
import { useServerAction } from "@/components/toast";
import { addTaskDependency, removeTaskDependency } from "@/lib/actions";
import type { TaskDependency, TaskDetail } from "@/lib/data";
import { hasRole } from "@/lib/roles";

// Finish-to-start dependencies. "Blocked by": tasks that must be completed before this one can be.
// "Blocking": tasks waiting on this one. Editors can add and remove links within a shared project.
export function TaskDependencies({ task }: { task: TaskDetail }) {
  const canEdit = hasRole(task.viewerRole, "editor");
  const blockedBy = task.dependencies.filter((d) => d.relation === "blocked_by");
  const blocking = task.dependencies.filter((d) => d.relation === "blocking");
  if (!canEdit && task.dependencies.length === 0) return null;

  const linked = new Set(task.dependencies.map((d) => d.taskId));
  const candidates = task.dependencyCandidates
    .map((group) => ({ ...group, tasks: group.tasks.filter((t) => !linked.has(t.id)) }))
    .filter((group) => group.tasks.length > 0);

  return (
    <section className="mt-6" aria-labelledby="dependencies-heading">
      <h3 id="dependencies-heading" className="text-sm font-medium text-zinc-900">
        Dependencies
      </h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <DependencyList
          id="blocked-by"
          title="Blocked by"
          empty="Nothing — this task can be completed any time."
          items={blockedBy}
          canEdit={canEdit}
          candidates={candidates}
          addLabel="Add a task this waits on…"
          onAdd={(otherId) => addTaskDependency(otherId, task.id)}
        />
        <DependencyList
          id="blocking"
          title="Blocking"
          empty="No tasks are waiting on this one."
          items={blocking}
          canEdit={canEdit}
          candidates={candidates}
          addLabel="Add a task waiting on this…"
          onAdd={(otherId) => addTaskDependency(task.id, otherId)}
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
}: {
  id: string;
  title: string;
  empty: string;
  items: TaskDependency[];
  canEdit: boolean;
  candidates: TaskDetail["dependencyCandidates"];
  addLabel: string;
  onAdd: (otherId: string) => Promise<{ error?: string }>;
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
          <li key={item.id} className="group flex items-center gap-2 px-3 py-1.5 text-sm">
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
              className="min-w-0 flex-1 rounded border border-transparent bg-transparent py-0.5 text-xs text-zinc-500 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
            >
              <option value="">{addLabel}</option>
              {candidates.map((group) => (
                <optgroup key={group.projectId} label={group.projectName}>
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
