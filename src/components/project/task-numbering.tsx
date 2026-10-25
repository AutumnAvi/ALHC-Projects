"use client";

import { useState, useSyncExternalStore } from "react";
import { Hash } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useCan } from "@/components/project/project-access";
import { SmartPicker } from "@/components/smart-picker";
import { useServerAction } from "@/components/toast";
import { saveTaskNumbering } from "@/lib/actions";
import type { FieldDef } from "@/lib/fields";
import {
  emptyNumbering,
  previewRequestLabels,
  templateProblem,
  type NumberScope,
  type ResetPeriod,
  type SubtaskSeparator,
  type TaskNumbering,
} from "@/lib/request-numbers";

const KINDS = [
  { id: "task", label: "Tasks" },
  { id: "milestone", label: "Milestones" },
  { id: "approval", label: "Approvals" },
] as const;

const noSubscribe = () => () => {};

// Every IANA zone the browser knows, listed only after hydration (the server's list can differ).
function useTimeZones(current: string): string[] {
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (!mounted || typeof Intl.supportedValuesOf !== "function") return [current];
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes(current) ? zones : [current, ...zones];
}

export function TaskNumberingForm({
  projectId,
  sequence,
  sections,
  fields,
}: {
  projectId: string;
  sequence: TaskNumbering | null;
  sections: { id: string; name: string }[];
  fields: FieldDef[];
}) {
  const canEdit = useCan("editor");
  const canRenumber = useCan("admin");
  const [pending, run] = useServerAction();
  const initial = sequence ?? emptyNumbering();
  const [draft, setDraft] = useState(initial);
  // After a save the page refreshes with what the database stored: start from that (a refresh with
  // the same settings, e.g. from Realtime, keeps unsaved edits).
  const savedKey = JSON.stringify(initial);
  const [syncedKey, setSyncedKey] = useState(savedKey);
  if (savedKey !== syncedKey) {
    setSyncedKey(savedKey);
    setDraft(initial);
  }
  const [confirmOn, setConfirmOn] = useState(false);
  const [numberExisting, setNumberExisting] = useState(true);
  const [renumberOpen, setRenumberOpen] = useState(false);
  const [renumberStart, setRenumberStart] = useState(initial.startNumber);
  const [confirmation, setConfirmation] = useState("");
  const timeZones = useTimeZones(draft.timeZone);
  // A reset period or per-field counters: each counter starts at the start number, so that's the
  // number to edit; one counter for the project: the next number.
  const separateCounters = draft.resetPeriod !== "never" || Boolean(draft.counterFieldId);
  const formatError = templateProblem(draft.template, draft.resetPeriod);
  const previews = previewRequestLabels(draft.template, {
    wrapBrackets: draft.wrapBrackets,
    projectCode: draft.projectCode,
    fieldSample: fields.find((f) => f.id === draft.counterFieldId)?.name ?? "HQ",
  });
  const singleSelects = fields.filter((f) => f.fieldType === "single_select" && !f.boundToSections);

  function save(mode: "save" | "number_missing" | "renumber", next = draft) {
    // Only a number someone changed is sent (resending it on every save moved where new counters and
    // Renumber all start).
    const counters = next.resetPeriod !== "never" || Boolean(next.counterFieldId);
    const startNumber =
      mode === "renumber"
        ? renumberStart
        : counters
          ? next.startNumber !== initial.startNumber
            ? next.startNumber
            : null
          : next.nextNumber !== initial.nextNumber
            ? next.nextNumber
            : null;
    run(() =>
      saveTaskNumbering(
        projectId,
        {
          ...next,
          startNumber,
          confirmation: mode === "renumber" ? confirmation : undefined,
        },
        mode,
      ),
    );
  }

  function toggle(on: boolean) {
    if (!canEdit || pending) return;
    if (on && !draft.enabled) {
      setNumberExisting(true);
      setConfirmOn(true);
      return;
    }
    const next = { ...draft, enabled: false };
    setDraft(next);
    save("save", next);
  }

  return (
    <section id="task-numbering" className="rounded-lg border border-zinc-200 p-5" aria-labelledby="task-numbering-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="task-numbering-heading" className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Hash className="size-4 text-zinc-500" aria-hidden />
            Task numbering
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            New tasks get the next number, like <span className="font-medium text-zinc-900">{previews[0]}</span>. Turning
            this off hides the numbers and stops new ones. The numbers already stored stay, so turning it back on brings
            them back.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          aria-label="Task numbering"
          disabled={!canEdit || pending || sequence?.advanced === false}
          onClick={() => toggle(!draft.enabled)}
          className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            draft.enabled ? "bg-accent-500" : "bg-zinc-300"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${
              draft.enabled ? "translate-x-4" : ""
            }`}
          />
        </button>
      </div>
      {sequence?.advanced === false ? (
        <p className="mt-3 text-sm text-amber-800">Task numbering’s extra rules need this release’s database update.</p>
      ) : null}
      {!canEdit ? <p className="mt-3 text-sm text-zinc-500">Editors and up can change numbering.</p> : null}

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium text-zinc-800">Advanced</summary>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canEdit || formatError) return;
            save("save");
          }}
        >
          <div>
            <label htmlFor="req-template" className="text-xs font-medium text-zinc-600">
              Format
            </label>
            <input
              id="req-template"
              value={draft.template}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, template: e.currentTarget.value })}
              className="field mt-1"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Tokens: {"{n}"} counter, {"{n:4}"} zero-padded, {"{yyyy}"} {"{yy}"} {"{mm}"} created date, {"{field:Name}"}{" "}
              a field value, {"{parent}"} the parent’s label, {"{project}"} the project short code.
            </p>
            {formatError ? <p className="mt-1 text-xs text-red-700">{formatError}</p> : null}
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-800">
            <input
              type="checkbox"
              checked={draft.wrapBrackets}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, wrapBrackets: e.currentTarget.checked })}
              className="size-4 accent-accent-500"
            />
            Wrap the label in brackets
          </label>
          <p className="text-sm text-zinc-700">
            Preview: {previews.map((p) => (
              <span key={p} className="mr-2 font-medium text-zinc-900">
                {p} sample
              </span>
            ))}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {separateCounters ? (
              <div>
                <label htmlFor="req-start" className="text-xs font-medium text-zinc-600">
                  Each counter starts at
                </label>
                <input
                  id="req-start"
                  type="number"
                  min={1}
                  value={draft.startNumber}
                  disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, startNumber: Math.max(1, Number(e.currentTarget.value) || 1) })}
                  className="field mt-1"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  {draft.resetPeriod !== "never" ? "Each new year or month" : "Each field value"} starts counting here.
                </p>
              </div>
            ) : (
              <div>
                <label htmlFor="req-next" className="text-xs font-medium text-zinc-600">
                  Next number
                </label>
                <input
                  id="req-next"
                  type="number"
                  min={1}
                  value={draft.nextNumber}
                  disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, nextNumber: Math.max(1, Number(e.currentTarget.value) || 1) })}
                  className="field mt-1"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  {draft.lastNumber > 0 ? `Last issued: ${draft.lastNumber}. ` : ""}
                  Numbers only move forward, unless you renumber every task.
                </p>
              </div>
            )}
            <div>
              <label htmlFor="req-code" className="text-xs font-medium text-zinc-600">
                Project short code
              </label>
              <input
                id="req-code"
                value={draft.projectCode}
                maxLength={12}
                disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, projectCode: e.currentTarget.value })}
                className="field mt-1"
                placeholder="MKT"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="req-scope" className="text-xs font-medium text-zinc-600">
                What gets numbered
              </label>
              <SmartPicker
                id="req-scope"
                label="What gets numbered"
                value={draft.numberScope}
                disabled={!canEdit}
                onChange={(value) => setDraft({ ...draft, numberScope: value as NumberScope })}
                className="mt-1 h-9 w-full"
                options={[
                  { value: "all_tasks", label: "All tasks" },
                  { value: "form_submissions", label: "Only tasks created by forms" },
                  { value: "sections", label: "Only tasks in chosen sections" },
                  { value: "kinds", label: "Only chosen task types" },
                ]}
              />
            </div>
            <div>
              <label htmlFor="req-reset" className="text-xs font-medium text-zinc-600">
                Reset the counter
              </label>
              <SmartPicker
                id="req-reset"
                label="Reset the counter"
                value={draft.resetPeriod}
                disabled={!canEdit}
                onChange={(value) => setDraft({ ...draft, resetPeriod: value as ResetPeriod })}
                className="mt-1 h-9 w-full"
                options={[
                  { value: "never", label: "Never" },
                  { value: "yearly", label: "Every year" },
                  { value: "monthly", label: "Every month" },
                ]}
              />
            </div>
          </div>
          {draft.numberScope === "sections" ? (
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-zinc-600">Sections</legend>
              {sections.map((section) => (
                <label key={section.id} className="flex items-center gap-2 text-sm text-zinc-800">
                  <input
                    type="checkbox"
                    checked={draft.sectionIds.includes(section.id)}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        sectionIds: e.currentTarget.checked
                          ? [...draft.sectionIds, section.id]
                          : draft.sectionIds.filter((id) => id !== section.id),
                      })
                    }
                    className="size-4 accent-accent-500"
                  />
                  {section.name}
                </label>
              ))}
            </fieldset>
          ) : null}
          {draft.numberScope === "kinds" ? (
            <fieldset className="flex flex-wrap gap-3">
              <legend className="sr-only">Task types</legend>
              {KINDS.map((kind) => (
                <label key={kind.id} className="flex items-center gap-2 text-sm text-zinc-800">
                  <input
                    type="checkbox"
                    checked={draft.taskKinds.includes(kind.id)}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        taskKinds: e.currentTarget.checked
                          ? [...draft.taskKinds, kind.id]
                          : draft.taskKinds.filter((id) => id !== kind.id),
                      })
                    }
                    className="size-4 accent-accent-500"
                  />
                  {kind.label}
                </label>
              ))}
            </fieldset>
          ) : null}
          <div>
            <label htmlFor="req-field" className="text-xs font-medium text-zinc-600">
              Separate counters per field value
            </label>
            <SmartPicker
              id="req-field"
              label="Separate counters per field value"
              value={draft.counterFieldId ?? ""}
              disabled={!canEdit}
              onChange={(value) => setDraft({ ...draft, counterFieldId: value || null })}
              className="mt-1 h-9 w-full"
              options={[
                { value: "", label: "One counter for the project" },
                ...singleSelects.map((field) => ({ value: field.id, label: field.name })),
              ]}
            />
            <p className="mt-1 text-xs text-zinc-500">Each option of one single-select field gets its own counter.</p>
          </div>
          <div className="max-w-xs">
            <label htmlFor="req-zone" className="text-xs font-medium text-zinc-600">
              Time zone
            </label>
            <SmartPicker
              id="req-zone"
              label="Time zone"
              value={draft.timeZone}
              disabled={!canEdit}
              searchable
              onChange={(value) => setDraft({ ...draft, timeZone: value })}
              className="mt-1 h-9 w-full"
              options={timeZones.map((zone) => ({ value: zone, label: zone.replaceAll("_", " "), keywords: [zone] }))}
            />
            <p className="mt-1 text-xs text-zinc-500">The day a task is created in, for {"{yyyy}"} {"{yy}"} {"{mm}"} and resets.</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-800">
            <input
              type="checkbox"
              checked={draft.numberSubtasks}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, numberSubtasks: e.currentTarget.checked })}
              className="size-4 accent-accent-500"
            />
            Number subtasks under the parent (484.1, 484.2.1)
          </label>
          <div className="max-w-xs">
            <label htmlFor="req-sep" className="text-xs font-medium text-zinc-600">
              Subtask separator
            </label>
            <SmartPicker
              id="req-sep"
              label="Subtask separator"
              value={draft.subtaskSeparator}
              disabled={!canEdit || !draft.numberSubtasks}
              onChange={(value) => setDraft({ ...draft, subtaskSeparator: value as SubtaskSeparator })}
              className="mt-1 h-9 w-full"
              options={[
                { value: ".", label: "Period (484.1)" },
                { value: "-", label: "Dash (484-1)" },
                { value: "/", label: "Slash (484/1)" },
              ]}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-800">
            <input
              type="checkbox"
              checked={draft.reuseDeleted}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, reuseDeleted: e.currentTarget.checked, fillGaps: e.currentTarget.checked ? draft.fillGaps : false })}
              className="size-4 accent-accent-500"
            />
            Reuse numbers from tasks moved to the Trash after this is turned on
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-800">
            <input
              type="checkbox"
              checked={draft.fillGaps}
              disabled={!canEdit || !draft.reuseDeleted}
              onChange={(e) => setDraft({ ...draft, fillGaps: e.currentTarget.checked })}
              className="size-4 accent-accent-500"
            />
            Fill all gaps, including numbers already sitting unused
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-800">
            <input
              type="checkbox"
              checked={draft.renumberOnMove}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, renumberOnMove: e.currentTarget.checked })}
              className="size-4 accent-accent-500"
            />
            Give a task a new number when it moves into this project
          </label>
          <p className="text-xs text-zinc-500">
            By default a task keeps the number from the project that issued it. There is no permanent delete: “deleted”
            here means moved to the Trash.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={!canEdit || pending || Boolean(formatError)} className="btn-primary">
              Save numbering
            </button>
            {canRenumber ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setRenumberStart(initial.startNumber);
                  setConfirmation("");
                  setRenumberOpen(true);
                }}
                className="btn-secondary"
              >
                Renumber all
              </button>
            ) : null}
          </div>
        </form>
      </details>

      {confirmOn ? (
        <Dialog title="Turn on task numbering?" onClose={() => setConfirmOn(false)}>
          <p className="text-sm text-zinc-600">New tasks will get the next number. You can also number the tasks already in this project, oldest first.</p>
          <label className="mt-3 flex items-center gap-2 text-sm text-zinc-800">
            <input
              type="checkbox"
              checked={numberExisting}
              onChange={(e) => setNumberExisting(e.currentTarget.checked)}
              className="size-4 accent-accent-500"
            />
            Number existing tasks too?
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setConfirmOn(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={pending}
              onClick={() => {
                const next = { ...draft, enabled: true };
                setDraft(next);
                setConfirmOn(false);
                save(numberExisting ? "number_missing" : "save", next);
              }}
            >
              Turn on
            </button>
          </div>
        </Dialog>
      ) : null}

      {renumberOpen ? (
        <Dialog title="Renumber every task?" onClose={() => setRenumberOpen(false)}>
          <p className="text-sm text-zinc-600">
            This gives every task in this project a new number, in the order they were created. It cannot be undone.
          </p>
          <label htmlFor="req-renumber-start" className="mt-3 block text-xs font-medium text-zinc-600">
            Start at
          </label>
          <input
            id="req-renumber-start"
            type="number"
            min={1}
            value={renumberStart}
            onChange={(e) => setRenumberStart(Math.max(1, Number(e.currentTarget.value) || 1))}
            className="field mt-1 max-w-32"
          />
          <label htmlFor="req-confirm" className="mt-3 block text-xs font-medium text-zinc-600">
            Type RENUMBER to confirm
          </label>
          <input
            id="req-confirm"
            value={confirmation}
            onChange={(e) => setConfirmation(e.currentTarget.value)}
            className="field mt-1"
            autoComplete="off"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setRenumberOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={pending || confirmation !== "RENUMBER"}
              onClick={() => {
                setRenumberOpen(false);
                save("renumber");
              }}
            >
              Renumber all
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
