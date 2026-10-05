"use client";

import Link from "next/link";
import { useState } from "react";
import { Repeat } from "lucide-react";
import { useTaskHref } from "@/components/project/shared";
import { useServerAction } from "@/components/toast";
import { setTaskRecurrence } from "@/lib/actions";
import type { TaskDetail } from "@/lib/data";
import {
  FREQUENCIES,
  WEEKDAY_SHORT,
  describeRecurrence,
  isFrequency,
  type Recurrence,
  type RecurrenceEnds,
} from "@/lib/recurrence";

const FREQUENCY_LABELS = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" } as const;
const UNITS = { daily: "day(s)", weekly: "week(s)", monthly: "month(s)", yearly: "year(s)" } as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const controlClass =
  "rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm hover:border-zinc-300 focus:border-accent-500 focus:outline-none";

// The pane's "Repeats" row. Completing a repeating task creates the next occurrence with shifted dates.
export function TaskRecurrence({ task }: { task: TaskDetail }) {
  // Remount on server changes so local edits never drift from what was saved.
  return <RecurrenceEditor key={JSON.stringify(task.recurrence)} task={task} />;
}

function RecurrenceEditor({ task }: { task: TaskDetail }) {
  const [, run] = useServerAction();
  const taskHref = useTaskHref();
  const [rule, setRule] = useState<Recurrence | null>(task.recurrence);

  function save(next: Recurrence | null) {
    setRule(next);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    run(async () => {
      const result = await setTaskRecurrence(task.id, next ? { ...next, timezone } : null);
      if (result.error) setRule(task.recurrence);
      return result;
    });
  }

  function setEnds(ends: RecurrenceEnds) {
    if (rule) save({ ...rule, ends });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="task-repeat"
          value={rule?.freq ?? ""}
          onChange={(e) => {
            const freq = e.target.value;
            save(
              isFrequency(freq)
                ? { freq, interval: rule?.interval ?? 1, weekdays: [], ends: rule?.ends ?? { type: "never" } }
                : null,
            );
          }}
          className={controlClass}
        >
          <option value="">Does not repeat</option>
          {FREQUENCIES.map((f) => (
            <option key={f} value={f}>
              {FREQUENCY_LABELS[f]}
            </option>
          ))}
        </select>
        {rule ? (
          <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
            <Repeat className="size-3.5" aria-hidden />
            {describeRecurrence(rule)}
          </span>
        ) : null}
      </div>

      {rule ? (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-200 p-2.5 text-sm text-zinc-700">
          <div className="flex items-center gap-2">
            <label htmlFor="task-repeat-interval">Every</label>
            <input
              id="task-repeat-interval"
              type="number"
              min={1}
              max={365}
              defaultValue={rule.interval}
              onBlur={(e) => {
                const interval = Number(e.currentTarget.value);
                if (Number.isInteger(interval) && interval >= 1 && interval <= 365 && interval !== rule.interval) {
                  save({ ...rule, interval });
                } else {
                  e.currentTarget.value = String(rule.interval);
                }
              }}
              className={`${controlClass} w-16`}
            />
            <span>{UNITS[rule.freq]}</span>
          </div>

          {rule.freq === "weekly" ? (
            <fieldset className="flex flex-wrap items-center gap-1">
              <legend className="sr-only">Repeat on</legend>
              <span className="mr-1 text-xs text-zinc-500" aria-hidden>
                On
              </span>
              {WEEKDAY_SHORT.map((day, index) => {
                const on = rule.weekdays.includes(index);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={WEEKDAY_NAMES[index]}
                    onClick={() =>
                      save({
                        ...rule,
                        weekdays: on
                          ? rule.weekdays.filter((d) => d !== index)
                          : [...rule.weekdays, index].sort((a, b) => a - b),
                      })
                    }
                    className="w-9 rounded border border-zinc-200 py-0.5 text-xs text-zinc-600 hover:border-zinc-300 aria-pressed:border-accent-500 aria-pressed:bg-accent-50 aria-pressed:text-accent-700"
                  >
                    {day.slice(0, 2)}
                  </button>
                );
              })}
            </fieldset>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="task-repeat-ends">Ends</label>
            <select
              id="task-repeat-ends"
              value={rule.ends.type}
              onChange={(e) => {
                const type = e.target.value;
                if (type === "after") setEnds({ type: "after", count: 5 });
                else if (type === "until") setEnds({ type: "until", until: task.dueOn ?? new Date().toISOString().slice(0, 10) });
                else setEnds({ type: "never" });
              }}
              className={controlClass}
            >
              <option value="never">Never</option>
              <option value="after">After</option>
              <option value="until">On date</option>
            </select>
            {rule.ends.type === "after" ? (
              <>
                <label htmlFor="task-repeat-count" className="sr-only">
                  Number of occurrences
                </label>
                <input
                  id="task-repeat-count"
                  type="number"
                  min={1}
                  max={1000}
                  defaultValue={rule.ends.count}
                  onBlur={(e) => {
                    const count = Number(e.currentTarget.value);
                    if (Number.isInteger(count) && count >= 1 && count <= 1000) setEnds({ type: "after", count });
                    else if (rule.ends.type === "after") e.currentTarget.value = String(rule.ends.count);
                  }}
                  className={`${controlClass} w-20`}
                />
                <span>occurrences</span>
              </>
            ) : null}
            {rule.ends.type === "until" ? (
              <>
                <label htmlFor="task-repeat-until" className="sr-only">
                  Last date
                </label>
                <input
                  id="task-repeat-until"
                  type="date"
                  defaultValue={rule.ends.until}
                  onChange={(e) => {
                    if (e.currentTarget.value) setEnds({ type: "until", until: e.currentTarget.value });
                  }}
                  className={controlClass}
                />
              </>
            ) : null}
          </div>

          <p className="text-xs text-zinc-500">
            Completing this task creates the next one with its dates moved forward
            {task.dueOn || task.startOn ? "" : " (due on the next occurrence after the day it’s completed)"}.
            {task.recurrenceSeq > 1 ? ` This is occurrence ${task.recurrenceSeq}.` : ""}
          </p>
        </div>
      ) : null}

      {task.nextOccurrenceId ? (
        <Link href={taskHref(task.nextOccurrenceId)} scroll={false} className="text-xs text-accent-700 hover:underline">
          Open the next occurrence
        </Link>
      ) : null}
    </div>
  );
}
