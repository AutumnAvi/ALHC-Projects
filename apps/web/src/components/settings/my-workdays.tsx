"use client";

import { useState } from "react";
import { useNotify, useServerAction } from "@/components/toast";
import { setMyWorkWeek } from "@/lib/actions/me";
import { WEEKDAYS, describeWorkWeek } from "@alhc/core/workdays";

// Nov 3 notes (batch 19, 140): Settings → Profile → My workdays. The organization's workweek (Admin console →
// Organization) is what shared projects count; the person's own days are what their My Tasks automations and
// their personal projects' automations count (each automation step can switch). Null = the organization's.
export function MyWorkdays({ own, organization }: { own: number[] | null; organization: number[] }) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const [saved, setSaved] = useState<number[] | null>(own);
  const [days, setDays] = useState<number[]>(own ?? organization);
  const shown = saved ?? organization;
  const changed = days.length !== shown.length || days.some((d, i) => d !== shown[i]);

  function toggle(day: number) {
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b)));
  }

  const save = (next: number[] | null) =>
    run(async () => {
      const result = await setMyWorkWeek(next);
      if (!result.error) {
        setSaved(next);
        setDays(next ?? organization);
        notify(next ? `Your workdays: ${describeWorkWeek(next)}` : `You count the organization’s workdays (${describeWorkWeek(organization)})`);
      }
      return result;
    });

  return (
    <div className="space-y-2">
      <div role="group" aria-label="My workdays" className="flex flex-wrap gap-1">
        {WEEKDAYS.map((day) => {
          const on = days.includes(day.value);
          return (
            <button
              key={day.value}
              type="button"
              aria-pressed={on}
              aria-label={day.label}
              disabled={pending}
              onClick={() => toggle(day.value)}
              className={`h-7 min-w-10 rounded-md border px-2 text-xs font-medium transition-colors ${
                on ? "border-accent-500 bg-accent-50 text-accent-700 hover:bg-accent-100" : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              {day.short}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-zinc-500" aria-live="polite">
        {saved
          ? `Your own: ${describeWorkWeek(saved)}. The organization’s: ${describeWorkWeek(organization)}.`
          : `You count the organization’s workdays (${describeWorkWeek(organization)}).`}{" "}
        Automations on your My tasks and on projects only you are in count your days for business days; shared projects
        count the organization’s. Each automation can switch.
      </p>
      {changed || saved ? (
        <div className="flex flex-wrap items-center gap-2">
          {changed ? (
            <button type="button" className="btn-primary" disabled={pending || days.length === 0} onClick={() => save(days)}>
              {pending ? "Saving…" : "Save my workdays"}
            </button>
          ) : null}
          {changed ? (
            <button type="button" className="btn-ghost" disabled={pending} onClick={() => setDays(shown)}>
              Cancel
            </button>
          ) : null}
          {saved && !changed ? (
            <button type="button" className="btn-ghost" disabled={pending} onClick={() => save(null)}>
              Use the organization’s
            </button>
          ) : null}
          {days.length === 0 ? <span className="text-xs text-red-600">Pick at least one workday.</span> : null}
        </div>
      ) : null}
    </div>
  );
}
