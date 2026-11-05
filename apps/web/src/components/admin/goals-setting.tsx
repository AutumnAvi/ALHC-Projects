"use client";

import { useOptimistic } from "react";
import { useServerAction } from "@/components/toast";
import { setGoalsEnabled } from "@/lib/actions/workspace";

// Nov 2 notes (batch 13, note 88): Admin console → Organization → "Use goals in this workspace" (off by
// default). Off hides Goals from the sidebar, the Create menu, project and team Overviews, and the Goals
// pages; every goal, its links, and its status updates are kept for when it's on.
export function GoalsSetting({ enabled }: { enabled: boolean }) {
  const [pending, run] = useServerAction();
  const [on, setOn] = useOptimistic(enabled);
  return (
    <label className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          run(() => setGoalsEnabled(next), () => setOn(next));
        }}
        className="mt-0.5 size-4 shrink-0 accent-accent-600"
      />
      <span>
        <span className="block text-sm font-medium text-zinc-900">Use goals in this workspace</span>
        <span className="block text-sm text-zinc-600">
          {on
            ? "Goals show in the sidebar, the Create menu, and on project and team Overviews."
            : "Off: Goals are hidden everywhere in the app. Nothing is removed — existing goals, their links, and status updates come back when you turn this on."}
        </span>
      </span>
    </label>
  );
}
