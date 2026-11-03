// Nov 3 notes (batch 19, 140): whose workdays a business-day automation step counts. Mirrors
// public.rule_work_days() / rule_personal_by_default() in 20261103020000_nov3_batch19_a.sql:
//   "org"       the organization's workweek (workspaces.work_week, Admin console → Organization);
//   "personal"  the automation owner's own (profile_preferences.work_week, Settings → Profile), or the
//               organization's when they haven't set any;
//   left out    personal on My Tasks automations and on a project only its owner is in, the organization's
//               on shared projects and portfolios.

export type WorkdaysChoice = "org" | "personal";
export type WorkdaysScope = "project" | "portfolio" | "my_tasks";

export const workdaysChoiceOf = (value: unknown): WorkdaysChoice | null =>
  value === "org" || value === "personal" ? value : null;

export function WORKDAYS_CHOICES(scope: WorkdaysScope): { value: "" | WorkdaysChoice; label: string; description: string }[] {
  const own = scope === "my_tasks" ? "My own workdays" : "The owner’s own workdays";
  const fallback =
    scope === "my_tasks"
      ? "Your own workdays (Settings → Profile), or the organization’s if you haven’t set any."
      : scope === "portfolio"
        ? "The organization’s workdays."
        : "The owner’s own on a project only they're in, the organization’s on a shared project.";
  return [
    { value: "", label: "Default workdays", description: fallback },
    { value: "org", label: "The organization’s workdays", description: "Set by workspace admins in Admin console → Organization." },
    { value: "personal", label: own, description: "Set in Settings → Profile → My workdays (the organization’s if none are set)." },
  ];
}

// Which week a step counts, for previews in the builder: the explicit choice, else the default for where the
// automation lives.
export function workdaysFor(
  choice: unknown,
  scope: WorkdaysScope,
  { personalProject, orgWeek, ownWeek }: { personalProject: boolean; orgWeek: readonly number[]; ownWeek: readonly number[] | null },
): readonly number[] {
  const picked = workdaysChoiceOf(choice) ?? (scope === "my_tasks" || (scope === "project" && personalProject) ? "personal" : "org");
  return picked === "personal" ? (ownWeek ?? orgWeek) : orgWeek;
}
