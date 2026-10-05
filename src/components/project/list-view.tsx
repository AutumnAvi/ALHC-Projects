"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { CompleteToggle } from "@/components/complete-toggle";
import { useServerAction } from "@/components/toast";
import { setTaskCompleted } from "@/lib/actions";
import type { Profile, ProjectTask, Section } from "@/lib/data";
import { OPTION_COLOR_CLASSES, type FieldDef } from "@/lib/fields";
import { columnsOf, groupOf, hasActiveFilters, refFieldId, type ColumnKey, type ViewConfig } from "@/lib/views";
import { FieldValueChips, type FieldContext } from "./field-chips";
import { AddSection, AddTaskInput, SectionTitle, useTaskHref } from "./shared";
import { Assignee, DueDate, StartDate, TaskBadges } from "./task-meta";
import { useProjectTasks } from "./use-project-tasks";
import { groupTasks, type TaskGroup } from "./view-groups";

type Props = {
  projectId: string;
  sections: Section[];
  tasks: ProjectTask[];
  profiles: Profile[];
  fields: FieldDef[];
  config: ViewConfig;
  openTaskId: string | null;
};

const GRID = "grid items-center gap-3";
const COLUMN_WIDTH: Record<string, string> = { assignee: "9rem", due: "6rem", start: "6rem", section: "8rem" };

export function ListView({ projectId, sections, tasks, profiles, fields, config, openTaskId }: Props) {
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const [, run] = useServerAction();
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const groups = groupTasks(optimisticTasks, config, { sections, profilesById, fields });
  const bySection = groupOf(config) === "section";
  const filtered = hasActiveFilters(config.filters);

  const toggle = (task: ProjectTask) => {
    const completed = !task.completedAt;
    run(
      () => setTaskCompleted(task.id, completed),
      () => applyChange({ type: "complete", taskId: task.id, completed }),
    );
  };

  const columns = columnsOf(config, fields).filter(
    (c) => !c.startsWith("field:") || fieldsById.has(refFieldId(c) ?? ""),
  );
  const gridStyle = {
    gridTemplateColumns: ["minmax(0,1fr)", ...columns.map((c) => COLUMN_WIDTH[c] ?? "8rem")].join(" "),
  };
  const fieldContext: FieldContext = {
    profilesById,
    sectionNames: new Map(sections.map((s) => [s.id, s.name])),
  };
  const rowProps = { profilesById, openTaskId, onToggle: toggle, columns, fieldsById, fieldContext, gridStyle };

  return (
    <div className="px-6 py-4" style={{ minWidth: `${28 + columns.length * 8.75}rem` }}>
      <div
        className={`${GRID} border-b border-zinc-200 px-3 pb-2 text-xs font-medium text-zinc-500`}
        style={gridStyle}
        aria-hidden
      >
        <span className="pl-7">Task</span>
        {columns.map((column) => (
          <span key={column} className="truncate">
            {columnLabel(column, fieldsById)}
          </span>
        ))}
      </div>

      {sections.length === 0 && tasks.length === 0 && !filtered ? (
        <div className="mx-auto max-w-md py-16 text-center">
          <h2 className="text-sm font-medium text-zinc-900">This project is empty</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Add a section to group work (for example “Backlog” or “This week”), then add tasks to
            it. You can also add tasks without a section.
          </p>
        </div>
      ) : null}

      {filtered && optimisticTasks.length === 0 ? (
        <p className="px-3 pt-6 text-sm text-zinc-500">No tasks match this view’s filters.</p>
      ) : null}

      {groups.map((group) => (
        <SectionGroup key={group.key} title={<GroupTitle group={group} />}>
          {group.tasks.map((task) => (
            <TaskRow key={task.id} task={task} {...rowProps} />
          ))}
          {group.section && group.tasks.length === 0 ? (
            <p className="px-3 pt-2 pl-10 text-xs text-zinc-400">
              {filtered ? "No matching tasks in this section." : "No tasks in this section yet."}
            </p>
          ) : null}
          {group.target.kind === "section" ? (
            <AddTaskInput projectId={projectId} sectionId={group.target.sectionId} variant="row" />
          ) : null}
        </SectionGroup>
      ))}

      {bySection ? (
        <div className="mt-6">
          <AddSection projectId={projectId} variant="list" />
        </div>
      ) : null}
    </div>
  );
}

function columnLabel(column: ColumnKey, fieldsById: Map<string, FieldDef>) {
  if (column === "assignee") return "Assignee";
  if (column === "due") return "Due";
  if (column === "start") return "Start";
  if (column === "section") return "Section";
  return fieldsById.get(refFieldId(column) ?? "")?.name ?? "";
}

export function GroupTitle({ group }: { group: TaskGroup }) {
  if (group.section) return <SectionTitle section={group.section} count={group.tasks.length} />;
  return (
    <span className="flex flex-1 items-center gap-2 px-1 text-sm font-semibold text-zinc-900">
      {group.color ? (
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${OPTION_COLOR_CLASSES[group.color]}`}>
          {group.label}
        </span>
      ) : (
        <span className={group.target.kind === "section" ? "text-zinc-500" : undefined}>{group.label}</span>
      )}
      <span className="text-xs font-normal tabular-nums text-zinc-400">{group.tasks.length}</span>
    </span>
  );
}

function SectionGroup({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="mt-5">
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand group" : "Collapse group"}
          className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        {title}
      </div>
      {collapsed ? null : <div className="mt-1 border-t border-zinc-100">{children}</div>}
    </section>
  );
}

function TaskRow({
  task,
  profilesById,
  openTaskId,
  onToggle,
  columns,
  fieldsById,
  fieldContext,
  gridStyle,
}: {
  task: ProjectTask;
  profilesById: Map<string, Profile>;
  openTaskId: string | null;
  onToggle: (task: ProjectTask) => void;
  columns: ColumnKey[];
  fieldsById: Map<string, FieldDef>;
  fieldContext: FieldContext;
  gridStyle: React.CSSProperties;
}) {
  const taskHref = useTaskHref();
  const completed = Boolean(task.completedAt);
  const assignee = task.assigneeId ? profilesById.get(task.assigneeId) : undefined;
  const open = openTaskId === task.id;

  return (
    <div
      className={`${GRID} border-b border-zinc-100 px-3 py-2 ${open ? "bg-accent-50" : "hover:bg-zinc-50"}`}
      style={gridStyle}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <CompleteToggle
          completed={completed}
          onToggle={() => onToggle(task)}
          label={completed ? `Mark “${task.title}” incomplete` : `Mark “${task.title}” complete`}
        />
        <Link
          href={taskHref(task.id)}
          scroll={false}
          aria-current={open ? "true" : undefined}
          className={`min-w-0 truncate text-sm hover:underline ${
            completed ? "text-zinc-400 line-through" : "text-zinc-900"
          }`}
        >
          {task.title}
        </Link>
        <span className="flex shrink-0 items-center gap-2">
          <TaskBadges task={task} />
        </span>
      </div>
      {columns.map((column) => {
        if (column === "assignee") {
          return (
            <div key={column} className="min-w-0">
              <Assignee profile={assignee} showName />
            </div>
          );
        }
        if (column === "due") {
          return (
            <div key={column}>
              <DueDate task={task} />
            </div>
          );
        }
        if (column === "start") {
          return (
            <div key={column}>
              <StartDate task={task} />
            </div>
          );
        }
        if (column === "section") {
          return (
            <div key={column} className="min-w-0 truncate text-xs text-zinc-600">
              {task.sectionId ? fieldContext.sectionNames.get(task.sectionId) : ""}
            </div>
          );
        }
        const field = fieldsById.get(refFieldId(column) ?? "");
        return (
          <div key={column} className="min-w-0">
            {field ? <FieldValueChips field={field} task={task} context={fieldContext} showName /> : null}
          </div>
        );
      })}
    </div>
  );
}
