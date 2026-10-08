"use client";

import { useState } from "react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { ProjectPlacementFields, type Placement } from "@/components/projects/project-placement";
import { useServerAction } from "@/components/toast";
import { createProjectFromTemplate } from "@/lib/actions";
import { describeSummary, localIsoDate, type TemplateSummary } from "@/lib/templates";

// "Use template": name the new project and pick its start date; task dates resolve from it.
export function UseTemplateDialog({
  template,
  onClose,
}: {
  template: { id: string; name: string; summary: TemplateSummary };
  onClose: () => void;
}) {
  const [pending, run] = useServerAction();
  const [name, setName] = useState(template.name);
  const [startOn, setStartOn] = useState(() => localIsoDate());
  const [placement, setPlacement] = useState<Placement>({ teamId: "", visibility: "team" });
  const { summary } = template;

  return (
    <Dialog
      title={`Use “${template.name}”`}
      description={`${describeSummary(summary)}. You’ll own the new project.`}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(() =>
            createProjectFromTemplate(template.id, {
              name,
              startOn: startOn || null,
              teamId: placement.teamId || null,
              visibility: placement.visibility,
            }),
          );
        }}
        className="flex flex-col gap-4"
      >
        <div>
          <label htmlFor="template-project-name" className={DIALOG_LABEL}>
            Project name
          </label>
          <input
            id="template-project-name"
            data-autofocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="control mt-1 w-full"
          />
        </div>
        <div>
          <label htmlFor="template-start-on" className={DIALOG_LABEL}>
            Project start date
          </label>
          <input
            id="template-start-on"
            type="date"
            value={startOn}
            onChange={(e) => setStartOn(e.target.value)}
            aria-describedby="template-start-hint"
            className="control mt-1"
          />
          <p id="template-start-hint" className={DIALOG_HINT}>
            {summary.datedTasks > 0
              ? `${summary.datedTasks} task${summary.datedTasks === 1 ? " has" : "s have"} dates set relative to this day.`
              : "No task in this template has a date yet."}
          </p>
        </div>
        <ProjectPlacementFields value={placement} onChange={setPlacement} idPrefix="template-project" />
        {summary.rules > 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {summary.rules} rule{summary.rules === 1 ? "" : "s"} will be copied <strong>turned off</strong>. Check them in
            the Rules tab and turn them on when ready (Slack and webhook URLs need to be entered again).
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={pending || !name.trim()} className="btn-primary">
            {pending ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
