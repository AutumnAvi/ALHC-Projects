// Nov 1 notes, batch 12 (83, 84): the extra lines in a task's activity — a thin marker for every
// automation run ("⚡ Triage ran · 2:14 PM"), and what came in by email ("Created by email from Ann ·
// Spring flyer", "Comment added by email from ann@example.com"). Pure, so it is unit-tested; the pane
// draws them in components/task/task-activity.tsx.

import type { Json } from "@/lib/supabase/database.types";

export type RunMarker = {
  status: "succeeded" | "scheduled" | "skipped" | "failed";
  reason: string | null;
};

// What the marker says after the automation's name.
export function runVerb(run: RunMarker): string {
  switch (run.status) {
    case "succeeded":
      return "ran";
    case "scheduled":
      return "ran and is waiting to continue";
    case "failed":
      return "failed";
    default:
      switch (run.reason) {
        case "loop":
        case "depth_limit":
          return "was stopped by loop protection";
        case "throttled":
        case "rate_limited":
          return "hit its limit and didn’t run";
        default:
          return "was skipped";
      }
  }
}

// Whether the marker is a warning (amber) rather than a quiet line.
export function runIsProblem(run: RunMarker): boolean {
  return run.status === "failed" || run.status === "skipped";
}

// The older "created this task by forwarding an email" story says less than the email line that
// replaced it ("Created by email from … · subject"), so it is left out once that line exists.
export function isEmailCreatedStory(story: { kind: string; data: Json }): boolean {
  const d = story.data;
  return story.kind === "created" && Boolean(d && typeof d === "object" && !Array.isArray(d) && d.via === "email");
}

// Activity entries are ordered by time. A run and everything in its transaction share one timestamp, so
// at the same moment the person's own change comes first (rank 0), then the run's marker (1), then what
// the automation did — its comments and changes (2).
export const ACTIVITY_RANK = { person: 0, run: 1, automation: 2 } as const;

export function compareActivity(a: { at: string; rank: number }, b: { at: string; rank: number }): number {
  return a.at.localeCompare(b.at) || a.rank - b.rank;
}
