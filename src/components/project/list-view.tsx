"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { CompleteToggle } from "@/components/complete-toggle";
import { useServerAction } from "@/components/toast";
import { setTaskCompleted } from "@/lib/actions";
import type { Profile, ProjectTask, Section } from "@/lib/data";
import { AddSection, AddTaskInput, SectionTitle, useTaskHref } from "./shared";
import { Assignee, DueDate, TaskBadges } from "./task-meta";
import { tasksBySection, useProjectTasks } from "./use-project-tasks";

type Props = {
  projectId: string;
  sections: Section[];
  tasks: ProjectTask[];
  profiles: Profile[];
  openTaskId: string | null;
};

const GRID = "grid grid-cols-[minmax(0,1fr)_9rem_6rem] items-center gap-3";

export function ListView({ projectId, sections, tasks, profiles, openTaskId }: Props) {
  const [optimisticTasks, applyChange] = useProjectTasks(tasks);
  const [, run] = useServerAction();
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const groups = tasksBySection(optimisticTasks);
  const unsectioned = groups.get(null) ?? [];

  const toggle = (task: ProjectTask) => {
    const completed = !task.completedAt;
    run(
      () => setTaskCompleted(task.id, completed),
      () => applyChange({ type: "complete", taskId: task.id, completed }),
    );
  };

  const rowProps = { profilesById, openTaskId, onToggle: toggle };

  return (
    <div className="min-w-[36rem] px-6 py-4">
      <div
        className={`${GRID} border-b border-zinc-200 px-3 pb-2 text-xs font-medium text-zinc-500`}
        aria-hidden
      >
        <span className="pl-7">Task</span>
        <span>Assignee</span>
        <span>Due</span>
      </div>

      {sections.length === 0 && optimisticTasks.length === 0 ? (
        <div className="mx-auto max-w-md py-16 text-center">
          <h2 className="text-sm font-medium text-zinc-900">This project is empty</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Add a section to group work (for example “Backlog” or “This week”), then add tasks to
            it. You can also add tasks without a section.
          </p>
        </div>
      ) : null}

      {unsectioned.length > 0 || sections.length === 0 ? (
        <SectionGroup title={<span className="px-1 text-sm font-semibold text-zinc-500">No section</span>}>
          {unsectioned.map((task) => (
            <TaskRow key={task.id} task={task} {...rowProps} />
          ))}
          <AddTaskInput projectId={projectId} sectionId={null} variant="row" />
        </SectionGroup>
      ) : null}

      {sections.map((section) => {
        const sectionTasks = groups.get(section.id) ?? [];
        return (
          <SectionGroup
            key={section.id}
            title={<SectionTitle section={section} count={sectionTasks.length} />}
          >
            {sectionTasks.map((task) => (
              <TaskRow key={task.id} task={task} {...rowProps} />
            ))}
            {sectionTasks.length === 0 ? (
              <p className="px-3 pt-2 pl-10 text-xs text-zinc-400">No tasks in this section yet.</p>
            ) : null}
            <AddTaskInput projectId={projectId} sectionId={section.id} variant="row" />
          </SectionGroup>
        );
      })}

      <div className="mt-6">
        <AddSection projectId={projectId} variant="list" />
      </div>
    </div>
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
          aria-label={collapsed ? "Expand section" : "Collapse section"}
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
}: {
  task: ProjectTask;
  profilesById: Map<string, Profile>;
  openTaskId: string | null;
  onToggle: (task: ProjectTask) => void;
}) {
  const taskHref = useTaskHref();
  const completed = Boolean(task.completedAt);
  const assignee = task.assigneeId ? profilesById.get(task.assigneeId) : undefined;
  const open = openTaskId === task.id;

  return (
    <div
      className={`${GRID} border-b border-zinc-100 px-3 py-2 ${open ? "bg-accent-50" : "hover:bg-zinc-50"}`}
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
      <div className="min-w-0">
        <Assignee profile={assignee} showName />
      </div>
      <div>
        <DueDate task={task} />
      </div>
    </div>
  );
}
