"use client";

import { useActionState } from "react";
import { createProject, type ActionResult } from "@/lib/actions";

export function NewProjectForm({
  compact = false,
  onDone,
}: {
  compact?: boolean;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    async (_: ActionResult, formData: FormData) => {
      // A successful create redirects to the new project, so the result may be undefined.
      const result: ActionResult | undefined = await createProject(formData);
      if (!result?.error) onDone?.();
      return result ?? {};
    },
    {},
  );

  return (
    <form action={formAction} className={compact ? "flex flex-col gap-1.5" : "flex gap-2"}>
      <label htmlFor={compact ? "new-project-compact" : "new-project"} className="sr-only">
        Project name
      </label>
      <input
        id={compact ? "new-project-compact" : "new-project"}
        name="name"
        required
        maxLength={200}
        autoFocus={compact}
        placeholder="Project name"
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
        {pending ? "Creating…" : "Create project"}
      </button>
      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
