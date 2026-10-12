"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { PeriodNav } from "@/components/project/view-chrome";
import { longDate, monthLabel, shiftMonth } from "@/lib/date-input";
import { projectColorClass } from "@/lib/project-colors";
import { TEAM_CALENDAR_LIMIT, type TeamCalendarTask } from "@/lib/teams";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CELL_LIMIT = 3;

// The team Calendar: a read-only month of tasks due in the team's projects the viewer is a member of.
// The month comes from ?d= (the server loads exactly the visible weeks); a task opens in the pane on
// this page (?task=). Rescheduling happens in the task or its project's Calendar.
export function TeamCalendar({
  month,
  today,
  days,
  tasks,
  projectCount,
  capped,
  openTaskId,
}: {
  // "YYYY-MM"
  month: string;
  // The viewer's local day (tz cookie), so server and browser agree on "today" and "overdue".
  today: string;
  // Whole weeks, Sunday first (teamCalendarDays).
  days: string[];
  tasks: TeamCalendarTask[];
  projectCount: number;
  capped: boolean;
  openTaskId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function hrefWith(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function goTo(d: string | null) {
    startTransition(() => router.push(hrefWith({ d }), { scroll: false }));
  }

  const byDate = new Map<string, TeamCalendarTask[]>();
  for (const task of tasks) {
    const list = byDate.get(task.dueOn) ?? [];
    list.push(task);
    byDate.set(task.dueOn, list);
  }
  const label = monthLabel(month);
  const inMonth = tasks.filter((t) => t.dueOn.startsWith(month)).length;

  return (
    <div className="px-gutter py-3">
      <PeriodNav
        label={label}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPrev={() => goTo(`${shiftMonth(month, -1)}-01`)}
        onNext={() => goTo(`${shiftMonth(month, 1)}-01`)}
        onToday={() => goTo(null)}
      />
      <p className="mb-2 text-xs text-zinc-500">
        Tasks due in this team’s {projectCount === 1 ? "project" : `${projectCount} projects`} you’re a member of
        {inMonth === 0 ? ` · Nothing is due in ${label}` : ""}
        {capped ? ` · Showing the first ${TEAM_CALENDAR_LIMIT.toLocaleString("en-US")} tasks` : ""}
      </p>

      <div aria-busy={navigating} className={navigating ? "opacity-60 transition-opacity" : undefined}>
        <div
          aria-hidden
          className="grid grid-cols-7 rounded-t-lg border border-b-0 border-zinc-200 bg-zinc-50 py-1 text-xs font-medium text-zinc-500"
        >
          {WEEKDAYS.map((d) => (
            <span key={d} className="px-2">
              {d}
            </span>
          ))}
        </div>
        <ol
          aria-label={`Tasks due, ${label}`}
          className="grid auto-rows-[minmax(7rem,auto)] grid-cols-7 border-l border-zinc-200"
        >
          {days.map((date) => {
            const dayTasks = byDate.get(date) ?? [];
            const open = expanded.has(date);
            const shown = open ? dayTasks : dayTasks.slice(0, CELL_LIMIT);
            const outside = !date.startsWith(month);
            const isToday = date === today;
            return (
              <li
                key={date}
                aria-label={`${longDate(date)}${isToday ? " (today)" : ""}: ${dayTasks.length} ${dayTasks.length === 1 ? "task" : "tasks"} due`}
                className={`flex min-w-0 flex-col gap-1 border-r border-b border-zinc-200 p-1.5 ${outside ? "bg-zinc-50/70" : "bg-white"}`}
              >
                <span
                  aria-hidden
                  className={`flex size-6 items-center justify-center self-start rounded-full text-xs tabular-nums ${
                    isToday ? "bg-accent-600 font-semibold text-white" : outside ? "text-zinc-400" : "text-zinc-600"
                  }`}
                >
                  {Number(date.slice(8))}
                </span>
                {shown.map((task) => (
                  <TaskChip
                    key={task.id}
                    task={task}
                    href={hrefWith({ task: task.id })}
                    open={openTaskId === task.id}
                    overdue={!task.completedAt && task.dueOn < today}
                  />
                ))}
                {dayTasks.length > CELL_LIMIT ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={
                      open
                        ? `Show fewer tasks on ${longDate(date)}`
                        : `Show ${dayTasks.length - CELL_LIMIT} more tasks on ${longDate(date)}`
                    }
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (open) next.delete(date);
                        else next.add(date);
                        return next;
                      })
                    }
                    className="self-start rounded px-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                  >
                    {open ? "Show less" : `+${dayTasks.length - CELL_LIMIT} more`}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Read-only: tasks are placed by due date. Open a task to change its date, or use its project’s Calendar to drag
        tasks between days.
      </p>
    </div>
  );
}

function TaskChip({
  task,
  href,
  open,
  overdue,
}: {
  task: TeamCalendarTask;
  href: string;
  open: boolean;
  overdue: boolean;
}) {
  const completed = Boolean(task.completedAt);
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={open ? "true" : undefined}
      data-tooltip={`${task.title} · ${task.projectName}`}
      className={`flex min-w-0 items-center gap-1.5 rounded-md border bg-white px-1.5 py-0.5 text-xs shadow-xs hover:border-zinc-300 ${
        open ? "border-accent-500 ring-2 ring-accent-100" : overdue ? "border-red-200" : "border-zinc-200"
      }`}
    >
      <span
        aria-hidden
        className={`size-2 shrink-0 ${task.kind === "milestone" ? "rotate-45 rounded-[1px]" : "rounded-full"} ${projectColorClass(task.projectId)}`}
      />
      <span
        className={`min-w-0 flex-1 truncate ${completed ? "text-zinc-400 line-through" : overdue ? "text-red-700" : "text-zinc-800"}`}
      >
        {task.title}
        <span className="sr-only">
          {` in ${task.projectName}`}
          {task.kind === "milestone" ? " (milestone)" : ""}
          {completed ? " (completed)" : ""}
          {overdue ? " (overdue)" : ""}
        </span>
      </span>
    </Link>
  );
}
