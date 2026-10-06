"use client";

import { useState } from "react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { useServerAction } from "@/components/toast";
import { duplicateProject } from "@/lib/actions";
import { DEFAULT_DUPLICATE_OPTIONS, type DuplicateOptions } from "@/lib/templates";

type Toggle = Exclude<keyof DuplicateOptions, "startOn">;

const TOGGLES: { key: Toggle; label: string; hint: string; needsTasks?: boolean }[] = [
  { key: "tasks", label: "Tasks", hint: "With subtasks, field values, dependencies, and completion state" },
  { key: "assignees", label: "Assignees", hint: "Kept only for people who are members of the copy", needsTasks: true },
  { key: "dates", label: "Due and start dates", hint: "Times and repeat rules are not copied", needsTasks: true },
  { key: "rules", label: "Rules", hint: "Copied turned off; Slack and webhook URLs are not copied" },
  { key: "forms", label: "Forms", hint: "Copied closed to new responses" },
  { key: "members", label: "Members", hint: "Same roles; owners join as admins and you stay the owner" },
];

// Sections, custom fields, saved views, and Req # settings are always copied. The copy fires no rules
// and notifies nobody; it gets one "duplicated" project story.
export function DuplicateProjectDialog({
  project,
  onClose,
}: {
  project: { id: string; name: string };
  onClose: () => void;
}) {
  const [pending, run] = useServerAction();
  const [name, setName] = useState(`${project.name} (copy)`.slice(0, 200));
  const [options, setOptions] = useState<DuplicateOptions>(DEFAULT_DUPLICATE_OPTIONS);
  const [shiftDates, setShiftDates] = useState(false);

  return (
    <Dialog
      title={`Duplicate “${project.name}”`}
      description="Sections, custom fields, saved views, and request numbering are always copied. You’ll own the copy."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(() =>
            duplicateProject(project.id, {
              name,
              options: { ...options, startOn: shiftDates ? options.startOn : null },
            }),
          );
        }}
        className="flex flex-col gap-4"
      >
        <div>
          <label htmlFor="duplicate-name" className={DIALOG_LABEL}>
            New project name
          </label>
          <input
            id="duplicate-name"
            data-autofocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="control mt-1 w-full"
          />
        </div>
        <fieldset className="m-0 border-0 p-0">
          <legend className={DIALOG_LABEL}>Include</legend>
          <div className="mt-1.5 flex flex-col gap-2">
            {TOGGLES.map((toggle) => {
              const disabled = toggle.needsTasks && !options.tasks;
              return (
                <label key={toggle.key} className={`flex items-start gap-2 ${disabled ? "opacity-50" : ""}`}>
                  <input
                    type="checkbox"
                    checked={options[toggle.key] && !disabled}
                    disabled={disabled}
                    onChange={(e) => setOptions((o) => ({ ...o, [toggle.key]: e.target.checked }))}
                    className="mt-0.5 size-4 accent-accent-600"
                  />
                  <span>
                    <span className="block text-sm text-zinc-800">{toggle.label}</span>
                    <span className="block text-xs text-zinc-500">{toggle.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {options.tasks && options.dates ? (
          <div>
            <label className="flex items-center gap-2 text-sm text-zinc-800">
              <input
                type="checkbox"
                checked={shiftDates}
                onChange={(e) => setShiftDates(e.target.checked)}
                className="size-4 accent-accent-600"
              />
              Shift dates to a new start date
            </label>
            {shiftDates ? (
              <>
                <label htmlFor="duplicate-start-on" className="sr-only">
                  New start date
                </label>
                <input
                  id="duplicate-start-on"
                  type="date"
                  required
                  value={options.startOn ?? ""}
                  onChange={(e) => setOptions((o) => ({ ...o, startOn: e.target.value || null }))}
                  className="control mt-1.5"
                />
                <p className={DIALOG_HINT}>
                  The earliest task date moves to this day and every other date moves by the same number of days.
                </p>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !name.trim() || (shiftDates && options.tasks && options.dates && !options.startOn)}
            className="btn-primary"
          >
            {pending ? "Duplicating…" : "Duplicate"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
