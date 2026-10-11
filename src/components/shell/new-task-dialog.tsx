"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Lock } from "lucide-react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { useNotify } from "@/components/toast";
import { createPrivateTask } from "@/lib/actions";

// Create → Task: the My tasks quick-add in a dialog. The task is private (only you, and whoever you
// assign it to, can see it) until it's added to a project, exactly like the Add task box in My tasks.
export function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const notify = useNotify();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const name = title.trim();
    if (!name) return;
    startTransition(async () => {
      const result = await createPrivateTask(name);
      if (result.error) {
        setError(result.error);
        return;
      }
      onClose();
      const taskId = result.taskId;
      notify(
        "Task created in My tasks",
        taskId ? { label: "Open", onClick: () => router.push(`/my-tasks?task=${taskId}`) } : undefined,
      );
    });
  }

  return (
    <Dialog title="New task" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <div>
          <label htmlFor="new-task-title" className={DIALOG_LABEL}>
            Task name
          </label>
          <input
            id="new-task-title"
            data-autofocus
            value={title}
            onChange={(e) => {
              setTitle(e.currentTarget.value);
              setError(null);
            }}
            required
            maxLength={1000}
            placeholder="Write a task name"
            className="field mt-1 w-full"
          />
          <p className={`${DIALOG_HINT} flex items-start gap-1.5`}>
            <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
            Goes to My tasks, assigned to you. Only you can see it until you assign it to someone or add it to a project.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={pending || !title.trim()} className="btn-primary">
            {pending ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
