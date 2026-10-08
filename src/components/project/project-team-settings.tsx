"use client";

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
            <select
              id="project-team"
              key={teamId}
              defaultValue={teamId}
              disabled={pending}
              onChange={(e) => {
                const select = e.currentTarget;
                run(async () => {
                  const result = await updateProjectTeam(projectId, { teamId: select.value });
                  if (result.error) select.value = teamId;
                  return result;
                });
              }}
              className="field"
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="project-visibility" className="text-xs font-medium text-zinc-600">
              Privacy
            </label>
            <select
              id="project-visibility"
              key={visibility}
              defaultValue={visibility}
              disabled={pending}
              aria-describedby="project-visibility-hint"
              onChange={(e) => {
                const select = e.currentTarget;
                run(async () => {
                  const result = await updateProjectTeam(projectId, { visibility: select.value });
                  if (result.error) select.value = visibility;
                  return result;
                });
              }}
              className="field"
            >
              {PROJECT_VISIBILITIES.map((v) => (
                <option key={v} value={v}>
                  {VISIBILITY_LABELS[v]}
                </option>
              ))}
            </select>
            <p id="project-visibility-hint" className="text-xs text-zinc-500">
              {VISIBILITY_DESCRIPTIONS[visibility]}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
