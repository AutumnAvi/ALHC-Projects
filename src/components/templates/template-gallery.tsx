"use client";

import Link from "next/link";
import { useState } from "react";
import { FolderClosed, LayoutTemplate, ListPlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Dialog, DIALOG_LABEL } from "@/components/dialog";
import { MenuItem, Popover } from "@/components/popover";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { deleteProjectTemplate, updateProjectTemplate } from "@/lib/actions";
import type { ProjectTemplate, TaskTemplate } from "@/lib/data";
import { describeSummary } from "@/lib/templates";
import { UseTemplateDialog } from "./use-template-dialog";

export function TemplateGallery({
  templates,
  taskTemplates,
}: {
  templates: ProjectTemplate[];
  taskTemplates: (TaskTemplate & { projectName: string })[];
}) {
  const [using, setUsing] = useState<ProjectTemplate | null>(null);
  const [renaming, setRenaming] = useState<ProjectTemplate | null>(null);
  const [pending, run] = useServerAction();

  const byProject = new Map<string, { name: string; items: TaskTemplate[] }>();
  for (const t of taskTemplates) {
    const group = byProject.get(t.projectId) ?? { name: t.projectName, items: [] };
    group.items.push(t);
    byProject.set(t.projectId, group);
  }

  return (
    <div className="mx-auto max-w-4xl px-gutter py-6">
      <section aria-labelledby="project-templates-heading">
        <div className="flex items-baseline gap-2">
          <h2 id="project-templates-heading" className="text-sm font-semibold text-zinc-900">
            Project templates
          </h2>
          {templates.length > 0 ? <span className="text-xs tabular-nums text-zinc-400">{templates.length}</span> : null}
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">
          Shared with everyone in the workspace. Save one from a project’s … menu (project admins). The source
          project’s admins and workspace admins can rename, replace, or delete a template. Rules in a template always
          arrive turned off.
        </p>
        {templates.length === 0 ? (
          <div className="mt-3">
            <EmptyState icon={LayoutTemplate} title="No project templates yet">
              Open a project you run, choose … → Save as template, and it will show up here for everyone.
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {templates.map((template) => (
              <li
                key={template.id}
                className="flex flex-col rounded-lg border border-zinc-200 bg-white p-3 hover:border-zinc-300"
              >
                <div className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-50 text-accent-700"
                  >
                    <LayoutTemplate className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3 className="truncate text-sm font-medium text-zinc-900">{template.name}</h3>
                      {template.isExample ? <span className="chip shrink-0">Example</span> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500">{describeSummary(template.summary)}</p>
                  </div>
                  {template.canManage ? (
                    <Popover
                      label={`Options for template ${template.name}`}
                      align="end"
                      panelClassName="w-44 p-1.5"
                      buttonClassName="btn-icon"
                      button={<MoreHorizontal className="size-4" aria-hidden />}
                    >
                      {(close) => (
                        <>
                          <MenuItem
                            onClick={() => {
                              close();
                              setRenaming(template);
                            }}
                          >
                            <Pencil className="size-4 text-zinc-500" /> Rename
                          </MenuItem>
                          <MenuItem
                            danger
                            disabled={pending}
                            onClick={() => {
                              close();
                              if (window.confirm(`Delete the template “${template.name}”? Projects made from it are not affected.`)) {
                                run(() => deleteProjectTemplate(template.id));
                              }
                            }}
                          >
                            <Trash2 className="size-4" /> Delete
                          </MenuItem>
                        </>
                      )}
                    </Popover>
                  ) : null}
                </div>
                {template.description ? (
                  <p className="mt-2 line-clamp-3 text-xs text-zinc-600">{template.description}</p>
                ) : null}
                <div className="mt-auto flex items-center gap-2 pt-3">
                  <button type="button" onClick={() => setUsing(template)} className="btn-primary">
                    Use template
                  </button>
                  <span className="min-w-0 truncate text-2xs text-zinc-400">
                    {template.sourceProject ? (
                      <>
                        From{" "}
                        <Link href={`/projects/${template.sourceProject.id}`} className="hover:text-zinc-700 hover:underline">
                          {template.sourceProject.name}
                        </Link>
                      </>
                    ) : template.isExample ? (
                      "Edit it: use it, change the project, then Save as template → Replace"
                    ) : template.createdByName ? (
                      `Saved by ${template.createdByName}`
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="task-templates-heading" className="mt-8">
        <h2 id="task-templates-heading" className="text-sm font-semibold text-zinc-900">
          Task templates
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Per project, for projects you’re a member of. Use them from “Add task” in List and Board.
        </p>
        {byProject.size === 0 ? (
          <div className="mt-3">
            <EmptyState icon={ListPlus} title="No task templates yet">
              Open a task and use the template button in its header, or add one in a project’s Settings → Templates.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            {[...byProject.entries()].map(([projectId, group]) => (
              <div key={projectId}>
                <h3 className="flex items-center gap-1.5 text-xs font-medium text-zinc-600">
                  <FolderClosed className="size-3.5 text-zinc-400" aria-hidden />
                  <Link href={`/projects/${projectId}/settings/templates`} className="hover:text-zinc-900 hover:underline">
                    {group.name}
                  </Link>
                </h3>
                <ul className="mt-1 divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
                  {group.items.map((t) => (
                    <li key={t.id} className="flex min-h-row items-center gap-2 px-3 py-1.5 text-sm">
                      <ListPlus className="size-4 shrink-0 text-zinc-400" aria-hidden />
                      <span className="truncate font-medium text-zinc-800">{t.name}</span>
                      <span className="truncate text-xs text-zinc-500">
                        {t.title}
                        {t.subtasks.length ? ` · ${t.subtasks.length} subtask${t.subtasks.length === 1 ? "" : "s"}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {using ? <UseTemplateDialog template={using} onClose={() => setUsing(null)} /> : null}
      {renaming ? <RenameTemplateDialog template={renaming} onClose={() => setRenaming(null)} /> : null}
    </div>
  );
}

function RenameTemplateDialog({ template, onClose }: { template: ProjectTemplate; onClose: () => void }) {
  const [pending, run] = useServerAction();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? "");
  return (
    <Dialog title="Rename template" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const result = await updateProjectTemplate(template.id, { name, description });
            if (!result.error) onClose();
            return result;
          });
        }}
        className="flex flex-col gap-4"
      >
        <div>
          <label htmlFor="rename-template-name" className={DIALOG_LABEL}>
            Name
          </label>
          <input
            id="rename-template-name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="control mt-1 w-full"
          />
        </div>
        <div>
          <label htmlFor="rename-template-description" className={DIALOG_LABEL}>
            Description
          </label>
          <textarea
            id="rename-template-description"
            maxLength={2000}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="control mt-1 h-auto w-full py-1.5"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={pending || !name.trim()} className="btn-primary">
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
