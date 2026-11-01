"use client";

import { useOptimistic } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { displayName } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "@/components/ui";
import { useServerAction } from "@/components/toast";
import { restoreTask } from "@/lib/actions";
import type { Profile, TrashedTask } from "@/lib/data";
import { TRASH_RETENTION_DAYS, trashDaysLeft, trashDeletesInLabel } from "@/lib/trash";

// Deleted tasks stay in the Trash for TRASH_RETENTION_DAYS (Nov 1 notes, item 66): restoring one before
// then brings it back to every project it was in, with its section, fields, comments, and history; after
// that the daily purge removes it permanently. Each row says how long it has left.
export function TrashView({
  tasks,
  profiles,
}: {
  tasks: TrashedTask[];
  profiles: Profile[];
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const [visible, removeRow] = useOptimistic(tasks, (current, taskId: string) =>
    current.filter((t) => t.id !== taskId),
  );
  const profilesById = new Map(profiles.map((p) => [p.id, p]));

  return (
    <div className="mx-auto max-w-3xl px-gutter py-5">
      <section className="rounded-lg border border-zinc-200" aria-labelledby="trash-heading">
        <div className="border-b border-zinc-200 px-5 py-4">
          <h2 id="trash-heading" className="text-sm font-semibold text-zinc-900">
            Trash
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Deleted tasks from this project. Restoring a task puts it back in every project it belonged to, with its
            section, fields, subtasks, comments, and activity. Tasks are deleted permanently {TRASH_RETENTION_DAYS} days
            after they were deleted, with their files.
          </p>
        </div>

        {visible.length === 0 ? (
          <EmptyState icon={Trash2} title="The Trash is empty" size="inline">
            Tasks deleted from this project will show up here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {visible.map((task) => {
              const by = task.deletedBy ? profilesById.get(task.deletedBy) : undefined;
              const soon = trashDaysLeft(task.deletedAt) <= 7;
              return (
                <li key={task.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-sm font-medium ${task.completedAt ? "text-zinc-500 line-through" : "text-zinc-900"}`}
                    >
                      {task.title}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      Deleted <Timestamp iso={task.deletedAt} />
                      {by ? ` by ${displayName(by)}` : ""}
                      {task.parentTitle ? ` · subtask of ${task.parentTitle}` : ""}
                      {task.otherProjectNames.length ? ` · also in ${task.otherProjectNames.join(", ")}` : ""}
                    </p>
                  </div>
                  <span
                    data-trash-deletes-in=""
                    className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${soon ? "bg-red-50 text-red-700" : "bg-zinc-100 text-zinc-600"}`}
                  >
                    {trashDeletesInLabel(task.deletedAt)}
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={async () => {
                      if (await confirm({ title: `Restore “${task.title}”?`, confirmLabel: "Restore" })) {
                        run(
                          () => restoreTask(task.id),
                          () => removeRow(task.id),
                        );
                      }
                    }}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:border-accent-500 hover:text-accent-700 disabled:opacity-50"
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                    Restore<span className="sr-only"> {task.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
