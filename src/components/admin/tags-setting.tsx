"use client";

import { useOptimistic } from "react";
import { useServerAction } from "@/components/toast";
import { setTagsEnabled } from "@/lib/actions";

// Oct 26 notes (batch 3): Admin console → Tags → "Use tags in this workspace" (off by default). Off hides
// tags everywhere in the app (task pane, List column, filters, grouping, rules, search, reports, bulk
// edits); tags, the tasks they're on, and rules or views that use them are all kept for when it's on.
export function TagsSetting({ enabled }: { enabled: boolean }) {
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
          run(() => setTagsEnabled(next), () => setOn(next));
        }}
        className="mt-0.5 size-4 shrink-0 accent-accent-600"
      />
      <span>
        <span className="block text-sm font-medium text-zinc-900">Use tags in this workspace</span>
        <span className="block text-sm text-zinc-600">
          {on
            ? "Tags show on tasks, in List and Board, filters, grouping, rules, search, and reports."
            : "Off: tags are hidden everywhere in the app. Nothing is removed — the tags below, the tasks they’re on, and rules or views that use them come back when you turn this on."}
        </span>
      </span>
    </label>
  );
}
