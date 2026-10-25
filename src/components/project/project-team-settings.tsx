"use client";

import { useState } from "react";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import { useServerAction } from "@/components/toast";
import { updateProjectTeam } from "@/lib/actions";
import { PROJECT_VISIBILITIES, VISIBILITY_DESCRIPTIONS, VISIBILITY_LABELS, type ProjectVisibility } from "@/lib/workspace";

// Settings → General → Team and privacy (Admin+). Moving to another team needs you to be on it (the
// default team is open to everyone); the database checks.
export function ProjectTeamSettings({
  projectId,
  teamId,
  visibility,
  teams,
}: {
  projectId: string;
  teamId: string;
  visibility: ProjectVisibility;
  teams: { id: string; name: string; isDefault: boolean }[];
}) {
  const [pending, run] = useServerAction();
  return (
    <div className="mx-auto max-w-3xl px-gutter pt-5">
      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="team-privacy-heading">
        <h2 id="team-privacy-heading" className="text-sm font-semibold text-zinc-900">
          Team and privacy
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Every project belongs to a team. Public projects can be found and joined by everyone on the team; private
          ones only by the people you invite. Workspace admins don’t see private projects either.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="project-team" className="text-xs font-medium text-zinc-600">
              Team
            </label>
            <SavedPicker
              key={teamId}
              id="project-team"
              label="Team"
              saved={teamId}
              disabled={pending}
              searchable
              options={teams.map((t) => ({ value: t.id, label: `${t.name}${t.isDefault ? " (default)" : ""}` }))}
              onSave={(next, revert) =>
                run(async () => {
                  const result = await updateProjectTeam(projectId, { teamId: next });
                  if (result.error) revert();
                  return result;
                })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="project-visibility" className="text-xs font-medium text-zinc-600">
              Privacy
            </label>
            <SavedPicker
              key={visibility}
              id="project-visibility"
              label="Privacy"
              saved={visibility}
              disabled={pending}
              describedBy="project-visibility-hint"
              options={PROJECT_VISIBILITIES.map((v) => ({ value: v, label: VISIBILITY_LABELS[v], description: VISIBILITY_DESCRIPTIONS[v] }))}
              onSave={(next, revert) =>
                run(async () => {
                  const result = await updateProjectTeam(projectId, { visibility: next });
                  if (result.error) revert();
                  return result;
                })
              }
            />
            <p id="project-visibility-hint" className="text-xs text-zinc-500">
              {VISIBILITY_DESCRIPTIONS[visibility]}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

// Shows the choice at once and puts the saved value back when the database refuses it.
function SavedPicker({
  id,
  label,
  saved,
  options,
  disabled,
  searchable,
  describedBy,
  onSave,
}: {
  id: string;
  label: string;
  saved: string;
  options: SmartOption[];
  disabled: boolean;
  searchable?: boolean;
  describedBy?: string;
  onSave: (next: string, revert: () => void) => void;
}) {
  const [shown, setShown] = useState(saved);
  return (
    <SmartPicker
      id={id}
      label={label}
      value={shown}
      disabled={disabled}
      searchable={searchable}
      aria-describedby={describedBy}
      className="h-9 w-full"
      options={options}
      onChange={(next) => {
        if (next === shown) return;
        setShown(next);
        onSave(next, () => setShown(saved));
      }}
    />
  );
}
