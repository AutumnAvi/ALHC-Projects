"use client";

import Link from "next/link";
import { ArrowRight, CircleCheck } from "lucide-react";
import { ChecklistView, useChecklist } from "@/components/my-tasks/checklist";
import { QuickAddBar } from "@/components/my-tasks/quick-add";
import { useLiveMyTasks } from "@/components/my-tasks/use-live-my-tasks";
import type { CheckedMode } from "@/lib/checklist";
import type { MyTask } from "@/lib/data";
import type { QuickAddPerson, QuickAddProject } from "@/lib/quick-add";
import { Widget, WIDGET_FOOTER_LINK, WidgetTitle } from "./widget";

// Home's Today (Nov 1 notes, batch 9b, item 65): the My tasks checklist limited to Overdue and Today,
// checked off in place (the same rows, setting, and Undo as My tasks), with the quick add on top.
export function TodayCard({
  open: serverOpen,
  completed: serverCompleted,
  checked,
  workWeek,
  projects,
  people,
  laterCount,
  today,
  timeZone,
  loadedAt,
}: {
  // When the server's reads started (Nov 4 notes, batch 28: the newest copy of the person's tasks wins).
  loadedAt?: number;
  today: string;
  timeZone: string;
  open: MyTask[];
  completed: MyTask[];
  checked: CheckedMode;
  workWeek: number[];
  projects: QuickAddProject[];
  people: QuickAddPerson[];
  // Open tasks due after today or with no date (what My tasks shows beyond this card).
  laterCount: number;
}) {
  const { open, completed } = useLiveMyTasks(serverOpen, serverCompleted, loadedAt);
  const list = useChecklist(open, completed, checked, { today, timeZone });
  return (
    <Widget
      labelledBy="home-today"
      className="min-h-80"
      header={
        <div className="flex flex-col gap-3 pb-3">
          <WidgetTitle id="home-today">Today</WidgetTitle>
          <QuickAddBar projects={projects} people={people} workWeek={workWeek} compact placeholder="Add a task — “Call the vendor tomorrow #Project”" />
        </div>
      }
      footer={
        <Link href="/my-tasks" className={WIDGET_FOOTER_LINK}>
          {laterCount > 0 ? `${laterCount} more in My tasks` : "Open My tasks"}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      <div className="px-3 pb-3">
        <ChecklistView
          list={list}
          mode={checked}
          workWeek={workWeek}
          scope="today"
          emptyState={
            <p className="flex items-center gap-2 px-2 py-6 text-sm text-zinc-500">
              <CircleCheck className="size-4 text-green-600" aria-hidden />
              Nothing due today or overdue.
            </p>
          }
        />
      </div>
    </Widget>
  );
}
