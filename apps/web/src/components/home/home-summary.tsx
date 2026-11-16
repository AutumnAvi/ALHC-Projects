"use client";

import { useMemo } from "react";
import { useShellMemberId } from "@/components/shell/shell-context";
import { useTaskEdits } from "@/components/task/task-edits";
import { liveSummaryCounts, summaryLine, type SummaryIds } from "@alhc/core/checklist";

// Nov 16 batch 42 (item 1): Home's "3 due today · 1 overdue" line, kept in step with the person's own saves
// (task-edits.ts). Home can be drawn from a copy the router kept while its fresh render is on the way; the
// Today card shows a tick at once, and this line must not still count it.
export function HomeSummary({ ids, awaiting }: { ids: SummaryIds; awaiting: number }) {
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
    return liveSummaryCounts(ids, done, gone);
  }, [edits, ids, memberId]);
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
