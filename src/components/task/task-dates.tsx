"use client";

import { useSyncExternalStore } from "react";
import { useServerAction } from "@/components/toast";
import { updateTask } from "@/lib/actions";
import type { TaskDetail } from "@/lib/data";

const subscribe = () => () => {};
const inputClass =
  "rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm hover:border-zinc-300 focus:border-accent-500 focus:outline-none disabled:bg-zinc-50 disabled:text-zinc-400";

// "HH:MM" of an instant in the browser's zone; null while server rendering (avoids hydration drift).
function useLocalTime(iso: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!iso) return "";
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    },
    () => null,
  );
}

function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// A date input plus an optional time. The date is a plain day; the time is stored as an instant in the
// browser's zone, and the database keeps the date equal to the time's local day.
export function DateTimeField({ task, kind }: { task: TaskDetail; kind: "start" | "due" }) {
  const [, run] = useServerAction();
  const date = kind === "start" ? task.startOn : task.dueOn;
  const instant = kind === "start" ? task.startAt : task.dueAt;
  const time = useLocalTime(instant);
  const label = kind === "start" ? "Start" : "Due";

  function saveDate(input: HTMLInputElement) {
    const value = input.value || null;
    run(async () => {
      const result = await updateTask(task.id, kind === "start" ? { startOn: value } : { dueOn: value });
      if (result.error) input.value = date ?? "";
      return result;
    });
  }

  function saveTime(input: HTMLInputElement) {
    if (!date || input.value === (time ?? "")) return;
    const at = input.value ? new Date(`${date}T${input.value}`).toISOString() : null;
    const patch = kind === "start" ? { startAt: at } : { dueAt: at };
    run(async () => {
      const result = await updateTask(task.id, at ? { ...patch, timeZone: browserTimeZone() } : patch);
      if (result.error) input.value = time ?? "";
      return result;
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        id={`task-${kind}`}
        type="date"
        key={date ?? "none"}
        defaultValue={date ?? ""}
        min={kind === "due" ? (task.startOn ?? undefined) : undefined}
        max={kind === "start" ? (task.dueOn ?? undefined) : undefined}
        onChange={(e) => saveDate(e.currentTarget)}
        className={inputClass}
      />
      <label htmlFor={`task-${kind}-time`} className="sr-only">
        {label} time (optional, your time zone)
      </label>
      <input
        id={`task-${kind}-time`}
        type="time"
        key={`${date ?? "none"}-${instant ?? "none"}-${time === null ? "ssr" : "client"}`}
        defaultValue={time ?? ""}
        disabled={!date}
        title={date ? `${label} time in your time zone (optional)` : `Set a ${label.toLowerCase()} date first`}
        onBlur={(e) => saveTime(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={`${inputClass} w-28`}
      />
      {instant && date ? (
        <button
          type="button"
          onClick={() => run(() => updateTask(task.id, kind === "start" ? { startAt: null } : { dueAt: null }))}
          className="text-xs text-zinc-500 hover:text-zinc-900 hover:underline"
        >
          Clear time
        </button>
      ) : null}
    </div>
  );
}
