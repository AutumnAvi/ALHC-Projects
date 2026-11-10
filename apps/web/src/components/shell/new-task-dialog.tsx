"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Dialog, DIALOG_HINT } from "@/components/dialog";
import { useNotify } from "@/components/toast";
import { QuickAddBar } from "@/components/my-tasks/quick-add";
import { usePeopleDirectory } from "@/components/task/title-text";
import { loadTaskProjects } from "@/lib/actions/shell";

// Create → Task: the My tasks quick add in a dialog (Nov 10 audit, C75), so it reads the same sentence —
// a date, "#project", "@person", a repeat — with the same chips. Opened inside a project it starts with
// that project's "#Name" (when the person can add tasks there). Without a "#project" the task is
// private (only you, and whoever you assign it to, can see it), like the My tasks bar.
export function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const notify = useNotify();
  const pathname = usePathname();
  const people = usePeopleDirectory();
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);

  useEffect(() => {
    let live = true;
    loadTaskProjects()
      .then((list) => live && setProjects(list))
      .catch(() => live && setProjects([]));
    return () => {
      live = false;
    };
  }, []);

  const here = /^\/projects\/([0-9a-f-]{36})(?:\/|$)/.exec(pathname)?.[1] ?? null;
  const current = here ? projects?.find((p) => p.id === here) : undefined;

  return (
    <Dialog title="New task" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {projects === null ? (
          <div className="skeleton h-12 rounded-xl" role="status" aria-label="Loading" />
        ) : (
          <QuickAddBar
            projects={projects}
            people={people.map((p) => ({ id: p.id, name: p.name, email: p.email ?? null }))}
            initialText={current ? `#${current.name} ` : ""}
            placeholder="Write a task name — “Call Dana tomorrow #Project”"
            autoFocus
            onAdded={(taskId, summary) => {
              onClose();
              notify(summary, taskId ? { label: "Open", onClick: () => router.push(`/my-tasks?task=${taskId}`) } : undefined);
            }}
          />
        )}
        <p className={DIALOG_HINT}>
          Assigned to you. Type a date (tomorrow, fri), # and a project, or @ and a person. Without a project it goes to
          My tasks, and only you can see it until you assign it or add it to a project.
        </p>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
