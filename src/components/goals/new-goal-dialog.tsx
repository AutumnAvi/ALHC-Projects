"use client";

import { useId, useState } from "react";
import { DIALOG_HINT, DIALOG_LABEL, Dialog } from "@/components/dialog";
import { useServerAction } from "@/components/toast";
import { createGoal } from "@/lib/actions";
import {
  PROGRESS_MODES,
  PROGRESS_MODE_DESCRIPTIONS,
  PROGRESS_MODE_LABELS,
  goalEditable,
  periodPresets,
  type Goal,
  type GoalViewer,
  type ProgressMode,
} from "@/lib/goals";

export type PersonOption = { id: string; name: string };
export type TeamOption = { id: string; name: string };

// New goal (from the Goals page, opens the new goal) or new sub-goal (from a goal, stays there).
export function NewGoalDialog({
  viewer,
  people,
  teams,
  goals,
  today,
  parent,
  onClose,
}: {
  viewer: GoalViewer;
  people: PersonOption[];
  teams: TeamOption[];
  goals: Goal[];
  today: string;
  parent?: Goal;
  onClose: () => void;
}) {
  const formId = useId();
  const [pending, run] = useServerAction();
  const presets = periodPresets(today);
  const [title, setTitle] = useState("");
  const [ownerId, setOwnerId] = useState(viewer.id);
  const [teamId, setTeamId] = useState(parent?.teamId ?? "");
  const [parentId, setParentId] = useState(parent?.id ?? "");
  const [period, setPeriod] = useState(() => {
    if (parent) return parent.periodStart || parent.periodEnd ? "custom" : "";
    const current = presets.find((p) => p.label.startsWith("Q") && p.start <= today && today <= p.end);
    return current ? `${current.start}_${current.end}` : "";
  });
  const [customStart, setCustomStart] = useState(parent?.periodStart ?? "");
  const [customEnd, setCustomEnd] = useState(parent?.periodEnd ?? "");
  const [mode, setMode] = useState<ProgressMode>("manual");

  // Someone other than you can own it only if you'd still be able to edit it: you lead its team or
  // you're a workspace admin (the database enforces the same).
  const canPickOwner = viewer.isWorkspaceAdmin || (teamId !== "" && viewer.leadTeamIds.includes(teamId));
  const parents = goals.filter((g) => goalEditable(g, viewer));

  function submit() {
    const [start, end] =
      period === "custom" ? [customStart || null, customEnd || null] : period ? period.split("_") : [null, null];
    run(async () => {
      const result = await createGoal(
        {
          title,
          ownerId: canPickOwner ? ownerId : viewer.id,
          teamId: teamId || null,
          parentId: parentId || null,
          periodStart: start || null,
          periodEnd: end || null,
          progressMode: mode,
        },
        { open: !parent },
      );
      if (!result.error) onClose();
      return result;
    });
  }

  return (
    <Dialog
      title={parent ? "Add a sub-goal" : "New goal"}
      description={parent ? `Under “${parent.title}”` : "Goals are visible to everyone in the workspace."}
      onClose={onClose}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div>
          <label htmlFor={`${formId}-title`} className={DIALOG_LABEL}>
            Title
          </label>
          <input
            id={`${formId}-title`}
            data-autofocus
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="e.g. Grow social reach across facilities"
            className="control mt-1 w-full"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${formId}-team`} className={DIALOG_LABEL}>
              Team
            </label>
            <select
              id={`${formId}-team`}
              value={teamId}
              onChange={(e) => setTeamId(e.currentTarget.value)}
              className="control mt-1 w-full"
            >
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${formId}-owner`} className={DIALOG_LABEL}>
              Owner
            </label>
            <select
              id={`${formId}-owner`}
              value={canPickOwner ? ownerId : viewer.id}
              disabled={!canPickOwner}
              onChange={(e) => setOwnerId(e.currentTarget.value)}
              className="control mt-1 w-full disabled:opacity-60"
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === viewer.id ? `${p.name} (you)` : p.name}
                </option>
              ))}
            </select>
            {!canPickOwner ? <p className={DIALOG_HINT}>Team leads and workspace admins can pick someone else.</p> : null}
          </div>
        </div>

        {!parent ? (
          <div>
            <label htmlFor={`${formId}-parent`} className={DIALOG_LABEL}>
              Parent goal
            </label>
            <select
              id={`${formId}-parent`}
              value={parentId}
              onChange={(e) => setParentId(e.currentTarget.value)}
              className="control mt-1 w-full"
            >
              <option value="">None (top-level goal)</option>
              {parents.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
            <p className={DIALOG_HINT}>Only goals you can edit are listed.</p>
          </div>
        ) : null}

        <div>
          <label htmlFor={`${formId}-period`} className={DIALOG_LABEL}>
            Time period
          </label>
          <select
            id={`${formId}-period`}
            value={period}
            onChange={(e) => setPeriod(e.currentTarget.value)}
            className="control mt-1 w-full"
          >
            <option value="">No time period</option>
            {presets.map((p) => (
              <option key={p.label} value={`${p.start}_${p.end}`}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom dates…</option>
          </select>
          {period === "custom" ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`${formId}-start`}>
                Start date
              </label>
              <input
                id={`${formId}-start`}
                type="date"
                value={customStart}
                max={customEnd || undefined}
                onChange={(e) => setCustomStart(e.currentTarget.value)}
                className="control"
              />
              <span className="text-xs text-zinc-500">to</span>
              <label className="sr-only" htmlFor={`${formId}-end`}>
                End date
              </label>
              <input
                id={`${formId}-end`}
                type="date"
                value={customEnd}
                min={customStart || undefined}
                onChange={(e) => setCustomEnd(e.currentTarget.value)}
                className="control"
              />
            </div>
          ) : null}
        </div>

        <fieldset>
          <legend className={DIALOG_LABEL}>Progress</legend>
          <div className="mt-1 space-y-1.5">
            {PROGRESS_MODES.map((m) => (
              <label key={m} className="flex items-start gap-2">
                <input
                  type="radio"
                  name={`${formId}-mode`}
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="mt-0.5"
                />
                <span>
                  <span className="text-sm text-zinc-900">{PROGRESS_MODE_LABELS[m]}</span>
                  <span className="block text-xs text-zinc-500">{PROGRESS_MODE_DESCRIPTIONS[m]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={pending || !title.trim()} className="btn-primary">
            {pending ? "Creating…" : parent ? "Add sub-goal" : "Create goal"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
