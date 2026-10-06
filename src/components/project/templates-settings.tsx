"use client";

import Link from "next/link";
import { useState } from "react";
import { LayoutTemplate, ListPlus, Pencil, Plus, Trash2 } from "lucide-react";
import { DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { ReadOnlyNotice, useCan } from "@/components/project/project-access";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import {
  createTaskTemplate,
  deleteTaskTemplate,
  saveProjectAsTemplate,
  updateTaskTemplate,
} from "@/lib/actions";
import type { Profile, TaskTemplate } from "@/lib/data";
import { MAX_TEMPLATE_SUBTASKS } from "@/lib/templates";

const SECTION = "rounded-lg border border-zinc-200 bg-white p-4";
const HEADING = "text-sm font-semibold text-zinc-900";

export function TemplatesSettings({
  project,
  replaceable,
  taskTemplates,
  profiles,
}: {
  project: { id: string; name: string };
  // Workspace templates the viewer may overwrite ("Replace").
  replaceable: { id: string; name: string; isExample: boolean }[];
  taskTemplates: TaskTemplate[];
  profiles: Profile[];
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-gutter py-5">
      <SaveProjectTemplate project={project} replaceable={replaceable} />
      <TaskTemplates projectId={project.id} templates={taskTemplates} profiles={profiles} />
    </div>
  );
}

function SaveProjectTemplate({
  project,
  replaceable,
}: {
  project: { id: string; name: string };
  replaceable: { id: string; name: string; isExample: boolean }[];
}) {
  const canSave = useCan("admin");
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState("");
  const [startOn, setStartOn] = useState("");
  const [replaceId, setReplaceId] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);

  return (
    <section aria-labelledby="save-template-heading" className={SECTION}>
      <h2 id="save-template-heading" className={`flex items-center gap-2 ${HEADING}`}>
        <LayoutTemplate className="size-4 text-zinc-500" aria-hidden /> Save as project template
      </h2>
      <p className="mt-1 text-xs text-zinc-500">
        Copies sections, tasks (with subtasks and field values), custom fields, rules, forms, saved views, and request
        numbering into a workspace template. Assignees, members, comments, attachments, and completion are left out.{" "}
        <strong className="font-medium text-zinc-700">Everyone in the workspace can see and use templates.</strong>
      </p>
      {canSave ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const result = await saveProjectAsTemplate(project.id, {
                name,
                description: description || null,
                startOn: startOn || null,
                replaceTemplateId: replaceId || null,
              });
              if (!result.error) {
                setSavedId(result.templateId ?? null);
                notify(replaceId ? "Template replaced" : "Template saved");
              }
              return result;
            });
          }}
          className="mt-4 flex flex-col gap-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="template-name" className={DIALOG_LABEL}>
                Template name
              </label>
              <input
                id="template-name"
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="control mt-1 w-full"
              />
            </div>
            <div>
              <label htmlFor="template-anchor" className={DIALOG_LABEL}>
                Project start date
              </label>
              <input
                id="template-anchor"
                type="date"
                value={startOn}
                onChange={(e) => setStartOn(e.target.value)}
                aria-describedby="template-anchor-hint"
                className="control mt-1"
              />
              <p id="template-anchor-hint" className={DIALOG_HINT}>
                Task dates are stored as days from this date. Empty = the earliest task date.
              </p>
            </div>
          </div>
          <div>
            <label htmlFor="template-description" className={DIALOG_LABEL}>
              Description (optional)
            </label>
            <textarea
              id="template-description"
              rows={2}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="control mt-1 h-auto w-full py-1.5"
            />
          </div>
          {replaceable.length > 0 ? (
            <div>
              <label htmlFor="template-replace" className={DIALOG_LABEL}>
                Save as
              </label>
              <select
                id="template-replace"
                value={replaceId}
                onChange={(e) => setReplaceId(e.target.value)}
                className="control mt-1"
              >
                <option value="">A new template</option>
                {replaceable.map((t) => (
                  <option key={t.id} value={t.id}>
                    Replace “{t.name}”{t.isExample ? " (example)" : ""}
                  </option>
                ))}
              </select>
              <p className={DIALOG_HINT}>
                Replacing overwrites that template’s content with this project; projects already made from it don’t
                change.
              </p>
            </div>
          ) : null}
          <div className="flex items-center gap-3">
            <button type="submit" disabled={pending || !name.trim()} className="btn-primary">
              {pending ? "Saving…" : replaceId ? "Replace template" : "Save template"}
            </button>
            {savedId ? (
              <Link href="/templates" className="text-xs text-accent-700 hover:underline">
                View in Templates
              </Link>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="mt-3">
          <ReadOnlyNotice need="admin" what="save this project as a template" />
        </div>
      )}
    </section>
  );
}

function TaskTemplates({
  projectId,
  templates,
  profiles,
}: {
  projectId: string;
  templates: TaskTemplate[];
  profiles: Profile[];
}) {
  const canEdit = useCan("editor");
  const [pending, run] = useServerAction();
  const [creating, setCreating] = useState(false);

  return (
    <section aria-labelledby="task-templates-heading" className={SECTION}>
      <div className="flex items-center gap-2">
        <h2 id="task-templates-heading" className={`flex flex-1 items-center gap-2 ${HEADING}`}>
          <ListPlus className="size-4 text-zinc-500" aria-hidden /> Task templates
        </h2>
        {canEdit && !creating ? (
          <button type="button" onClick={() => setCreating(true)} className="btn-secondary">
            <Plus className="size-4" aria-hidden /> New task template
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Title, notes, subtasks, field values, and an optional assignee. Use them from “Add task” in List and Board, or
        save one from a task’s header. Tasks made from a template are normal tasks: rules and notifications run as usual.
      </p>
      {creating ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const result = await createTaskTemplate(projectId, {
                name: String(data.get("name") ?? ""),
                title: String(data.get("title") ?? ""),
              });
              if (!result.error) setCreating(false);
              return result;
            });
          }}
          className="mt-3 grid gap-2 rounded-md border border-zinc-200 p-3 sm:grid-cols-[1fr_1fr_auto]"
        >
          <label className="sr-only" htmlFor="new-task-template-name">
            Template name
          </label>
          <input id="new-task-template-name" name="name" required maxLength={100} placeholder="Template name" className="control" />
          <label className="sr-only" htmlFor="new-task-template-title">
            Task name
          </label>
          <input id="new-task-template-title" name="title" required maxLength={1000} placeholder="Task name" className="control" />
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="btn-primary">
              Add
            </button>
            <button type="button" onClick={() => setCreating(false)} className="btn-secondary">
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {templates.length === 0 ? (
        <div className="mt-3">
          <EmptyState size="inline" icon={ListPlus} title="No task templates yet">
            {canEdit
              ? "Add one here, or open a task and choose the template button in its header."
              : "Editors can add task templates for this project."}
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-md border border-zinc-200">
          {templates.map((template) => (
            <TaskTemplateRow key={template.id} template={template} profiles={profiles} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskTemplateRow({
  template,
  profiles,
  canEdit,
}: {
  template: TaskTemplate;
  profiles: Profile[];
  canEdit: boolean;
}) {
  const canDelete = useCan("admin");
  const [pending, run] = useServerAction();
  const [editing, setEditing] = useState(false);
  const assignee = template.assigneeId ? profiles.find((p) => p.id === template.assigneeId) : null;

  if (editing) {
    return (
      <li className="p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const result = await updateTaskTemplate(template.id, {
                name: String(data.get("name") ?? ""),
                title: String(data.get("title") ?? ""),
                notes: String(data.get("notes") ?? ""),
                subtasks: String(data.get("subtasks") ?? "").split("\n"),
                clearAssignee: data.get("clear_assignee") === "on",
              });
              if (!result.error) setEditing(false);
              return result;
            });
          }}
          className="flex flex-col gap-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`tt-name-${template.id}`} className={DIALOG_LABEL}>
                Template name
              </label>
              <input id={`tt-name-${template.id}`} name="name" required maxLength={100} defaultValue={template.name} className="control mt-1 w-full" />
            </div>
            <div>
              <label htmlFor={`tt-title-${template.id}`} className={DIALOG_LABEL}>
                Task name
              </label>
              <input id={`tt-title-${template.id}`} name="title" required maxLength={1000} defaultValue={template.title} className="control mt-1 w-full" />
            </div>
          </div>
          <div>
            <label htmlFor={`tt-notes-${template.id}`} className={DIALOG_LABEL}>
              Notes
            </label>
            <textarea id={`tt-notes-${template.id}`} name="notes" rows={3} defaultValue={template.notes ?? ""} className="control mt-1 h-auto w-full py-1.5" />
          </div>
          <div>
            <label htmlFor={`tt-subtasks-${template.id}`} className={DIALOG_LABEL}>
              Subtasks (one per line, up to {MAX_TEMPLATE_SUBTASKS})
            </label>
            <textarea
              id={`tt-subtasks-${template.id}`}
              name="subtasks"
              rows={Math.min(8, Math.max(3, template.subtasks.length + 1))}
              defaultValue={template.subtasks.join("\n")}
              className="control mt-1 h-auto w-full py-1.5"
            />
          </div>
          <p className="text-xs text-zinc-500">
            {template.fieldValueCount
              ? `${template.fieldValueCount} field value${template.fieldValueCount === 1 ? "" : "s"} (save the template again from a task to change them).`
              : "No field values."}
          </p>
          {assignee ? (
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" name="clear_assignee" className="size-4 accent-accent-600" />
              Stop assigning to {assignee.full_name ?? assignee.email}
            </label>
          ) : null}
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="btn-primary">
              {pending ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="btn-secondary">
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex min-h-row items-center gap-2 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-zinc-800">{template.name}</p>
        <p className="truncate text-xs text-zinc-500">
          {template.title}
          {template.subtasks.length ? ` · ${template.subtasks.length} subtask${template.subtasks.length === 1 ? "" : "s"}` : ""}
          {template.fieldValueCount ? ` · ${template.fieldValueCount} field value${template.fieldValueCount === 1 ? "" : "s"}` : ""}
          {assignee ? ` · assigns ${assignee.full_name ?? assignee.email}` : ""}
        </p>
      </div>
      {canEdit ? (
        <button type="button" onClick={() => setEditing(true)} aria-label={`Edit ${template.name}`} className="btn-icon">
          <Pencil className="size-4" />
        </button>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (window.confirm(`Delete the task template “${template.name}”? Tasks made from it are not affected.`)) {
              run(() => deleteTaskTemplate(template.id));
            }
          }}
          aria-label={`Delete ${template.name}`}
          className="btn-icon hover:bg-red-50 hover:text-red-700"
        >
          <Trash2 className="size-4" />
        </button>
      ) : null}
    </li>
  );
}
