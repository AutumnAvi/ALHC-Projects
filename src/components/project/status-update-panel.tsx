"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { PROJECT_STATUS_DOT } from "@/components/project-status-badge";
import { useNotify, useServerAction } from "@/components/toast";
import { setProjectStatus } from "@/lib/actions";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, type ProjectStatus } from "@/lib/portfolios";
import { STATUS_SUMMARY_MAX, STATUS_TITLE_MAX, defaultStatusTitle } from "@/lib/project-page";
import { renderStatusTemplate, type StatusTemplate } from "@/lib/status-templates";

// Asana's status update: picking a status in the header or on the Overview opens this panel on the right
// with a title, the status, and a summary. Publishing goes through set_project_status (Editors and
// above; post_project_status_update adds the title), so the project's status, its history, portfolio
// cards, and reports all follow. Since Real features 4 a status template (Customize → Status templates)
// fills in the status, title, and summary headings; everything stays editable before publishing.
export function StatusUpdatePanel({
  projectId,
  projectName,
  initialStatus,
  templates = [],
  onClose,
}: {
  projectId: string;
  projectName: string;
  initialStatus: ProjectStatus;
  templates?: StatusTemplate[];
  onClose: () => void;
}) {
  const titleId = useId();
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const [title, setTitle] = useState(() => defaultStatusTitle());
  const [status, setStatus] = useState<ProjectStatus>(initialStatus);
  const [summary, setSummary] = useState("");
  const [templateId, setTemplateId] = useState("");
  // What the last template filled in, so picking another one only asks when the summary was edited.
  const [prefilled, setPrefilled] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnFocus?.focus?.();
    };
  }, []);

  function applyTemplate(id: string) {
    const template = templates.find((t) => t.id === id);
    const next = template ? renderStatusTemplate(template.sections) : "";
    if (summary.trim() && summary !== prefilled && !window.confirm("Replace the summary you wrote with this template?")) return;
    setTemplateId(id);
    setSummary(next);
    setPrefilled(next);
    if (template?.status) setStatus(template.status);
    setTitle(template?.title ?? defaultStatusTitle());
  }

  function publish() {
    run(async () => {
      const result = await setProjectStatus(projectId, status, summary, title);
      if (!result.error) {
        onClose();
        notify(`Status update published: ${PROJECT_STATUS_LABELS[status]}`);
      }
      return result;
    });
  }

  return (
    <div className="fixed inset-0 z-40 bg-zinc-900/10 print:hidden" onMouseDown={onClose}>
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-xl"
      >
        <header className="flex h-bar shrink-0 items-center gap-2 border-b border-zinc-200 px-5">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold text-zinc-900">
            Status update
            <span className="sr-only"> for {projectName}</span>
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="btn-icon">
            <X className="size-4" />
          </button>
        </header>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            publish();
          }}
        >
          <fieldset disabled={pending} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {templates.length ? (
              <div>
                <label htmlFor="status-update-template" className="block text-xs font-medium text-zinc-600">
                  Template
                </label>
                <select
                  id="status-update-template"
                  value={templateId}
                  onChange={(e) => applyTemplate(e.currentTarget.value)}
                  className="field mt-1 w-full"
                >
                  <option value="">No template</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div>
              <label htmlFor="status-update-title" className="block text-xs font-medium text-zinc-600">
                Title
              </label>
              <input
                id="status-update-title"
                data-autofocus
                value={title}
                maxLength={STATUS_TITLE_MAX}
                onChange={(e) => setTitle(e.currentTarget.value)}
                className="field mt-1 w-full text-base font-semibold"
              />
            </div>
            <fieldset>
              <legend className="text-xs font-medium text-zinc-600">Status</legend>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {PROJECT_STATUSES.map((value) => (
                  <label
                    key={value}
                    className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-sm transition-colors has-focus-visible:shadow-[0_0_0_3px_var(--focus-ring)] ${
                      status === value
                        ? "border-zinc-800 bg-zinc-900 font-medium text-white"
                        : "border-zinc-200 text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="status-update-status"
                      value={value}
                      checked={status === value}
                      onChange={() => setStatus(value)}
                      className="sr-only"
                    />
                    <span aria-hidden className={`size-2 rounded-full ${PROJECT_STATUS_DOT[value]}`} />
                    {PROJECT_STATUS_LABELS[value]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label htmlFor="status-update-summary" className="block text-xs font-medium text-zinc-600">
                Summary
              </label>
              <textarea
                id="status-update-summary"
                value={summary}
                rows={8}
                maxLength={STATUS_SUMMARY_MAX}
                placeholder="How is the project going? What’s done, what’s blocked, and what’s next."
                onChange={(e) => setSummary(e.currentTarget.value)}
                className="field mt-1 h-auto w-full resize-y py-2 leading-relaxed"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Everyone in the project sees it on the Overview tab; portfolios show the latest one.
              </p>
            </div>
          </fieldset>
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={pending || !title.trim()} className="btn-primary">
              {pending ? "Publishing…" : "Publish update"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
