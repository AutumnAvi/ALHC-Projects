"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { createProject, listProjectTeamChoices, type ActionResult } from "@/lib/actions";
import { PROJECT_VISIBILITIES, VISIBILITY_LABELS } from "@/lib/workspace";

type TeamChoice = Awaited<ReturnType<typeof listProjectTeamChoices>>[number];

// Home's inline "Start a project": name, team (the default team preselected), and privacy — the same
// choices as the New project dialog.
export function NewProjectForm() {
  const [teams, setTeams] = useState<TeamChoice[] | null>(null);
  const [, startTransition] = useTransition();
  const [state, formAction, pending] = useActionState(
    async (_: ActionResult, formData: FormData) => {
      // A successful create redirects to the new project, so the result may be undefined.
      const result: ActionResult | undefined = await createProject(formData);
      return result ?? {};
    },
    {},
  );

  useEffect(() => {
    startTransition(async () => {
      try {
        setTeams(await listProjectTeamChoices());
      } catch {
        setTeams([]);
      }
    });
  }, []);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <label htmlFor="new-project" className="sr-only">
          Project name
        </label>
        <input id="new-project" name="name" required maxLength={200} placeholder="Project name" className="control h-8 min-w-0 flex-1" />
        <button type="submit" disabled={pending} className="btn-primary h-8">
          {pending ? "Creating…" : "Create project"}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <label htmlFor="new-project-team" className="sr-only">
          Team
        </label>
        <select id="new-project-team" name="team" disabled={!teams} className="control h-8 min-w-0 flex-1">
          {!teams ? <option value="">Loading teams…</option> : null}
          {teams?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.isDefault ? " (default team)" : ""}
            </option>
          ))}
        </select>
        <label htmlFor="new-project-visibility" className="sr-only">
          Privacy
        </label>
        <select id="new-project-visibility" name="visibility" defaultValue="team" className="control h-8">
          {PROJECT_VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {VISIBILITY_LABELS[v]}
            </option>
          ))}
        </select>
      </div>
      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
