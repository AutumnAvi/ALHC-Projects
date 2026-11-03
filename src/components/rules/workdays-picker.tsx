"use client";

import { SmartPicker } from "@/components/smart-picker";
import { WORKDAYS_CHOICES, workdaysChoiceOf, type WorkdaysScope } from "@/lib/rule-workdays";
import { describeWorkWeek } from "@/lib/workdays";

type Step = Record<string, unknown>;

// Nov 3 notes (batch 19, 140): which workdays a business-day step counts — the organization's (Admin console →
// Organization) or the automation owner's own (Settings → Profile → My workdays). Left on "Default" it's the
// owner's own on My Tasks and on a project only its owner is in, the organization's elsewhere.
export function WorkdaysPicker({
  id,
  step,
  scope,
  orgWorkWeek,
  onChange,
}: {
  id: string;
  step: Step;
  scope: WorkdaysScope;
  orgWorkWeek: readonly number[];
  onChange: (next: Step) => void;
}) {
  const value = typeof step.workdays === "string" ? step.workdays : "";
  const options = WORKDAYS_CHOICES(scope).map((choice) => ({
    value: choice.value,
    label: choice.value === "org" ? `${choice.label} (${describeWorkWeek(orgWorkWeek)})` : choice.label,
    description: choice.description,
  }));
  return (
    <SmartPicker
      id={id}
      label="Whose workdays"
      value={value}
      options={options}
      onChange={(v) => {
        const rest = { ...step };
        delete rest.workdays;
        const choice = workdaysChoiceOf(v);
        onChange(choice ? { ...rest, workdays: choice } : rest);
      }}
      variant="chip"
    />
  );
}
