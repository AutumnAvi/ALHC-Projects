"use client";

import { useState } from "react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { SmartPicker } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import { saveTaskAsTemplate } from "@/lib/actions";

// The pane's "…" → Save as task template: a task template of one of the task's projects (Editor+
// there). Captures the title, notes, subtasks, that project's field values, and optionally the assignee.
export function SaveTaskTemplateDialog({
  taskId,
  title,
  hasAssignee,
  projects,
  defaultProjectId,
  onClose,
}: {
  taskId: string;
  title: string;
  hasAssignee: boolean;
  projects: { id: string; name: string }[];
  defaultProjectId: string;
  onClose: () => void;
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const [projectId, setProjectId] = useState(defaultProjectId);

  return (
    <Dialog
      title="Save as task template"
      description="Keeps the title, notes, subtasks, and this project’s field values. Comments, files, and dates are left out."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          run(async () => {
            const result = await saveTaskAsTemplate(taskId, projectId, {
              name: String(data.get("name") ?? ""),
              includeAssignee: data.get("include_assignee") === "on",
            });
            if (!result.error) {
              onClose();
              notify("Task template saved — find it under “Add task” → Template");
            }
            return result;
          });
        }}
        className="flex flex-col gap-3"
      >
        <div>
          <label htmlFor="task-template-name" className={DIALOG_LABEL}>
            Template name
          </label>
          <input
            id="task-template-name"
            name="name"
            required
            data-autofocus
            maxLength={100}
            defaultValue={title.slice(0, 100)}
            className="field mt-1 w-full"
          />
        </div>
        {projects.length > 1 ? (
          <div>
            <label htmlFor="task-template-project" className={DIALOG_LABEL}>
              Project
            </label>
            <SmartPicker
              id="task-template-project"
              label="Project"
              value={projectId}
              onChange={setProjectId}
              className="mt-1 h-9 w-full"
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
            <p className={DIALOG_HINT}>The template is listed under that project’s Add task.</p>
          </div>
        ) : null}
        {hasAssignee ? (
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input type="checkbox" name="include_assignee" className="size-4 accent-accent-600" />
            Include the assignee
          </label>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={pending} className="btn-primary">
            {pending ? "Saving…" : "Save template"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
