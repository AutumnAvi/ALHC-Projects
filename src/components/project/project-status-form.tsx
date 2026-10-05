"use client";

import { useState } from "react";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { ReadOnlyNotice, useCan } from "@/components/project/project-access";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { setProjectStatus } from "@/lib/actions";
import type { Project } from "@/lib/data";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, isProjectStatus, type ProjectStatus } from "@/lib/portfolios";

const inputClass =
  "rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none disabled:opacity-50";

// Editors and above set the status (set_project_status); it shows as a badge on portfolio cards.
export function ProjectStatusForm({ project }: { project: Project }) {
  const [pending, run] = useServerAction();
  const canEdit = useCan("editor");
  const [status, setStatus] = useState<ProjectStatus>(isProjectStatus(project.status) ? project.status : "on_track");
  const [note, setNote] = useState(project.status_note ?? "");

  return (
    <div className="mx-auto max-w-3xl px-gutter pt-5">
      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="status-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="status-heading" className="text-sm font-semibold text-zinc-900">
            Project status
          </h2>
          <ProjectStatusBadge status={project.status} />
        </div>
        <p className="mt-1 text-sm text-zinc-600">
          How this project is going, shown on portfolio cards and reports.
          {project.status_updated_at ? (
            <>
              {" "}
              Last updated <Timestamp iso={project.status_updated_at} />.
            </>
          ) : null}
        </p>
        {canEdit ? null : (
          <div className="mt-3">
            <ReadOnlyNotice need="editor" what="the project status" />
          </div>
        )}
        <form
          className="mt-4 grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => setProjectStatus(project.id, status, note));
          }}
        >
          <fieldset disabled={!canEdit || pending} className="contents">
            <div className="flex flex-col gap-1">
              <label htmlFor="project-status" className="text-xs font-medium text-zinc-600">
                Status
              </label>
              <select
                id="project-status"
                value={status}
                onChange={(e) => setStatus(e.currentTarget.value as ProjectStatus)}
                className={inputClass}
              >
                {PROJECT_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {PROJECT_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="project-status-note" className="text-xs font-medium text-zinc-600">
                Note (optional)
              </label>
              <input
                id="project-status-note"
                value={note}
                maxLength={2000}
                placeholder="What’s changed, what’s blocking"
                onChange={(e) => setNote(e.currentTarget.value)}
                className={inputClass}
              />
            </div>
            <div className="sm:col-span-2">
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                Save status
              </button>
            </div>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
