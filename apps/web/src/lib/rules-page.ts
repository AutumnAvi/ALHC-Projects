// The project Automations page's tabs (Nov 3 notes, batch 18, 137): the automations, the templates, and
// the run history of every automation (not only inside each automation's builder). Server-safe.

export type RulesPageView = "automations" | "templates" | "history";

// How many runs the History tab shows (the page reads this many; the list tab reads RECENT_RUNS).
export const HISTORY_LIMIT = 200;
export const RECENT_RUNS = 50;

export function rulesPageView(value: unknown): RulesPageView {
  return value === "templates" || value === "history" ? value : "automations";
}

// Nov 11 notes (190): `runId` opens History at that run, expanded (with `ruleId`, filtered to its
// automation). The same links as runHistoryHref / runHref in @alhc/core/rule-feedback.
export function rulesPageHref(projectId: string, view: RulesPageView, ruleId?: string | null, runId?: string | null) {
  const base = `/projects/${projectId}/rules`;
  if (view === "automations") return base;
  return `${base}?view=${view}${ruleId ? `&rule=${encodeURIComponent(ruleId)}` : ""}${
    view === "history" && runId ? `&run=${encodeURIComponent(runId)}` : ""
  }`;
}
