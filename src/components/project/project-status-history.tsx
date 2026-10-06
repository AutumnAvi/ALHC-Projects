import { History } from "lucide-react";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "@/components/ui";
import type { ProjectStatusUpdate } from "@/lib/data";

// Every status change, newest first (project_status_updates; written by set_project_status). Readable by
// everyone in the project; portfolios show the latest one as a column.
export function ProjectStatusHistory({ updates }: { updates: ProjectStatusUpdate[] }) {
  return (
    <div className="mx-auto max-w-3xl px-gutter pt-5">
      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="status-history-heading">
        <h2 id="status-history-heading" className="text-sm font-semibold text-zinc-900">
          Status updates
        </h2>
        {updates.length === 0 ? (
          <EmptyState icon={History} title="No status updates yet" size="inline">
            Each time someone saves the project status above, it’s kept here with their note.
          </EmptyState>
        ) : (
          <ol className="mt-3 space-y-3">
            {updates.map((u) => (
              <li key={u.id} className="flex gap-3 border-l-2 border-zinc-200 pl-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <ProjectStatusBadge status={u.status} />
                    <span className="font-medium text-zinc-700">{u.authorName ?? "Someone"}</span>
                    <Timestamp iso={u.createdAt} />
                  </div>
                  {u.note ? <p className="mt-1 text-sm whitespace-pre-wrap text-zinc-700">{u.note}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
