import Link from "next/link";
import { Archive, Compass, Plus, Star } from "lucide-react";
import { OpenDialogButton } from "@/components/shell/open-dialog-button";
import { PrefetchLink } from "@/components/shell/route-freshness";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { plural, progressOf, type HomeProject } from "@alhc/core/home";
import { projectColorClass } from "@/lib/project-colors";
import { Widget, WIDGET_FOOTER_LINK, WidgetTitle } from "./widget";

// A thin progress bar with its number spelled out (server-safe).
export function ProgressBar({ completed, total, label }: { completed: number; total: number; label: string }) {
  const percent = progressOf(completed, total);
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? 0}
        aria-valuetext={percent === null ? "No tasks" : `${percent}% done`}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100"
      >
        <div className="h-full rounded-full bg-green-600" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-zinc-500">{percent === null ? "—" : `${percent}%`}</span>
    </div>
  );
}

// Home's "My projects" (Nov 1 notes, batch 9b, item 65): up to six of the person's projects — starred
// first, then where they have the most open work — with progress and status. Server-safe.
export function MyProjectsCard({ projects, archivedCount }: { projects: HomeProject[]; archivedCount: number }) {
  return (
    <Widget
      labelledBy="home-projects"
      className="min-h-64"
      header={
        <div className="flex items-center justify-between pb-2">
          <WidgetTitle id="home-projects">My projects</WidgetTitle>
          <OpenDialogButton dialog={{ kind: "project" }} className="btn-ghost h-7 gap-1 px-2 text-xs">
            <Plus className="size-3.5" aria-hidden />
            New project
          </OpenDialogButton>
        </div>
      }
      footer={
        <>
          <Link href="/projects/browse" className={WIDGET_FOOTER_LINK}>
            <Compass className="size-3.5" aria-hidden />
            Browse projects
          </Link>
          {archivedCount > 0 ? (
            <Link href="/projects/archived" className={WIDGET_FOOTER_LINK}>
              <Archive className="size-3.5" aria-hidden />
              Archived projects ({archivedCount})
            </Link>
          ) : null}
        </>
      }
    >
      {projects.length === 0 ? (
        <p className="px-5 py-6 text-sm text-zinc-500">You’re not in any project yet. Browse projects to join one, or start your own.</p>
      ) : (
        <ul className="grid gap-x-4 px-3 pb-3 @3xl:grid-cols-2">
          {projects.map((p) => (
            <li key={p.id}>
              <PrefetchLink href={`/projects/${p.id}`} className="flex flex-col gap-1.5 rounded-lg px-2 py-2 hover:bg-zinc-50">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className={`size-3 shrink-0 rounded ${projectColorClass(p.id)}`} />
                  <span className="min-w-0 truncate text-sm font-medium text-zinc-900">{p.name}</span>
                  {p.starred ? <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" /> : null}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {p.overdue > 0 ? <span className="text-xs font-medium text-red-600">{p.overdue} overdue</span> : null}
                    {p.statusSet ? <ProjectStatusBadge status={p.status} /> : null}
                  </span>
                </span>
                <ProgressBar completed={p.completed} total={p.total} label={`${p.name}: progress`} />
                <span className="text-xs text-zinc-500">
                  {p.myOpen > 0 ? `${plural(p.myOpen, "task")} for you · ` : ""}
                  {p.completed} of {plural(p.total, "task")} done
                </span>
              </PrefetchLink>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}
