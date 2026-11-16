"use client";

import { useMemo } from "react";
import type { MyTask } from "@alhc/core/api/my-tasks/model";
import { useLiveMyTasks } from "@/components/my-tasks/use-live-my-tasks";
import { useShellMemberId } from "@/components/shell/shell-context";
import { useTaskEdits } from "@/components/task/task-edits";
import { liveSummaryCounts, summaryLine } from "@alhc/core/checklist";

// Nov 16 batch 42 (item 1): Home's "3 due today · 1 overdue" line, counted from the same live list the
// Today card draws (useLiveMyTasks: the person's own saves on it at once). Home can be drawn from a copy the
// router kept while its fresh render is on the way; this line must agree with the card.
export function HomeSummary({
  open: serverOpen,
  completed: serverCompleted,
  loadedAt,
  hiddenIds,
  hiddenWeekIds,
  today,
  awaiting,
}: {
  open: MyTask[];
  completed: MyTask[];
  loadedAt?: number;
  hiddenIds?: string[];
  // This week's open tasks the Today card doesn't hold (ids only).
  hiddenWeekIds: string[];
  today: string;
  awaiting: number;
}) {
  const { open } = useLiveMyTasks(serverOpen, serverCompleted, loadedAt, hiddenIds);
  const edits = useTaskEdits();
  const memberId = useShellMemberId();
  const counts = useMemo(() => {
    const done = new Map<string, boolean>();
    const gone = new Set<string>();
    for (const { edit } of edits) {
      if (edit.type === "complete") done.set(edit.taskId, edit.completed);
      else if (edit.type === "assign") {
        if (edit.assigneeId === memberId) gone.delete(edit.taskId);
        else gone.add(edit.taskId);
      }
    }
    return liveSummaryCounts(open, hiddenWeekIds, done, gone, today);
  }, [open, hiddenWeekIds, edits, memberId, today]);
  const summary = summaryLine(counts);
  return (
    <p className="mt-2 text-sm text-zinc-600">
      {summary ? (
        <>
          <span className={counts.overdue ? "font-medium text-zinc-900" : ""}>{summary}</span>
          {awaiting ? ` · ${awaiting} waiting on your approval` : ""}
        </>
      ) : awaiting ? (
        `${awaiting} waiting on your approval`
      ) : (
        "Nothing due today. A good day to get ahead."
      )}
    </p>
  );
}
