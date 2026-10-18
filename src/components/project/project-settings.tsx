"use client";

import { useServerAction } from "@/components/toast";
import { updateProjectWorkflow } from "@/lib/actions";
import type { Project } from "@/lib/data";

export function ProjectSettings({ project }: { project: Project }) {
  const [pending, run] = useServerAction();

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-gutter py-5">
      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="approvals-settings-heading">
        <h2 id="approvals-settings-heading" className="text-sm font-semibold text-zinc-900">
          Approvals
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Deciding an approval always records the decision and completes its approval subtask (when approved or
          rejected). Optionally, approving also completes the task itself.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm text-zinc-800">
          <input
            type="checkbox"
            defaultChecked={project.approval_completes_task}
            disabled={pending}
            onChange={(e) => {
              const approvalCompletesTask = e.currentTarget.checked;
              run(() => updateProjectWorkflow(project.id, { approvalCompletesTask }));
            }}
            className="size-4 accent-zinc-900"
          />
          Complete the task when an approval on it is approved
        </label>
      </section>
    </div>
  );
}
