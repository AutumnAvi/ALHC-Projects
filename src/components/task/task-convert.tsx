"use client";

import { useState } from "react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { useServerAction } from "@/components/toast";
import { convertToSubtask, convertToTask } from "@/lib/actions";
import type { TaskDetail } from "@/lib/data";
import { hasRole } from "@/lib/roles";

// Whether the "…" menu offers Convert: a subtask can become a task of a project you edit; a task can
// become a subtask of another task you edit.
export function canConvert(task: TaskDetail) {
  if (!hasRole(task.viewerRole, "editor")) return false;
  if (task.isSubtask) return task.memberships.some((m) => task.editableProjectIds.includes(m.projectId));
  return task.dependencyCandidates.some((g) => g.key !== "tree" && g.tasks.length > 0);
}

// Convert a task into a subtask of another task (it leaves its projects), or a subtask into a task of a
// project you edit (from the pane's "…" menu). Tags, field values, comments, dependencies, and its own
// subtasks come along; the database checks Editor on both sides, cycles, and the depth limit.
export function ConvertTaskDialog({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
  const [pending, run] = useServerAction();
  const editable = task.memberships.filter((m) => task.editableProjectIds.includes(m.projectId));
  const defaultProject = editable.find((m) => m.isHome) ?? editable[0];
  const [projectId, setProjectId] = useState(defaultProject?.projectId ?? "");
  const [sectionId, setSectionId] = useState("");
  const [parentId, setParentId] = useState("");
  // Possible parents: tasks of projects you edit, not this task's own subtasks (that would be a cycle).
  const parents = task.dependencyCandidates.filter((g) => g.key !== "tree");

  function finish(result: Promise<{ error?: string }>) {
    run(async () => {
      const outcome = await result;
      if (!outcome.error) onClose();
      return outcome;
    });
  }

  if (task.isSubtask) {
    const project = editable.find((m) => m.projectId === projectId) ?? defaultProject;
    return (
      <Dialog
        title="Convert to a task"
        description="It leaves its parent and becomes a task of the project you pick. Its tags, fields, comments, dependencies, and subtasks come along."
        onClose={onClose}
      >
        {project ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              finish(convertToTask(task.id, project.projectId, sectionId || null));
            }}
            className="flex flex-col gap-3"
          >
            <div>
              <label htmlFor="convert-project" className={DIALOG_LABEL}>
                Project
              </label>
              <select
                id="convert-project"
                value={project.projectId}
                onChange={(e) => {
                  setProjectId(e.currentTarget.value);
                  setSectionId("");
                }}
                className="field mt-1 w-full"
              >
                {editable.map((m) => (
                  <option key={m.projectId} value={m.projectId}>
                    {m.projectName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="convert-section" className={DIALOG_LABEL}>
                Section
              </label>
              <select id="convert-section" value={sectionId} onChange={(e) => setSectionId(e.currentTarget.value)} className="field mt-1 w-full">
                <option value="">No section</option>
                {project.sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={pending}>
                Convert
              </button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-zinc-600">You aren’t an Editor of a project of its top-level task.</p>
        )}
      </Dialog>
    );
  }

  const parent = parents.flatMap((g) => g.tasks).find((t) => t.id === parentId);
  return (
    <Dialog
      title="Convert to a subtask"
      description="It leaves its projects and lives in the parent task’s projects instead. Its tags, fields, comments, dependencies, and subtasks come along."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (parent) finish(convertToSubtask(task.id, parent.id));
        }}
        className="flex flex-col gap-3"
      >
        <div>
          <label htmlFor="convert-parent" className={DIALOG_LABEL}>
            Parent task
          </label>
          <select id="convert-parent" value={parentId} onChange={(e) => setParentId(e.currentTarget.value)} className="field mt-1 w-full" required>
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
          <p className={DIALOG_HINT}>Tasks of projects you edit.</p>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={pending || !parent}>
            Convert
          </button>
        </div>
      </form>
    </Dialog>
  );
}
