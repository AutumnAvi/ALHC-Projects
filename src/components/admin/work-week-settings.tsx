"use client";

import { useState } from "react";
import { useNotify, useServerAction } from "@/components/toast";
import { setWorkWeek } from "@/lib/actions";
import { WEEKDAYS, describeWorkWeek } from "@/lib/workdays";

// Admin console → Organization → Workweek: the days rules count as business days ("Set due date"
// actions with business days, "Every workday" schedules). Sunday–Thursday until an admin changes it.
// The page keys this by the saved value, so a save (or someone else's) starts it fresh.
export function WorkWeekSettings({ workWeek, available }: { workWeek: number[]; available: boolean }) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const [days, setDays] = useState<number[]>(workWeek);
  const changed = days.length !== workWeek.length || days.some((d, i) => d !== workWeek[i]);

  function toggle(day: number) {
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b)));
  }

  return (
    <div className="space-y-4">
      {available ? null : (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The workweek needs this release’s database update, which isn’t applied yet. Until then rules count
          Sunday–Thursday.
        </p>
      )}
      <div role="group" aria-label="Workdays" className="flex flex-wrap gap-1.5">
        {WEEKDAYS.map((day) => {
          const on = days.includes(day.value);
          return (
            <button
              key={day.value}
              type="button"
              aria-pressed={on}
              aria-label={day.label}
              disabled={pending || !available}
              onClick={() => toggle(day.value)}
              className={`h-8 min-w-12 rounded-md border px-2.5 text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-60 ${
                on
                  ? "border-accent-500 bg-accent-50 text-accent-700 hover:bg-accent-100"
                  : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              {day.short}
            </button>
          );
        })}
      </div>
      <p className="text-sm text-zinc-700" aria-live="polite">
        {days.length ? (
          <>
            Rules count business days on: <span className="font-medium text-zinc-900">{describeWorkWeek(days)}</span>
          </>
        ) : (
          <span className="text-red-600">Pick at least one workday.</span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary"
          disabled={pending || !available || !changed || days.length === 0}
          onClick={() =>
            run(async () => {
              const result = await setWorkWeek(days);
              if (!result.error) notify(`Workweek saved: ${describeWorkWeek(days)}`);
              return result;
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {changed ? (
          <button type="button" className="btn-ghost" disabled={pending} onClick={() => setDays(workWeek)}>
            Cancel
          </button>
        ) : null}
      </div>
      <p className="text-xs text-zinc-500">
        “Set due date” actions that count business days skip the other days, and rules scheduled for “Every
        workday” run only on these days. Actions that count calendar days aren’t affected.
      </p>
    </div>
  );
}
