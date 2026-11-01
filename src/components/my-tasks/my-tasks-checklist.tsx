"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, CircleCheck, LayoutList, SlidersHorizontal } from "lucide-react";
import { Popover } from "@/components/popover";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { setMyTasksChecked } from "@/lib/actions";
import { CHECKED_MODE_OPTIONS, completedToday, type CheckedMode } from "@/lib/checklist";
import type { AwaitingApproval, MyTask } from "@/lib/data";
import { saveMyTasksLayout, type MyTasksLayout } from "@/lib/my-tasks";
import type { QuickAddPerson, QuickAddProject } from "@/lib/quick-add";
import { ChecklistView, useChecklist } from "./checklist";
import { AwaitingRow } from "./my-tasks-view";
import { QuickAddBar } from "./quick-add";

// My tasks (Nov 1 notes, batch 9b, item 64): the quick add, approvals waiting on you (when there are
// any), and the checklist. The options menu holds "Checked items" (saved on the account) and the
// classic views (your sections, due-date buckets), which still work as before.
export function MyTasksChecklist({
  open,
  completed,
  checked,
  workWeek,
  projects,
  people,
  awaiting,
  today: serverToday,
  timeZone,
}: {
  today: string;
  timeZone: string;
  open: MyTask[];
  completed: MyTask[];
  checked: CheckedMode;
  workWeek: number[];
  projects: QuickAddProject[];
  people: QuickAddPerson[];
  awaiting: AwaitingApproval[];
}) {
  const [mode, setMode] = useState<CheckedMode>(checked);
  const list = useChecklist(open, completed, mode, { today: serverToday, timeZone });
  const today = list.today;
  const openTaskId = useOpenTaskId();
  const [awaitingOpen, setAwaitingOpen] = useState(true);
  const earlier = today ? completed.filter((t) => !completedToday(t.completedAt, today, timeZone)) : [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 pb-24">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <QuickAddBar projects={projects} people={people} workWeek={workWeek} />
        </div>
        <ChecklistOptions mode={mode} onMode={setMode} />
      </div>

      {awaiting.length > 0 ? (
        <section aria-labelledby="awaiting-title" className="rounded-xl border border-amber-200 bg-amber-50/60 p-2">
          <h2 id="awaiting-title">
            <button
              type="button"
              aria-expanded={awaitingOpen}
              onClick={() => setAwaitingOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-sm font-semibold text-amber-900"
            >
              <ChevronRight className={`size-4 transition-transform ${awaitingOpen ? "rotate-90" : ""}`} aria-hidden />
              Waiting on you to approve
              <span className="rounded-full bg-amber-100 px-1.5 text-xs tabular-nums">{awaiting.length}</span>
            </button>
          </h2>
          {awaitingOpen ? (
            <ul className="mt-1 overflow-hidden rounded-lg bg-white">
              {awaiting.map((item) => (
                <AwaitingRow key={item.requestId} item={item} openTaskId={openTaskId} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <ChecklistView
        list={list}
        mode={mode}
        workWeek={workWeek}
        earlier={earlier}
        emptyState={
          <EmptyState icon={CircleCheck} title="All clear">
            Nothing open is assigned to you. Type above to add a task — a date like “fri”, a #project, or an @person works
            too.
          </EmptyState>
        }
      />
    </div>
  );
}

// "View options": what checked items do (saved on your account) and the classic views.
function ChecklistOptions({ mode, onMode }: { mode: CheckedMode; onMode: (mode: CheckedMode) => void }) {
  const router = useRouter();
  const [, run] = useServerAction();
  const openLayout = (layout: MyTasksLayout) => {
    saveMyTasksLayout(layout);
    router.refresh();
  };
  return (
    <Popover
      label="View options"
      tooltip="View options"
      align="end"
      panelClassName="w-80 p-1.5"
      buttonClassName="btn-secondary h-12 shrink-0 gap-1.5 rounded-xl px-3"
      button={
        <>
          <SlidersHorizontal className="size-4" aria-hidden />
          <span className="hidden sm:inline">Options</span>
        </>
      }
    >
      {(close) => (
        <div className="flex flex-col">
          <p className="px-2 pb-1 pt-1 text-xs font-semibold text-zinc-500">When I check off a task</p>
          <div role="radiogroup" aria-label="When I check off a task" className="flex flex-col">
            {CHECKED_MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={mode === option.value}
                onClick={() => {
                  if (option.value === mode) return;
                  const previous = mode;
                  onMode(option.value);
                  run(async () => {
                    const result = await setMyTasksChecked(option.value);
                    if (result.error) onMode(previous);
                    return result;
                  });
                }}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-100"
              >
                <Check className={`mt-0.5 size-4 shrink-0 ${mode === option.value ? "text-accent-600" : "text-transparent"}`} aria-hidden />
                <span>
                  <span className="block text-sm text-zinc-900">{option.label}</span>
                  <span className="block text-xs text-zinc-500">{option.description}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="px-2 pt-1 text-xs text-zinc-500">Everything you check off clears overnight.</p>
          <div className="my-1.5 border-t border-zinc-100" />
          <p className="px-2 pb-1 text-xs font-semibold text-zinc-500">Classic views</p>
          <button
            type="button"
            onClick={() => {
              close();
              openLayout("sections");
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
          >
            <LayoutList className="size-4 text-zinc-500" aria-hidden />
            My sections
            <span className="ml-auto text-xs text-zinc-400">sort into your own sections</span>
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              openLayout("due");
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
          >
            <LayoutList className="size-4 text-zinc-500" aria-hidden />
            Due-date buckets
            <span className="ml-auto text-xs text-zinc-400">with bulk edit</span>
          </button>
        </div>
      )}
    </Popover>
  );
}
