"use client";

import { useState } from "react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { SmartPicker } from "@/components/smart-picker";
import { useServerAction } from "@/components/toast";
import { convertToSubtask, convertToTask } from "@/lib/actions";
import type { TaskDetail } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import { useTaskExtras } from "./task-pane-store";

// Whether the "…" menu offers Convert: a subtask can become a task of a project you edit; a task can
// become a subtask of another task you edit (the dialog lists them, and says so when there are none).
export function canConvert(task: TaskDetail) {
  if (!hasRole(task.viewerRole, "editor")) return false;
  if (task.isSubtask) return task.memberships.some((m) => task.editableProjectIds.includes(m.projectId));
  return true;
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
  // Loaded when the dialog opens (a big read on a big project).
  const extras = useTaskExtras(task.id, "candidates", !task.isSubtask);
  const parents = (extras?.dependencyCandidates ?? []).filter((g) => g.key !== "tree" && g.tasks.length > 0);

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
              <SmartPicker
                id="convert-project"
                label="Project"
                value={project.projectId}
                onChange={(value) => {
                  setProjectId(value);
                  setSectionId("");
                }}
                className="mt-1 h-9 w-full"
                options={editable.map((m) => ({ value: m.projectId, label: m.projectName }))}
              />
            </div>
            <div>
              <label htmlFor="convert-section" className={DIALOG_LABEL}>
                Section
              </label>
              <SmartPicker
                id="convert-section"
                label="Section"
                value={sectionId}
                onChange={setSectionId}
                className="mt-1 h-9 w-full"
                options={[{ value: "", label: "No section" }, ...project.sections.map((s) => ({ value: s.id, label: s.name }))]}
              />
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
          <SmartPicker
            id="convert-parent"
            label="Parent task"
            placeholder={!extras ? "Loading tasks…" : parents.length ? "Choose a task…" : "No tasks you edit"}
            value={parentId}
            onChange={setParentId}
            disabled={!extras || parents.length === 0}
            searchable
            className="mt-1 h-9 w-full"
            options={parents.flatMap((group) => group.tasks.map((t) => ({ value: t.id, label: t.title, group: group.label })))}
          />
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
