"use client";

import { useEffect, useState, useTransition } from "react";
import { DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { listProjectTeamChoices } from "@/lib/actions";
import { PROJECT_VISIBILITIES, VISIBILITY_DESCRIPTIONS, VISIBILITY_LABELS, type ProjectVisibility } from "@/lib/workspace";

type TeamChoice = Awaited<ReturnType<typeof listProjectTeamChoices>>[number];
export type Placement = { teamId: string; visibility: ProjectVisibility };

// Team + privacy for a new project, like Asana's New project form: the default team is preselected,
// and the project is public to its team unless made private. Also posts as form fields "team" and
// "visibility" when used inside a <form>.
export function ProjectPlacementFields({
  value,
  onChange,
  idPrefix,
}: {
  value: Placement;
  onChange: (next: Placement) => void;
  idPrefix: string;
}) {
  const [teams, setTeams] = useState<TeamChoice[] | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      try {
        const choices = await listProjectTeamChoices();
        setTeams(choices);
        if (!value.teamId && choices[0]) onChange({ ...value, teamId: choices[0].id });
      } catch {
        setTeams([]);
      }
    });
    // Load once; the parent keeps the choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-team`} className={DIALOG_LABEL}>
          Team
        </label>
        <select
          id={`${idPrefix}-team`}
          name="team"
          value={value.teamId}
          disabled={!teams}
          onChange={(e) => onChange({ ...value, teamId: e.currentTarget.value })}
          className="field mt-1 w-full"
        >
          {!teams ? <option value="">Loading teams…</option> : null}
          {teams?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.isDefault ? " (default)" : ""}
            </option>
          ))}
        </select>
        <p className={DIALOG_HINT}>Every project belongs to a team. You can pick the default team or one you’re on.</p>
      </div>
      <fieldset>
        <legend className={DIALOG_LABEL}>Privacy</legend>
        <div className="mt-1 flex flex-col gap-1.5">
          {PROJECT_VISIBILITIES.map((v) => (
            <label key={v} className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-200 px-3 py-2 has-checked:border-accent-500 has-checked:bg-accent-50/40">
              <input
                type="radio"
                name="visibility"
                value={v}
                checked={value.visibility === v}
                onChange={() => onChange({ ...value, visibility: v })}
                className="mt-0.5 accent-accent-600"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-900">{VISIBILITY_LABELS[v]}</span>
                <span className="block text-xs text-zinc-500">{VISIBILITY_DESCRIPTIONS[v]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );
}
