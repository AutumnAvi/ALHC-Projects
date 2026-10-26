"use client";

import { useId, useState } from "react";
import { ArrowDown, ArrowUp, FileText, Pencil, Plus, Trash2, X } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { PROJECT_STATUS_DOT } from "@/components/project-status-badge";
import { SmartPicker } from "@/components/smart-picker";
import { useProjectPermissions } from "@/components/project/project-access";
import { useServerAction } from "@/components/toast";
import { createStatusTemplate, deleteStatusTemplate, updateStatusTemplate } from "@/lib/actions";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, isProjectStatus, type ProjectStatus } from "@/lib/portfolios";
import { STATUS_SUMMARY_MAX } from "@/lib/project-page";
import {
  STARTER_STATUS_SECTIONS,
  STATUS_TEMPLATE_BODY_MAX,
  STATUS_TEMPLATE_HEADING_MAX,
  STATUS_TEMPLATE_NAME_MAX,
  STATUS_TEMPLATE_SECTIONS_MAX,
  STATUS_TEMPLATE_TITLE_MAX,
  STATUS_TEMPLATES_PER_PROJECT,
  renderStatusTemplate,
  statusTemplateProblem,
  type StatusTemplate,
  type StatusTemplateSection,
} from "@/lib/status-templates";

// Customize → Status templates (Real features 4): the project's saved layouts for status updates. Everyone
// in the project sees them (and picks one when writing an update, if they can post one); Editors and above
// add, edit, and remove them, like Asana. The database checks the same (RLS + the template guard).
export function StatusTemplatesView({
  projectId,
  templates,
  available,
}: {
  projectId: string;
  templates: StatusTemplate[];
  available: boolean;
}) {
  const canEdit = useProjectPermissions().canEdit;
  const [pending, run] = useServerAction();
  const [editing, setEditing] = useState<StatusTemplate | "new" | null>(null);

  if (!available) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-500">
        Status templates need this release’s database update, which isn’t applied yet.
      </p>
    );
  }

  return (
    <div>
      <p className="mb-3 text-xs text-zinc-500">
        Saved layouts for status updates: a status, a title, and section headings that fill in a new update. Pick one in
        the status update panel.
      </p>
      {canEdit ? (
        <button
          type="button"
          data-panel-focus
          disabled={templates.length >= STATUS_TEMPLATES_PER_PROJECT}
          onClick={() => setEditing("new")}
          className="btn-primary mb-3 h-8 w-full"
        >
          <Plus className="size-4" aria-hidden />
          Add template
        </button>
      ) : null}
      {templates.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-500">
          No status templates yet.{" "}
          {canEdit
            ? "Add one with the headings your team reports on, like What we’ve accomplished, What’s blocked, and Next steps."
            : "Project editors can add them."}
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center gap-2 px-3 py-2">
              <FileText className="size-4 shrink-0 text-zinc-500" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate text-sm text-zinc-900">
                  {t.status ? <span aria-hidden className={`size-2 shrink-0 rounded-full ${PROJECT_STATUS_DOT[t.status]}`} /> : null}
                  {t.name}
                </span>
                <span className="block truncate text-xs text-zinc-500">
                  {t.sections.length
                    ? t.sections.map((s) => s.heading).join(" · ")
                    : t.status
                      ? PROJECT_STATUS_LABELS[t.status]
                      : "No sections"}
                </span>
              </span>
              {canEdit ? (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(t)}
                    aria-label={`Edit ${t.name}`}
                    data-tooltip="Edit"
                    className="btn-icon size-7"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Remove the status template “${t.name}”? Updates already posted with it stay as they are.`)) {
                        run(() => deleteStatusTemplate(t.id));
                      }
                    }}
                    aria-label={`Remove ${t.name}`}
                    data-tooltip="Remove"
                    className="btn-icon size-7 hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <StatusTemplateDialog
          projectId={projectId}
          template={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function StatusTemplateDialog({
  projectId,
  template,
  onClose,
}: {
  projectId: string;
  template: StatusTemplate | null;
  onClose: () => void;
}) {
  const idPrefix = useId();
  const [pending, run] = useServerAction();
  const [name, setName] = useState(template?.name ?? "");
  const [status, setStatus] = useState<ProjectStatus | null>(template?.status ?? null);
  const [title, setTitle] = useState(template?.title ?? "");
  const [sections, setSections] = useState<StatusTemplateSection[]>(
    template ? template.sections : STARTER_STATUS_SECTIONS.map((s) => ({ ...s })),
  );
  const problem = statusTemplateProblem({ name, title: title || null, sections });
  const summary = renderStatusTemplate(sections);

  function patch(index: number, change: Partial<StatusTemplateSection>) {
    setSections((current) => current.map((s, i) => (i === index ? { ...s, ...change } : s)));
  }
  function move(index: number, delta: -1 | 1) {
    setSections((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function save() {
    const input = { name, status, title: title.trim() || null, sections };
    run(async () => {
      const result = template ? await updateStatusTemplate(template.id, input) : await createStatusTemplate(projectId, input);
      if (!result.error) onClose();
      return result;
    });
  }

  return (
    <Dialog title={template ? "Edit status template" : "New status template"} onClose={onClose} width="max-w-xl">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) save();
        }}
      >
        <fieldset disabled={pending} className="space-y-4">
          <div>
            <label htmlFor={`${idPrefix}-name`} className="block text-xs font-medium text-zinc-600">
              Template name
            </label>
            <input
              id={`${idPrefix}-name`}
              data-autofocus
              value={name}
              maxLength={STATUS_TEMPLATE_NAME_MAX}
              placeholder="Weekly update"
              onChange={(e) => setName(e.currentTarget.value)}
              className="field mt-1 w-full"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${idPrefix}-status`} className="block text-xs font-medium text-zinc-600">
                Status
              </label>
              <SmartPicker
                id={`${idPrefix}-status`}
                label="Status"
                value={status ?? ""}
                onChange={(next) => setStatus(isProjectStatus(next) ? next : null)}
                className="mt-1 h-9 w-full"
                options={[
                  { value: "", label: "Keep the status picked" },
                  ...PROJECT_STATUSES.map((s) => ({
                    value: s,
                    label: PROJECT_STATUS_LABELS[s],
                    icon: <span className={`size-2 rounded-full ${PROJECT_STATUS_DOT[s]}`} />,
                  })),
                ]}
              />
            </div>
            <div>
              <label htmlFor={`${idPrefix}-title`} className="block text-xs font-medium text-zinc-600">
                Update title <span className="font-normal text-zinc-400">(optional)</span>
              </label>
              <input
                id={`${idPrefix}-title`}
                value={title}
                maxLength={STATUS_TEMPLATE_TITLE_MAX}
                placeholder="Status update — today’s date"
                onChange={(e) => setTitle(e.currentTarget.value)}
                className="field mt-1 w-full"
              />
            </div>
          </div>
          <fieldset>
            <legend className="text-xs font-medium text-zinc-600">Sections</legend>
            <ol className="mt-1.5 space-y-2">
              {sections.map((section, index) => (
                <li key={index} className="rounded-lg border border-zinc-200 p-2">
                  <div className="flex items-center gap-1">
                    <input
                      aria-label={`Section ${index + 1} heading`}
                      value={section.heading}
                      maxLength={STATUS_TEMPLATE_HEADING_MAX}
                      placeholder="Heading"
                      onChange={(e) => patch(index, { heading: e.currentTarget.value })}
                      className="control min-w-0 flex-1 font-medium"
                    />
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move section ${index + 1} up`}
                      data-tooltip="Move up"
                      className="btn-icon size-7"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === sections.length - 1}
                      aria-label={`Move section ${index + 1} down`}
                      data-tooltip="Move down"
                      className="btn-icon size-7"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setSections((current) => current.filter((_, i) => i !== index))}
                      aria-label={`Remove section ${index + 1}`}
                      data-tooltip="Remove section"
                      className="btn-icon size-7 hover:bg-red-50 hover:text-red-700"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <textarea
                    aria-label={`Section ${index + 1} text`}
                    value={section.body}
                    maxLength={STATUS_TEMPLATE_BODY_MAX}
                    rows={2}
                    placeholder="Text that starts under this heading (optional), e.g. a checklist"
                    onChange={(e) => patch(index, { body: e.currentTarget.value })}
                    className="field mt-1.5 h-auto w-full resize-y py-1.5 text-sm"
                  />
                </li>
              ))}
            </ol>
            {sections.length < STATUS_TEMPLATE_SECTIONS_MAX ? (
              <button
                type="button"
                onClick={() => setSections((current) => [...current, { heading: "", body: "" }])}
                className="btn-ghost mt-2 h-7 text-xs"
              >
                <Plus className="size-3.5" aria-hidden />
                Add section
              </button>
            ) : null}
          </fieldset>
          <p className="text-xs text-zinc-500">
            The summary starts with {summary.length.toLocaleString("en-US")} of {STATUS_SUMMARY_MAX.toLocaleString("en-US")}{" "}
            characters.
          </p>
        </fieldset>
        {problem && name.trim() ? (
          <p role="alert" className="text-xs text-red-700">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={pending || Boolean(problem)} className="btn-primary">
            {pending ? "Saving…" : template ? "Save template" : "Create template"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
