"use client";

import { useState } from "react";
import { Check, ListPlus } from "lucide-react";
import { useNotify, useServerAction } from "@/components/toast";
import { createSubtaskFromFeedback } from "@/lib/actions";
import type { TaskDetail } from "@/lib/data";
import { feedbackSubtaskNotes, feedbackSubtaskTitle } from "@/lib/feedback-subtask";
import { addPendingSubtask, dropPendingSubtasks, settlePendingSubtask, usePendingSubtasks } from "./pending-subtasks-store";

// A link back to the task the feedback is on (the subtask's description; its breadcrumb also leads there).
function taskLink(task: TaskDetail): string | null {
  if (typeof window === "undefined") return null;
  const project = task.memberships[0]?.projectId;
  const path = project ? `/projects/${project}?task=${task.id}` : `/my-tasks?task=${task.id}`;
  return `${window.location.origin}${path}`;
}

// Nov 2 notes (batch 17, 131): "Create subtask" next to a piece of feedback. The subtask shows in the
// task's Subtasks at once (pending-subtasks-store.ts) and is saved in the background; a refusal takes it
// away again and the toast says why. Once made (or while a subtask by that name exists) it reads
// "Subtask created". Editors only (the caller decides; create_subtask checks).
export function FeedbackSubtaskButton({
  task,
  feedback,
  feedbackId,
  from,
  className = "",
}: {
  task: TaskDetail;
  feedback: string;
  // Tells two pieces of feedback with the same text apart while one is saving.
  feedbackId: string;
  from: string;
  className?: string;
}) {
  const [, run] = useServerAction();
  const notify = useNotify();
  const pending = usePendingSubtasks();
  const [made, setMade] = useState(false);
  const title = feedbackSubtaskTitle(feedback);
  const tempId = `feedback-${feedbackId}`;
  const exists =
    made || pending.some((p) => p.tempId === tempId) || task.subtasks.some((s) => s.title.trim() === title);

  if (exists) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs text-zinc-500 ${className}`} data-feedback-subtask="created">
        <Check className="size-3.5 text-green-600" aria-hidden />
        Subtask created
      </span>
    );
  }

  function create() {
    setMade(true);
    addPendingSubtask({ tempId, parentId: task.id, title });
    const notes = feedbackSubtaskNotes({ feedback, from, link: taskLink(task) });
    run(async () => {
      const result = await createSubtaskFromFeedback(task.id, title, notes);
      if (result.error || !result.subtaskId) {
        dropPendingSubtasks([tempId]);
        setMade(false);
      } else {
        settlePendingSubtask(tempId, result.subtaskId);
        notify(`Subtask “${title}” created`);
      }
      return result;
    });
  }

  return (
    <button
      type="button"
      onClick={create}
      data-feedback-subtask=""
      data-tooltip="Make a subtask of this task from this feedback"
      className={`inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs font-medium text-accent-700 hover:bg-accent-50 ${className}`}
    >
      <ListPlus className="size-3.5" aria-hidden />
      Create subtask
    </button>
  );
}
