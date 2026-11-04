"use client";

import { SmartPicker } from "@/components/smart-picker";
import { WORKDAYS_CHOICES, effectiveWorkdaysChoice, workdaysChoiceOf, type WorkdaysScope } from "@/lib/rule-workdays";

type Step = Record<string, unknown>;

// Nov 3 notes (batch 19, 140): which workdays a business-day step counts — the organization's (Admin console →
// Organization) or the automation owner's own (Settings → Profile → My workdays). Nov 4 notes (batch 20, 150):
// two choices, each naming its days ("Sun–Thu"); a step that hasn't picked shows its default as chosen — mine
// on My Tasks and on a project only its owner is in, the organization's elsewhere. Labels wrap, never cut off.
export function WorkdaysPicker({
  id,
  step,
  scope,
  orgWorkWeek,
  ownWorkWeek = null,
  personalProject = false,
  onChange,
}: {
  id: string;
  step: Step;
  scope: WorkdaysScope;
  orgWorkWeek: readonly number[];
  // The viewer's own workdays (null = not set: the organization's).
  ownWorkWeek?: readonly number[] | null;
  // A project only its owner is in (the default is then "mine").
  personalProject?: boolean;
  onChange: (next: Step) => void;
}) {
  const value = effectiveWorkdaysChoice(step.workdays, scope, personalProject);
  const options = WORKDAYS_CHOICES(scope, { orgWeek: orgWorkWeek, ownWeek: ownWorkWeek });
  return (
    <SmartPicker
      id={id}
      label="Whose workdays"
      value={value}
      options={options}
      onChange={(v) => {
        const choice = workdaysChoiceOf(v);
        if (choice) onChange({ ...step, workdays: choice });
      }}
      variant="chip"
      panelWidth={340}
      wrapLabels
    />
  );
}
