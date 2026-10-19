"use client";

import { useState } from "react";
import { CalendarDays, ChevronRight, Repeat } from "lucide-react";
import { useServerAction } from "@/components/toast";
import { setTaskRecurrence } from "@/lib/actions";
import type { TaskDetail } from "@/lib/data";
import { formatDueDate } from "@/lib/dates";
import {
  FREQUENCIES,
  WEEKDAY_SHORT,
  describeRecurrence,
  isFrequency,
  type Recurrence,
  type RecurrenceEnds,
} from "@/lib/recurrence";
import { MiniCalendar } from "./date-picker";
import { TaskLink } from "@/components/task/task-link";
import { seedFromTitle } from "@/lib/task-seed";

const FREQUENCY_LABELS = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" } as const;
const UNITS = { daily: "day(s)", weekly: "week(s)", monthly: "month(s)", yearly: "year(s)" } as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Repeats, at the bottom of the due date picker (Asana parity, batch 3; it used to be a field row).
// Completing a repeating task creates the next occurrence with shifted dates. Collapsed to a summary
// line until opened; the pane's "…" menu opens the picker with it open.
export function TaskRecurrence({ task, defaultOpen = false }: { task: TaskDetail; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-zinc-100 pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-zinc-50"
      >
        <Repeat className="size-4 shrink-0 text-zinc-500" aria-hidden />
        <span className="text-zinc-700">Repeats</span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-zinc-500">
          {task.recurrence ? describeRecurrence(task.recurrence) : "Does not repeat"}
        </span>
        <ChevronRight className={`size-3.5 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
      </button>
      {open ? (
        // Remount on server changes so local edits never drift from what was saved.
        <RecurrenceEditor key={JSON.stringify(task.recurrence)} task={task} />
      ) : null}
    </div>
  );
}

function RecurrenceEditor({ task }: { task: TaskDetail }) {
  const [, run] = useServerAction();
  const [rule, setRule] = useState<Recurrence | null>(task.recurrence);
  const [pickingUntil, setPickingUntil] = useState(false);

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
    <div className="mt-1.5 flex flex-col gap-2 px-1 text-sm text-zinc-700">
      <label className="sr-only" htmlFor="task-repeat">
        Repeats
      </label>
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
        className="control h-8 w-full"
      >
        <option value="">Does not repeat</option>
        {FREQUENCIES.map((f) => (
          <option key={f} value={f}>
            {FREQUENCY_LABELS[f]}
          </option>
        ))}
      </select>

      {rule ? (
        <>
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
              className="control w-16"
            />
            <span>{UNITS[rule.freq]}</span>
          </div>

          {rule.freq === "weekly" ? (
            <fieldset className="flex flex-wrap items-center gap-1">
              <legend className="sr-only">Repeat on</legend>
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
                    className="w-8 rounded border border-zinc-200 py-0.5 text-xs text-zinc-600 hover:border-zinc-300 aria-pressed:border-accent-500 aria-pressed:bg-accent-50 aria-pressed:text-accent-700"
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
                else if (type === "until") {
                  setEnds({ type: "until", until: task.dueOn ?? new Date().toISOString().slice(0, 10) });
                  setPickingUntil(true);
                } else setEnds({ type: "never" });
              }}
              className="control"
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
                  className="control w-16"
                />
                <span>times</span>
              </>
            ) : null}
            {rule.ends.type === "until" ? (
              <button
                type="button"
                aria-expanded={pickingUntil}
                onClick={() => setPickingUntil((p) => !p)}
                className="btn-secondary h-7"
                aria-label={`Last date: ${formatDueDate(rule.ends.until)}. Change`}
              >
                <CalendarDays className="size-3.5 text-zinc-500" aria-hidden />
                {formatDueDate(rule.ends.until, new Date().getFullYear())}
              </button>
            ) : null}
          </div>
          {rule.ends.type === "until" && pickingUntil ? (
            <div className="rounded-md border border-zinc-200 p-2">
              <MiniCalendar
                due={rule.ends.until}
                onPick={(until) => {
                  setPickingUntil(false);
                  setEnds({ type: "until", until });
                }}
              />
            </div>
          ) : null}

          <p className="text-xs text-zinc-500">
            Completing this task creates the next one with its dates moved forward
            {task.dueOn || task.startOn ? "" : " (due on the next occurrence after the day it’s completed)"}.
            {task.recurrenceSeq > 1 ? ` This is occurrence ${task.recurrenceSeq}.` : ""}
          </p>
        </>
      ) : null}

      {task.nextOccurrenceId ? (
        <TaskLink taskId={task.nextOccurrenceId} seed={() => seedFromTitle(task.nextOccurrenceId!, task.title, { kind: task.kind })} className="text-xs text-accent-700 hover:underline">
          Open the next occurrence
        </TaskLink>
      ) : null}
    </div>
  );
}
