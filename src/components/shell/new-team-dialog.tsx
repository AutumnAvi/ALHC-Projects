"use client";

import { useActionState } from "react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { createTeam, type ActionResult } from "@/lib/actions";

// Create → Team: the Teams page's "start a team" form as a modal. You become its first lead.
export function NewTeamDialog({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(async (_: ActionResult, formData: FormData) => {
    // A successful create redirects to the new team, so the result may be undefined.
    const result: ActionResult | undefined = await createTeam(formData);
    return result ?? {};
  }, {});

  return (
    <Dialog title="New team" description="Group people who work together. You’ll be its first lead." onClose={onClose}>
      <form action={formAction} className="flex flex-col gap-3">
        <div>
          <label htmlFor="new-team-name" className={DIALOG_LABEL}>
            Team name
          </label>
          <input
            id="new-team-name"
            name="name"
            data-autofocus
            required
            maxLength={100}
            placeholder="e.g. Social media"
            className="field mt-1 w-full"
          />
        </div>
        <div>
          <label htmlFor="new-team-description" className={DIALOG_LABEL}>
            Description <span className="font-normal text-zinc-400">(optional)</span>
          </label>
          <textarea
            id="new-team-description"
            name="description"
            rows={3}
            maxLength={2000}
            className="field mt-1 h-auto w-full py-2"
          />
          <p className={DIALOG_HINT}>Teams never open projects by themselves; add a team to a project from its Members page.</p>
        </div>
        {state.error ? (
          <p role="alert" className="text-xs text-red-600">
            {state.error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={pending} className="btn-primary">
            {pending ? "Creating…" : "Create team"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
