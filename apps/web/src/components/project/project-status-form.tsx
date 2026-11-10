"use client";

import { Megaphone } from "lucide-react";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { useProjectPermissions } from "@/components/project/project-access";
import { useProjectPage } from "@/components/project/project-page-context";
import { Timestamp } from "@/components/timestamp";
import type { Project } from "@alhc/core/api/projects/model";
import { isProjectStatus } from "@alhc/core/portfolios";

// Settings → General → Project status. Nov 10 (flaw audit C20): one status editor, the status update panel
// the header and the Overview open (title, summary, templates). Here the current status and, for Editors+,
// "Post a status update" opening that panel. A project nobody rated reads "No status yet".
export function ProjectStatusForm({ project }: { project: Project }) {
  const canEdit = useProjectPermissions().canEdit;
  const { openStatusUpdate } = useProjectPage();
  const status = isProjectStatus(project.status) ? project.status : null;
  const set = status !== null && project.status_updated_at !== null;

  return (
    <div className="mx-auto max-w-3xl px-gutter pt-5">
      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="status-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="status-heading" className="text-sm font-semibold text-zinc-900">
            Project status
          </h2>
          {canEdit ? (
            <button type="button" className="btn-secondary" onClick={() => openStatusUpdate(status ?? "on_track")}>
              <Megaphone className="size-3.5" aria-hidden /> Post a status update
            </button>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-600">
          {set ? <ProjectStatusBadge status={project.status} /> : <span className="text-zinc-500">No status yet.</span>}
          {set && project.status_updated_at ? (
            <span>
              Last updated <Timestamp iso={project.status_updated_at} />.
            </span>
          ) : null}
        </div>
        {set && project.status_note ? (
          <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">{project.status_note}</p>
        ) : null}
        <p className="mt-2 text-xs text-zinc-500">
          Shown on the Overview, portfolio cards, and reports. Members get a notification when an update is posted.
        </p>
      </section>
    </div>
  );
}
