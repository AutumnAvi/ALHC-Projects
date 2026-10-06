"use client";

import { useActionState } from "react";
import { createPersonalDashboard, type ActionResult } from "@/lib/actions";

export function NewDashboardForm() {
  const [state, formAction, pending] = useActionState(async (_: ActionResult, formData: FormData) => {
    // A successful create redirects to the new dashboard, so the result may be undefined.
    const result: ActionResult | undefined = await createPersonalDashboard(formData);
    return result ?? {};
  }, {});

  return (
    <form action={formAction} className="flex flex-wrap gap-2">
      <label htmlFor="new-dashboard" className="sr-only">
        Dashboard name
      </label>
      <input
        id="new-dashboard"
        name="name"
        required
        maxLength={100}
        placeholder="Dashboard name"
        className="control h-8 min-w-0 flex-1"
      />
      <button type="submit" disabled={pending} className="btn-primary h-8">
        {pending ? "Creating…" : "New dashboard"}
      </button>
      {state.error ? (
        <p role="alert" className="w-full text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
