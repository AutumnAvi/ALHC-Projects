"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Copy } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useTaskHref } from "@/components/project/shared";
import { useNotify } from "@/components/toast";
import { duplicateTask } from "@/lib/actions";
import { DUPLICATE_TASK_OPTIONS, describeDuplicateSkips, type DuplicateTaskOptionKey } from "@/lib/duplicate-task";

// Pane header button + dialog: name the copy and choose what comes along. The copy lands in this task's
// projects where you're an Editor (a subtask's copy next to it; a private task's copy stays private),
// then opens in the pane.
export function DuplicateTaskButton({ taskId, title, isSubtask }: { taskId: string; title: string; isSubtask: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Duplicate task" title="Duplicate task" className="btn-icon">
        <Copy className="size-4" />
      </button>
      {open ? <DuplicateTaskDialog taskId={taskId} title={title} isSubtask={isSubtask} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function DuplicateTaskDialog({
  taskId,
  title,
  isSubtask,
  onClose,
}: {
  taskId: string;
  title: string;
  isSubtask: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const taskHref = useTaskHref();
  const notify = useNotify();
  const [pending, start] = useTransition();
  const [name, setName] = useState(`Copy of ${title}`);
  const [chosen, setChosen] = useState<Record<DuplicateTaskOptionKey, boolean>>(
    () => Object.fromEntries(DUPLICATE_TASK_OPTIONS.map((o) => [o.key, true])) as Record<DuplicateTaskOptionKey, boolean>,
  );

  function submit() {
    start(async () => {
      const outcome = await duplicateTask(taskId, { ...chosen, title: name });
      if (outcome.error || !outcome.result) {
        notify(outcome.error ?? "The task couldn’t be duplicated");
        return;
      }
      const skipped = describeDuplicateSkips(outcome.result);
      notify(`Duplicated as “${name.trim() || `Copy of ${title}`}”${skipped ? `. ${skipped}` : ""}`);
      onClose();
      router.push(taskHref(outcome.result.taskId), { scroll: false });
    });
  }

  return (
    <Dialog
      title={isSubtask ? "Duplicate subtask" : "Duplicate task"}
      description="The copy goes where you can edit: this task’s projects where you’re an Editor, right below the original. It starts open."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="duplicate-task-name" className="text-xs font-medium text-zinc-700">
          Name
        </label>
        <input
          id="duplicate-task-name"
          data-autofocus
          value={name}
          maxLength={1000}
          onChange={(e) => setName(e.target.value)}
          className="control mt-1 w-full"
        />
        <fieldset className="mt-3">
          <legend className="text-xs font-medium text-zinc-700">Include</legend>
          <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
            {DUPLICATE_TASK_OPTIONS.map((option) => (
              <label key={option.key} className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  className="size-3.5 accent-zinc-900"
                  checked={chosen[option.key]}
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    setChosen((c) => ({ ...c, [option.key]: checked }));
                  }}
                />
                {option.label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Notes and the task type always come along. Comments, approvals, and recurrence don’t; people who can’t
            see the copy aren’t kept as assignee or followers.
          </p>
        </fieldset>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={pending || !name.trim()}>
            {pending ? "Duplicating…" : "Duplicate"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
