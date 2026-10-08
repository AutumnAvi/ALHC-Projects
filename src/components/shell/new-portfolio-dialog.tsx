"use client";

import { useActionState } from "react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { createPortfolio, type ActionResult } from "@/lib/actions";

// New portfolio as a modal (Esc or a click outside closes it), like Asana.
export function NewPortfolioDialog({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(async (_: ActionResult, formData: FormData) => {
    // A successful create redirects to the new portfolio, so the result may be undefined.
    const result: ActionResult | undefined = await createPortfolio(formData);
    return result ?? {};
  }, {});

  return (
    <Dialog title="New portfolio" description="Group projects to follow their progress and status in one place." onClose={onClose}>
      <form action={formAction} className="flex flex-col gap-3">
        <div>
          <label htmlFor="new-portfolio-name" className={DIALOG_LABEL}>
            Portfolio name
          </label>
          <input id="new-portfolio-name" name="name" data-autofocus required maxLength={100} className="control mt-1 w-full" />
          <p className={DIALOG_HINT}>You’ll own it. Add projects and invite people from the portfolio once it’s created.</p>
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
            {pending ? "Creating…" : "Create portfolio"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
