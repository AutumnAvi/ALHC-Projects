"use client";

import { useActionState } from "react";
import { createPortfolio, type ActionResult } from "@/lib/actions";

export function NewPortfolioForm({
  compact = false,
  onDone,
}: {
  compact?: boolean;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    async (_: ActionResult, formData: FormData) => {
      // A successful create redirects to the new portfolio, so the result may be undefined.
      const result: ActionResult | undefined = await createPortfolio(formData);
      if (!result?.error) onDone?.();
      return result ?? {};
    },
    {},
  );
  const inputId = compact ? "new-portfolio-compact" : "new-portfolio";

  return (
    <form action={formAction} className={compact ? "flex flex-col gap-1.5" : "flex gap-2"}>
      <label htmlFor={inputId} className="sr-only">
        Portfolio name
      </label>
      <input
        id={inputId}
        name="name"
        required
        maxLength={100}
        autoFocus={compact}
        placeholder="Portfolio name"
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone?.();
        }}
        className="control h-8 min-w-0 flex-1"
      />
      <button
        type="submit"
        disabled={pending}
        className="btn-primary h-8"
      >
        {pending ? "Creating…" : "Create portfolio"}
      </button>
      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
