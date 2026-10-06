"use client";

import { useActionState } from "react";
import { createTeam, type ActionResult } from "@/lib/actions";

export function NewTeamForm() {
  const [state, formAction, pending] = useActionState(async (_: ActionResult, formData: FormData) => {
    // A successful create redirects to the new team, so the result may be undefined.
    const result: ActionResult | undefined = await createTeam(formData);
    return result ?? {};
  }, {});

  return (
    <form action={formAction} className="flex flex-wrap gap-2">
      <label htmlFor="new-team" className="sr-only">
        Team name
      </label>
      <input
        id="new-team"
        name="name"
        required
        maxLength={100}
        placeholder="Team name, e.g. Social media"
        className="control h-8 min-w-0 flex-1"
      />
      <button type="submit" disabled={pending} className="btn-primary h-8">
        {pending ? "Creating…" : "Create team"}
      </button>
      {state.error ? (
        <p role="alert" className="basis-full text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
