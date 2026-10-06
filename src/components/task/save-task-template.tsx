"use client";

import { useState } from "react";
import { LayoutTemplate } from "lucide-react";
import { Popover } from "@/components/popover";
import { useNotify, useServerAction } from "@/components/toast";
import { saveTaskAsTemplate } from "@/lib/actions";

// Pane header: save this task as a task template of one of its projects (Editor+ there). Captures the
// title, notes, subtasks, that project's field values, and optionally the assignee.
export function SaveTaskTemplateButton({
  taskId,
  title,
  hasAssignee,
  projects,
  defaultProjectId,
}: {
  taskId: string;
  title: string;
  hasAssignee: boolean;
  projects: { id: string; name: string }[];
  defaultProjectId: string;
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const [projectId, setProjectId] = useState(defaultProjectId);

  return (
    <Popover
      label="Save as task template"
      align="end"
      panelClassName="w-72"
      buttonClassName="btn-icon"
      button={<LayoutTemplate className="size-4" aria-hidden />}
    >
      {(close) => (
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
                close();
                notify("Task template saved — find it under “Add task” → Template");
              }
              return result;
            });
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-xs font-semibold text-zinc-900">Save as task template</p>
          <div>
            <label htmlFor="task-template-name" className="block text-xs font-medium text-zinc-700">
              Template name
            </label>
            <input
              id="task-template-name"
              name="name"
              required
              autoFocus
              maxLength={100}
              defaultValue={title.slice(0, 100)}
              className="control mt-1 w-full"
            />
          </div>
          {projects.length > 1 ? (
            <div>
              <label htmlFor="task-template-project" className="block text-xs font-medium text-zinc-700">
                Project
              </label>
              <select
                id="task-template-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="control mt-1 w-full"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {hasAssignee ? (
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" name="include_assignee" className="size-4 accent-accent-600" />
              Include the assignee
            </label>
          ) : null}
          <p className="text-2xs text-zinc-500">
            Keeps the title, notes, subtasks, and this project’s field values. Comments, files, and dates are left out.
          </p>
          <button type="submit" disabled={pending} className="btn-primary self-start">
            {pending ? "Saving…" : "Save template"}
          </button>
        </form>
      )}
    </Popover>
  );
}
