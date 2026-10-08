"use client";

import { useState } from "react";
import { useServerAction } from "@/components/toast";
import { convertToSubtask, convertToTask } from "@/lib/actions";
import type { TaskDetail } from "@/lib/data";
import { hasRole } from "@/lib/roles";

const SELECT =
  "min-w-0 max-w-full rounded-md border border-transparent bg-transparent py-0.5 text-xs text-zinc-600 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none";

// Convert a task into a subtask of another task (it leaves its projects), or a subtask into a task of a
// project you edit. Tags, field values, comments, dependencies, and its own subtasks come along; the
// database checks Editor on both sides, cycles, and the depth limit.
export function TaskConvert({ task }: { task: TaskDetail }) {
  const [pending, run] = useServerAction();
  const canEdit = hasRole(task.viewerRole, "editor");
  const editable = task.memberships.filter((m) => task.editableProjectIds.includes(m.projectId));
  const defaultProject = editable.find((m) => m.isHome) ?? editable[0];
  const [projectId, setProjectId] = useState(defaultProject?.projectId ?? "");
  const [sectionId, setSectionId] = useState("");
  if (!canEdit) return null;

  if (task.isSubtask) {
    if (!defaultProject) return null;
    const project = editable.find((m) => m.projectId === projectId) ?? defaultProject;
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
        <span>Convert to a task in</span>
        <label className="sr-only" htmlFor="convert-project">
          Project
        </label>
        <select
          id="convert-project"
          value={project.projectId}
          disabled={pending}
          onChange={(e) => {
            setProjectId(e.currentTarget.value);
            setSectionId("");
          }}
          className={SELECT}
        >
          {editable.map((m) => (
            <option key={m.projectId} value={m.projectId}>
              {m.projectName}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="convert-section">
          Section
        </label>
        <select
          id="convert-section"
          value={sectionId}
          disabled={pending}
          onChange={(e) => setSectionId(e.currentTarget.value)}
          className={SELECT}
        >
          <option value="">No section</option>
          {project.sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => convertToTask(task.id, project.projectId, sectionId || null))}
          className="btn-ghost h-6 px-1.5 text-xs"
        >
          Convert
        </button>
      </div>
    );
  }

  // Possible parents: tasks of projects you edit, not this task's own subtasks (that would be a cycle).
  const parents = task.dependencyCandidates.filter((g) => g.key !== "tree");
  if (parents.length === 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-500">
      <label htmlFor="convert-parent" className="shrink-0">
        Convert to a subtask of
      </label>
      <select
        id="convert-parent"
        value=""
        disabled={pending}
        onChange={(e) => {
          const parentId = e.currentTarget.value;
          const parent = parents.flatMap((g) => g.tasks).find((t) => t.id === parentId);
          if (
            parent &&
            window.confirm(
              `Make “${task.title}” a subtask of “${parent.title}”? It leaves its projects and lives in “${parent.title}”’s projects instead; its tags, fields, comments, dependencies, and subtasks come along.`,
            )
          ) {
            run(() => convertToSubtask(task.id, parent.id));
          }
        }}
        className={`${SELECT} flex-1`}
      >
        <option value="">Choose a task…</option>
        {parents.map((group) => (
          <optgroup key={group.key} label={group.label}>
            {group.tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
