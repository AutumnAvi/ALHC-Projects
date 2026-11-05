// Nov 3 notes (batch 19, 140): whose workdays a business-day automation step counts. Mirrors
// public.rule_work_days() / rule_personal_by_default() in 20261103020000_nov3_batch19_a.sql:
//   "org"       the organization's workweek (workspaces.work_week, Admin console → Organization);
//   "personal"  the automation owner's own (profile_preferences.work_week, Settings → Profile), or the
//               organization's when they haven't set any;
//   left out    personal on My Tasks automations and on a project only its owner is in, the organization's
//               on shared projects and portfolios.
// Nov 4 notes (batch 20, 150): the picker offers just the two choices, each with its actual days; a step that
// leaves it out shows the default for where the automation lives as the chosen one.

import { normalizeWorkWeek, shortWorkWeek } from "./workdays";

export type WorkdaysChoice = "org" | "personal";
export type WorkdaysScope = "project" | "portfolio" | "my_tasks";

export const workdaysChoiceOf = (value: unknown): WorkdaysChoice | null =>
  value === "org" || value === "personal" ? value : null;

// Where the automation lives decides the default: mine on My Tasks and on a project only its owner is in,
// the organization's on shared projects and portfolios.
export function defaultWorkdaysChoice(scope: WorkdaysScope, personalProject = false): WorkdaysChoice {
  return scope === "my_tasks" || (scope === "project" && personalProject) ? "personal" : "org";
}

// The choice a step counts: its own, else the default.
export function effectiveWorkdaysChoice(value: unknown, scope: WorkdaysScope, personalProject = false): WorkdaysChoice {
  return workdaysChoiceOf(value) ?? defaultWorkdaysChoice(scope, personalProject);
}

export function WORKDAYS_CHOICES(
  scope: WorkdaysScope,
  { orgWeek, ownWeek }: { orgWeek: readonly number[]; ownWeek?: readonly number[] | null },
): { value: WorkdaysChoice; label: string; description: string }[] {
  const org = shortWorkWeek(normalizeWorkWeek([...orgWeek]));
  const own = ownWeek && ownWeek.length ? shortWorkWeek(normalizeWorkWeek([...ownWeek])) : null;
  const whose = scope === "my_tasks" ? "Yours" : "The automation owner’s";
  return [
    {
      value: "org",
      label: `Organization workdays (${org})`,
      description: "Set by workspace admins in Admin console → Organization.",
    },
    {
      value: "personal",
      label: `My workdays (${own ?? org})`,
      description: own
        ? `${whose}, from Settings → Profile → My workdays.`
        : `You haven’t set your own yet, so this is the organization’s (Settings → Profile → My workdays).`,
    },
  ];
}

// Which week a step counts, for previews in the builder: the explicit choice, else the default for where the
// automation lives.
export function workdaysFor(
  choice: unknown,
  scope: WorkdaysScope,
  { personalProject, orgWeek, ownWeek }: { personalProject: boolean; orgWeek: readonly number[]; ownWeek: readonly number[] | null },
): readonly number[] {
  const picked = effectiveWorkdaysChoice(choice, scope, personalProject);
  return picked === "personal" ? (ownWeek ?? orgWeek) : orgWeek;
}
