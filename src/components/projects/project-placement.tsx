"use client";

import { useEffect, useState, useTransition } from "react";
import { DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { SmartPicker } from "@/components/smart-picker";
import { listProjectTeamChoices } from "@/lib/actions";
import { PROJECT_VISIBILITIES, VISIBILITY_DESCRIPTIONS, VISIBILITY_LABELS, type ProjectVisibility } from "@/lib/workspace";

export type TeamChoice = Awaited<ReturnType<typeof listProjectTeamChoices>>[number];
export type Placement = { teamId: string; visibility: ProjectVisibility };

// Team + privacy for a new project, like Asana's New project form: the default team is preselected
// (or the team page it was opened from, when you can put projects there), and the project is public to
// its team unless made private. Also posts as form fields "team" and "visibility" when used inside a
// <form>.
export function ProjectPlacementFields({
  value,
  onChange,
  idPrefix,
  onTeams,
}: {
  value: Placement;
  onChange: (next: Placement) => void;
  idPrefix: string;
  // The team choices once loaded (the New project preview shows the team's name).
  onTeams?: (teams: TeamChoice[]) => void;
}) {
  const [teams, setTeams] = useState<TeamChoice[] | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      try {
        const choices = await listProjectTeamChoices();
        setTeams(choices);
        onTeams?.(choices);
        // The default team (listed first) unless the opener's team is one you can put projects in; a
        // team page you aren't on falls back to it rather than leaving a team no option matches.
        const fallback = choices[0]?.id ?? "";
        if (!choices.some((c) => c.id === value.teamId) && value.teamId !== fallback) {
          onChange({ ...value, teamId: fallback });
        }
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
        <SmartPicker
          id={`${idPrefix}-team`}
          label="Team"
          name="team"
          value={value.teamId}
          disabled={!teams}
          placeholder={teams ? "Choose a team…" : "Loading teams…"}
          searchable={teams ? teams.length > 7 : false}
          onChange={(teamId) => onChange({ ...value, teamId })}
          className="mt-1 h-9 w-full"
          options={(teams ?? []).map((t) => ({ value: t.id, label: `${t.name}${t.isDefault ? " (default)" : ""}` }))}
        />
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
