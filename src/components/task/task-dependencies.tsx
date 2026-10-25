"use client";

import { useState } from "react";
import { CheckCircle2, Circle, EyeOff, MoreHorizontal, Plus, Search, Trash2 } from "lucide-react";
import { Popover } from "@/components/popover";
import { Segmented } from "@/components/project/view-chrome";
import { SmartPicker } from "@/components/smart-picker";
import { useServerAction } from "@/components/toast";
import { removeTaskDependency, setTaskDependency } from "@/lib/actions";
import { slackLabel } from "@/lib/critical-path";
import { DEPENDENCY_KINDS, MAX_LAG_DAYS, dependencyLabel, isDependencyKind, type DependencyKind } from "@/lib/dependencies";
import type { TaskDependency, TaskDetail } from "@/lib/data";
import { useTaskExtras } from "./task-pane-store";
import { TaskLink } from "@/components/task/task-link";
import { seedFromTitle } from "@/lib/task-seed";

type Relation = TaskDependency["relation"];
const RELATION_LABELS: Record<Relation, string> = { blocked_by: "Blocked by", blocking: "Blocking" };

// A dated top-level task has slack in each of its projects (project_critical_path).
function hasSchedule(task: TaskDetail) {
  return Boolean(task.dueOn) && !task.isSubtask;
}

// Whether the pane shows a Dependencies row at all (Editors always can add one).
export function hasDependencyRow(task: TaskDetail, canEdit: boolean) {
  return canEdit || task.dependencies.length > 0 || hasSchedule(task) || task.hiddenBlockers > 0;
}

// The pane's Dependencies row (Asana parity, batch 3): "Blocked by" (tasks this one comes after) and
// "Blocking" (tasks that come after it), one line each, with "Add dependencies" below. Each link is
// finish-to-start (the later task starts on/after the earlier one's due date + lag, and can't be
// completed before it) or start-to-start (starts on/after its start + lag; never blocks completion).
// Editors of both tasks add, change, and remove links — across projects and between subtasks too.
export function TaskDependencies({ task, canEdit }: { task: TaskDetail; canEdit: boolean }) {
  // The slack comes after the pane opens (a whole-project read; Oct 19 notes).
  const schedule = useTaskExtras(task.id, "schedule", hasSchedule(task))?.schedule ?? [];
  const multiProject = schedule.length > 1;
  const ordered = [
    ...task.dependencies.filter((d) => d.relation === "blocked_by"),
    ...task.dependencies.filter((d) => d.relation === "blocking"),
  ];

  return (
    <div className="flex min-h-8 flex-col justify-center gap-0.5 py-0.5">
      {ordered.length ? (
        <ul className="flex flex-col" aria-label="Dependencies">
          {ordered.map((item, index) => (
            <DependencyItem
              key={item.id}
              task={task}
              item={item}
              canEdit={canEdit}
              showRelation={index === 0 || ordered[index - 1].relation !== item.relation}
            />
          ))}
        </ul>
      ) : !canEdit ? (
        <span className="px-1 text-sm text-zinc-500">None</span>
      ) : null}
      {task.hiddenBlockers > 0 ? (
        <p className="flex items-center gap-1.5 px-1 text-xs text-zinc-600">
          <EyeOff className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
          Also waiting on {task.hiddenBlockers === 1 ? "1 task" : `${task.hiddenBlockers} tasks`} you can’t open
        </p>
      ) : null}
      {schedule.length > 0 ? (
        <ul className="px-1 text-xs text-zinc-500" aria-label="Schedule">
          {schedule.map((s) => (
            <li key={s.projectId}>
              <span className={s.critical ? "font-medium text-zinc-800" : undefined}>{slackLabel(s)}</span>
              {multiProject ? <span className="text-zinc-400"> · {s.projectName}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? <AddDependency task={task} /> : null}
    </div>
  );
}

function DependencyItem({
  task,
  item,
  canEdit,
  showRelation,
}: {
  task: TaskDetail;
  item: TaskDependency;
  canEdit: boolean;
  showRelation: boolean;
}) {
  const custom = item.kind !== "finish_to_start" || item.lagDays !== 0;
  return (
    <li className="group/dep flex min-h-7 min-w-0 items-center gap-1.5 px-1 text-sm">
      <span className={`w-16 shrink-0 text-xs text-zinc-500 ${showRelation ? "" : "invisible"}`}>{RELATION_LABELS[item.relation]}</span>
      {item.completedAt ? (
        <CheckCircle2 className="size-3.5 shrink-0 text-green-600" aria-label="Completed" />
      ) : (
        <Circle className="size-3.5 shrink-0 text-zinc-400" aria-label="Incomplete" />
      )}
      <TaskLink
        taskId={item.taskId}
        seed={() => seedFromTitle(item.taskId, item.title, { completed: Boolean(item.completedAt) })}
        className={`min-w-20 truncate hover:underline ${item.completedAt ? "text-zinc-500 line-through" : "text-zinc-800"}`}
      >
        {item.title}
      </TaskLink>
      {item.isSubtask ? <span className="chip shrink-0">Subtask</span> : null}
      {custom ? <span className="min-w-0 truncate text-xs text-zinc-500">{dependencyLabel(item.kind, item.lagDays)}</span> : null}
      {canEdit ? <LinkOptions task={task} item={item} /> : null}
    </li>
  );
}

// Type, lag, and removal of one link (Editors). The lag commits on blur / Enter.
function LinkOptions({ task, item }: { task: TaskDetail; item: TaskDependency }) {
  const [pending, run] = useServerAction();
  const change = (kind: DependencyKind, lag: number) =>
    run(() =>
      item.relation === "blocked_by" ? setTaskDependency(item.taskId, task.id, kind, lag) : setTaskDependency(task.id, item.taskId, kind, lag),
    );
  return (
    <Popover
      label={`Options for the dependency on ${item.title}`}
      tooltip="Dependency options"
      align="end"
      panelClassName="w-64"
      buttonClassName="btn-icon ml-auto size-6 shrink-0 opacity-0 focus-visible:opacity-100 group-hover/dep:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
      button={<MoreHorizontal className="size-4" aria-hidden />}
    >
      {(close) => (
        <div className="flex flex-col gap-2.5">
          <div>
            <label htmlFor={`dep-kind-${item.id}`} className="text-xs font-medium text-zinc-600">
              Type
            </label>
            <SmartPicker
              id={`dep-kind-${item.id}`}
              label="Type"
              value={item.kind}
              disabled={pending}
              onChange={(kind) => {
                if (kind !== item.kind && isDependencyKind(kind)) change(kind, item.lagDays);
              }}
              className="mt-1 w-full"
              options={DEPENDENCY_KINDS.map((k) => ({ value: k.value, label: k.label }))}
            />
          </div>
          <div>
            <label htmlFor={`dep-lag-${item.id}`} className="text-xs font-medium text-zinc-600">
              Lag in days (negative = overlap)
            </label>
            <input
              id={`dep-lag-${item.id}`}
              type="number"
              step={1}
              min={-MAX_LAG_DAYS}
              max={MAX_LAG_DAYS}
              key={`${item.id}-${item.lagDays}`}
              defaultValue={item.lagDays}
              disabled={pending}
              onBlur={(e) => {
                const input = e.currentTarget;
                const lag = Number(input.value);
                if (!Number.isInteger(lag) || Math.abs(lag) > MAX_LAG_DAYS) {
                  input.value = String(item.lagDays);
                  return;
                }
                if (lag !== item.lagDays) change(item.kind, lag);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              className="control mt-1 w-24 tabular-nums"
            />
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              close();
              run(() => removeTaskDependency(item.id));
            }}
            className="btn-ghost justify-start px-1.5 text-red-700 hover:bg-red-50 hover:text-red-800"
          >
            <Trash2 className="size-3.5" aria-hidden />
            Remove dependency
          </button>
        </div>
      )}
    </Popover>
  );
}

// "Add dependencies": pick whether the other task comes before (Blocked by) or after (Blocking), then
// find it among this task's tree, its projects you edit, and a few other projects you edit.
function AddDependency({ task }: { task: TaskDetail }) {
  const [, run] = useServerAction();
  const [relation, setRelation] = useState<Relation>("blocked_by");
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState(false);
  // The tasks to pick from load the first time the picker opens (a big read on a big project).
  const extras = useTaskExtras(task.id, "candidates", opened);
  const linked = new Set(task.dependencies.map((d) => d.taskId));
  const q = query.trim().toLowerCase();
  const groups = (extras?.dependencyCandidates ?? [])
    .map((g) => ({
      ...g,
      tasks: g.tasks.filter((t) => !linked.has(t.id) && (!q || t.title.toLowerCase().includes(q))).slice(0, 30),
    }))
    .filter((g) => g.tasks.length > 0);

  function add(otherId: string) {
    run(() => (relation === "blocked_by" ? setTaskDependency(otherId, task.id) : setTaskDependency(task.id, otherId)));
  }

  return (
    <Popover
      label="Add dependencies"
      onOpenChange={(open) => {
        if (open) setOpened(true);
      }}
      panelClassName="w-80 p-0"
      buttonClassName="inline-flex h-7 items-center gap-1 self-start rounded-md px-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 aria-expanded:bg-zinc-100 print:hidden"
      button={
        <>
          <Plus className="size-3.5" aria-hidden />
          Add dependencies
        </>
      }
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-2.5 py-2">
            <Segmented
              label="This task is"
              options={[
                { value: "blocked_by", label: "Blocked by" },
                { value: "blocking", label: "Blocking" },
              ]}
              value={relation}
              onChange={setRelation}
            />
          </div>
          <div className="flex items-center gap-2 border-b border-zinc-100 px-2.5">
            <Search className="size-4 shrink-0 text-zinc-400" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              aria-label="Find a task"
              placeholder="Find a task"
              className="h-9 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:shadow-none"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {groups.map((group) => (
              <div key={group.key} role="group" aria-label={group.label}>
                <p aria-hidden className="px-2 pb-0.5 pt-2 text-2xs font-semibold uppercase tracking-wider text-zinc-500">
                  {group.label}
                </p>
                <ul>
                  {group.tasks.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => {
                          close();
                          add(t.id);
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-800 hover:bg-zinc-100"
                      >
                        <Circle className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                        <span className="truncate">{t.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {!extras ? (
              <p role="status" className="px-2 py-2 text-xs text-zinc-500">
                Loading tasks…
              </p>
            ) : groups.length === 0 ? (
              <p className="px-2 py-2 text-xs text-zinc-500">
                {q ? `No task you can edit matches “${query.trim()}”.` : "No other tasks you can edit to link to."}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </Popover>
  );
}
