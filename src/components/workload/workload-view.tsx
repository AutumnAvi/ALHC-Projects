"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useOptimistic, useState, useTransition, type DragEvent } from "react";
import { Gauge, X } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Popover } from "@/components/popover";
import { useTaskHref } from "@/components/project/shared";
import { PeriodNav, Segmented } from "@/components/project/view-chrome";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { useDependencyShift } from "@/components/task/dependency-shift";
import { setWorkloadCapacity, updateTask } from "@/lib/actions";
import {
  WORKLOAD_ZOOMS,
  addDays,
  columnCapacity,
  columnLabel,
  daysBetween,
  formatLoad,
  spanOf,
  stepWorkloadAnchor,
  taskLoad,
  windowLabel,
  workloadWindow,
  type WorkloadTask,
  type WorkloadZoom,
} from "@/lib/workload";

export type WorkloadPerson = { id: string; name: string };
export type WorkloadScope = { projectId: string } | { portfolioId: string };

type Cell = { personId: string; column: number };
type Change = { id: string; assigneeId: string; startOn: string | null; dueOn: string };

const TASK_DRAG = "application/x-alhc-workload-task";

export function WorkloadView({
  scope,
  anchor,
  zoom,
  today,
  people,
  tasks,
  capacities,
  measures,
  measure,
  canEditCapacity,
  projectNames,
  hiddenProjects = 0,
}: {
  scope: WorkloadScope;
  anchor: string;
  zoom: WorkloadZoom;
  today: string;
  people: WorkloadPerson[];
  tasks: WorkloadTask[];
  capacities: Record<string, number>;
  // value "" = count tasks; otherwise a number field (id in a project, name in a portfolio).
  measures: { value: string; label: string }[];
  measure: string;
  canEditCapacity: boolean;
  projectNames?: Record<string, string>;
  hiddenProjects?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const taskHref = useTaskHref();
  const [navigating, startNavigation] = useTransition();
  const [, run] = useServerAction();
  const [selected, setSelected] = useState<Cell | null>(null);
  const [dragging, setDragging] = useState<WorkloadTask | null>(null);
  const [dropCell, setDropCell] = useState<string | null>(null);
  const [shown, applyChange] = useOptimistic(tasks, (current, change: Pick<Change, "id"> & Partial<Change>) =>
    current.map((t) => (t.id === change.id ? { ...t, ...change } : t)),
  );
  // Moving a task's dates can push (or, if asked, pull) its dependents: ask first, with Undo.
  const shift = useDependencyShift();

  const byField = measure !== "";
  const unit = byField ? (measures.find((m) => m.value === measure)?.label ?? "value") : "tasks";
  const { start, end, columns } = workloadWindow(anchor, zoom);
  const todayColumn = columns.findIndex((c) => c.start <= today && today <= c.end);

  function navigate(next: { d?: string | null; wl?: WorkloadZoom; m?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("task");
    if (next.d !== undefined) {
      if (next.d) params.set("d", next.d);
      else params.delete("d");
    }
    if (next.wl) {
      if (next.wl === "week") params.delete("wl");
      else params.set("wl", next.wl);
    }
    if (next.m !== undefined) {
      if (next.m) params.set("m", next.m);
      else params.delete("m");
    }
    setSelected(null);
    const query = params.toString();
    startNavigation(() => router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  }

  // Per person: load per column and the tasks behind it.
  const byPerson = new Map<string, WorkloadTask[]>();
  for (const task of shown) {
    const list = byPerson.get(task.assigneeId) ?? [];
    list.push(task);
    byPerson.set(task.assigneeId, list);
  }
  const cellTasks = (personId: string, column: number) =>
    (byPerson.get(personId) ?? []).filter((t) => taskLoad(t, columns[column], false) > 0);
  const cellLoad = (personId: string, column: number) =>
    (byPerson.get(personId) ?? []).reduce((sum, t) => sum + taskLoad(t, columns[column], byField), 0);

  function drop(event: DragEvent, personId: string, column: number) {
    event.preventDefault();
    const task = dragging;
    setDragging(null);
    setDropCell(null);
    if (!task || !selected) return;
    const delta = daysBetween(columns[selected.column].start, columns[column].start);
    const change: Change = {
      id: task.id,
      assigneeId: personId,
      startOn: task.startOn ? addDays(task.startOn, delta) : null,
      dueOn: addDays(task.dueOn, delta),
    };
    if (personId !== task.assigneeId) {
      run(
        () => updateTask(task.id, { assigneeId: personId }),
        () => applyChange({ id: task.id, assigneeId: personId }),
      );
    }
    if (delta !== 0) {
      shift.changeDates(
        { id: task.id, title: task.title },
        { startOn: change.startOn, dueOn: change.dueOn },
        {
          onOptimistic: (moves) =>
            moves.forEach((m) => {
              if (m.dueOn) applyChange({ id: m.taskId, startOn: m.startOn, dueOn: m.dueOn });
            }),
        },
      );
    }
  }

  const selectedPerson = selected ? people.find((p) => p.id === selected.personId) : undefined;
  const selectedTasks = selected ? cellTasks(selected.personId, selected.column) : [];
  const columnWidth = zoom === "day" ? "w-16 min-w-16" : "w-20 min-w-20";

  return (
    <div className="flex min-h-0 flex-1 flex-col px-gutter py-3">
      {shift.dialog}
      <PeriodNav
        label={windowLabel(start, end)}
        prevLabel="Earlier"
        nextLabel="Later"
        onPrev={() => navigate({ d: stepWorkloadAnchor(anchor, zoom, -1) })}
        onNext={() => navigate({ d: stepWorkloadAnchor(anchor, zoom, 1) })}
        onToday={() => navigate({ d: null })}
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-zinc-600">
            Measure
            <select
              value={measure}
              onChange={(e) => navigate({ m: e.target.value })}
              className="control h-7"
            >
              {measures.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <Segmented label="Columns" options={WORKLOAD_ZOOMS} value={zoom} onChange={(wl) => navigate({ wl })} />
        </div>
      </PeriodNav>

      {hiddenProjects > 0 ? (
        <p className="mb-2 text-xs text-zinc-500">
          {hiddenProjects === 1 ? "1 project" : `${hiddenProjects} projects`} in this portfolio {hiddenProjects === 1 ? "isn’t" : "aren’t"}{" "}
          counted because you aren’t a member.
        </p>
      ) : null}

      {people.length === 0 ? (
        <EmptyState icon={Gauge} title="No one to show yet">
          People appear here once they’re members or have open tasks with a due date. Assign tasks and set due dates
          (and start dates for longer work) to see who has how much on their plate.
        </EmptyState>
      ) : (
        <div className={`min-h-0 overflow-auto rounded-lg border border-zinc-200 ${navigating ? "opacity-60" : ""}`} aria-busy={navigating}>
          <table className="border-separate border-spacing-0 text-sm">
            <caption className="sr-only">
              Workload per person, {zoom === "day" ? "per day" : "per week"}, measured in {unit}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 top-0 z-20 w-60 min-w-60 border-b border-r border-zinc-200 bg-white px-3 py-2 text-left text-xs font-medium text-zinc-500">
                  Person · weekly capacity
                </th>
                {columns.map((column, i) => (
                  <th
                    key={column.start}
                    scope="col"
                    className={`sticky top-0 z-10 ${columnWidth} border-b border-zinc-200 px-1 py-1.5 text-center text-2xs font-medium ${
                      i === todayColumn ? "bg-accent-50 text-accent-700" : column.weekend ? "bg-zinc-50 text-zinc-400" : "bg-white text-zinc-500"
                    }`}
                  >
                    <span className="block">{column.label}</span>
                    <span className="block font-normal">{column.sublabel}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.id}>
                  <th scope="row" className="sticky left-0 z-10 border-b border-r border-zinc-100 bg-white px-3 py-1.5 text-left font-normal">
                    <span className="flex items-center gap-2">
                      <Avatar name={person.name} />
                      <span className="min-w-0 flex-1 truncate text-zinc-900">{person.name}</span>
                      <CapacityControl
                        scope={scope}
                        person={person}
                        capacity={capacities[person.id]}
                        unit={unit}
                        canEdit={canEditCapacity}
                      />
                    </span>
                  </th>
                  {columns.map((column, i) => {
                    const load = cellLoad(person.id, i);
                    const count = cellTasks(person.id, i).length;
                    const capacity = columnCapacity(capacities[person.id], column, zoom);
                    const over = capacity !== null && load > capacity + 1e-9;
                    const key = `${person.id}:${i}`;
                    const isSelected = selected?.personId === person.id && selected.column === i;
                    const label = `${person.name}, ${columnLabel(column, zoom)}: ${count === 1 ? "1 task" : `${count} tasks`}${
                      byField ? `, ${formatLoad(load)} ${unit}` : ""
                    }${capacity !== null ? `, capacity ${formatLoad(capacity)}${over ? ", over capacity" : ""}` : ""}`;
                    return (
                      <td
                        key={column.start}
                        className={`border-b border-zinc-100 p-0.5 ${column.weekend ? "bg-zinc-50" : ""}`}
                        onDragOver={(e) => {
                          if (!dragging?.canEdit) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (dropCell !== key) setDropCell(key);
                        }}
                        onDragLeave={() => setDropCell((c) => (c === key ? null : c))}
                        onDrop={(e) => drop(e, person.id, i)}
                      >
                        <button
                          type="button"
                          aria-label={label}
                          aria-pressed={isSelected}
                          onClick={() => setSelected(isSelected ? null : { personId: person.id, column: i })}
                          className={`flex h-8 w-full items-center justify-center rounded text-xs tabular-nums ${
                            dropCell === key
                              ? "bg-accent-100 ring-2 ring-accent-400"
                              : over
                                ? "bg-red-50 font-semibold text-red-700 ring-1 ring-red-200"
                                : load > 0
                                  ? "bg-accent-50 font-medium text-accent-800"
                                  : "text-zinc-300 hover:bg-zinc-100"
                          } ${isSelected ? "ring-2 ring-accent-600" : ""} ${i === todayColumn && load === 0 ? "bg-accent-50/40" : ""}`}
                        >
                          {load > 0 ? formatLoad(load) : count > 0 ? "0" : "·"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shown.length === 0 && people.length > 0 ? (
        <p className="mt-2 text-xs text-zinc-400">
          No open, assigned tasks with a due date in this period. Workload counts each task from its start date to its
          due date (or on its due date alone).
        </p>
      ) : null}

      {selected && selectedPerson ? (
        <section aria-labelledby="workload-cell-heading" className="mt-3 rounded-lg border border-zinc-200 bg-white p-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h3 id="workload-cell-heading" className="text-sm font-semibold text-zinc-900">
                {selectedPerson.name} · {columnLabel(columns[selected.column], zoom)}
              </h3>
              <p className="text-xs text-zinc-500">
                {selectedTasks.length === 1 ? "1 task" : `${selectedTasks.length} tasks`}
                {byField ? ` · ${formatLoad(cellLoad(selected.personId, selected.column))} ${unit}` : ""}
                {(() => {
                  const capacity = columnCapacity(capacities[selected.personId], columns[selected.column], zoom);
                  return capacity !== null ? ` · capacity ${formatLoad(capacity)}` : "";
                })()}
                {selectedTasks.some((t) => t.canEdit) ? " · Drag a task onto another person or day to reassign or reschedule it." : ""}
              </p>
            </div>
            <button type="button" onClick={() => setSelected(null)} aria-label="Close" className="btn-icon">
              <X className="size-4" />
            </button>
          </div>
          {selectedTasks.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-400">Nothing scheduled here.</p>
          ) : (
            <ul className="mt-2 divide-y divide-zinc-100">
              {selectedTasks.map((task) => {
                const span = spanOf(task);
                return (
                  <li
                    key={task.id}
                    draggable={task.canEdit}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(TASK_DRAG, task.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(task);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropCell(null);
                    }}
                    className={`flex items-center gap-3 py-1.5 ${task.canEdit ? "cursor-grab active:cursor-grabbing" : ""} ${
                      dragging?.id === task.id ? "opacity-40" : ""
                    }`}
                  >
                    <Link href={taskHref(task.id)} scroll={false} draggable={false} className="min-w-0 flex-1 truncate text-sm text-zinc-900 hover:underline">
                      {task.title}
                    </Link>
                    {projectNames?.[task.projectId] ? (
                      <span className="chip hidden max-w-40 truncate sm:inline-flex">{projectNames[task.projectId]}</span>
                    ) : null}
                    {byField ? (
                      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-zinc-500">
                        {task.value === null ? "—" : formatLoad(task.value)}
                      </span>
                    ) : null}
                    <span className="w-28 shrink-0 text-right text-xs tabular-nums text-zinc-500">
                      {span.start === span.end ? `Due ${shortDay(span.end)}` : `${shortDay(span.start)} – ${shortDay(span.end)}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        <p className="mt-2 text-xs text-zinc-400">
          Select a cell to see its tasks. With a weekly capacity set, cells over it turn red (a day’s capacity is a fifth
          of the week’s; weekends have none).
        </p>
      )}
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;

function CapacityControl({
  scope,
  person,
  capacity,
  unit,
  canEdit,
}: {
  scope: WorkloadScope;
  person: WorkloadPerson;
  capacity: number | undefined;
  unit: string;
  canEdit: boolean;
}) {
  const [, run] = useServerAction();
  const text = capacity === undefined ? null : `${formatLoad(capacity)}/wk`;
  if (!canEdit) {
    return text ? <span className="shrink-0 text-xs tabular-nums text-zinc-500" title={`Weekly capacity: ${text}`}>{text}</span> : null;
  }
  return (
    <Popover
      label={`Weekly capacity for ${person.name}`}
      align="end"
      panelClassName="w-64"
      buttonClassName={`shrink-0 rounded px-1 text-xs tabular-nums ${text ? "text-zinc-600 hover:bg-zinc-100" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"}`}
      button={text ?? "Set"}
    >
      {(close) => (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = Number(new FormData(e.currentTarget).get("capacity"));
            close();
            if (Number.isFinite(value) && value > 0) run(() => setWorkloadCapacity(scope, person.id, value));
          }}
        >
          <label className="text-xs font-medium text-zinc-600" htmlFor={`capacity-${person.id}`}>
            Weekly capacity for {person.name} ({unit} per week)
          </label>
          <input
            id={`capacity-${person.id}`}
            name="capacity"
            type="number"
            min="0.1"
            step="any"
            autoFocus
            defaultValue={capacity ?? ""}
            className="control w-full"
          />
          <div className="flex justify-end gap-1">
            {capacity !== undefined ? (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  close();
                  run(() => setWorkloadCapacity(scope, person.id, null));
                }}
              >
                Clear
              </button>
            ) : null}
            <button type="submit" className="btn-primary">
              Save
            </button>
          </div>
        </form>
      )}
    </Popover>
  );
}
