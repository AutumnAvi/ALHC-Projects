import Link from "next/link";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { TaskLink } from "@/components/task/task-link";
import { checklistDueLabel } from "@alhc/core/checklist";
import { LOAD_SOFT_CAP, plural, type LeadCards as LeadData } from "@alhc/core/home";
import { personHref } from "@alhc/core/people";
import { projectColorClass } from "@/lib/project-colors";
import { ProgressBar } from "./my-projects-card";
import { Widget, WIDGET_FOOTER_LINK, WidgetTitle } from "./widget";

// Home for people who lead projects (Nov 1 notes, batch 9b, item 65): exactly four fixed cards over the
// projects they lead (Owner / Admin by their own role; a workspace admin: the projects they're in) —
// Team load, Late & at-risk, Project health, Done this week. No widget builder. Server-safe; the
// numbers come from home_dashboard().
export function LeadCards({ lead, today }: { lead: LeadData; today: string }) {
  const scope = lead.workspaceAdmin
    ? `Across the ${plural(lead.projectCount, "project")} you’re in`
    : `Across the ${plural(lead.projectCount, "project")} you lead`;
  return (
    <section aria-labelledby="home-lead-title" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 id="home-lead-title" className="text-base font-semibold text-zinc-900">
          Your team
        </h2>
        <p className="text-xs text-zinc-500">{scope}</p>
      </div>
      <div className="grid gap-4 @4xl:grid-cols-2">
        <TeamLoad lead={lead} />
        <LateAtRisk lead={lead} today={today} />
        <ProjectHealth lead={lead} />
        <DoneThisWeek lead={lead} />
      </div>
    </section>
  );
}

function TeamLoad({ lead }: { lead: LeadData }) {
  const { people, peopleCount, unassigned } = lead.load;
  const max = Math.max(LOAD_SOFT_CAP, ...people.map((p) => p.dueWeek));
  return (
    <Widget
      labelledBy="lead-load"
      className="min-h-72"
      header={
        <div className="pb-2">
          <WidgetTitle id="lead-load">Team load</WidgetTitle>
          <p className="text-xs text-zinc-500">Due in the next 7 days per person; more than {LOAD_SOFT_CAP} reads as a lot</p>
        </div>
      }
      footer={
        <span className="text-xs text-zinc-500">
          {peopleCount > people.length ? `${plural(peopleCount - people.length, "more person", "more people")} · ` : ""}
          {unassigned > 0 ? `${plural(unassigned, "open task")} with nobody assigned` : "Every open task has someone"}
        </span>
      }
    >
      {people.length === 0 ? (
        <p className="px-5 py-6 text-sm text-zinc-500">No open work is assigned in your projects.</p>
      ) : (
        <ul className="flex flex-col gap-2.5 px-5 pb-4 pt-1">
          {people.map((p) => {
            const over = p.dueWeek > LOAD_SOFT_CAP;
            return (
              <li key={p.profileId} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2 text-sm">
                  <Link href={personHref(p.profileId)} className="min-w-0 truncate font-medium text-zinc-900 hover:underline">
                    {p.name}
                  </Link>
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-zinc-500">
                    {p.dueWeek} this week · {p.open} open
                    {p.overdue > 0 ? <span className="font-medium text-red-600"> · {p.overdue} overdue</span> : null}
                  </span>
                </div>
                <div className="relative h-2 overflow-hidden rounded-full bg-zinc-100" aria-hidden>
                  <div className={`h-full rounded-full ${over ? "bg-red-500" : "bg-accent-500"}`} style={{ width: `${Math.round((100 * p.dueWeek) / max)}%` }} />
                  <div className="absolute inset-y-0 w-px bg-zinc-400" style={{ left: `${Math.round((100 * LOAD_SOFT_CAP) / max)}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Widget>
  );
}

function LateAtRisk({ lead, today }: { lead: LeadData; today: string }) {
  const { overdue, atRisk, tasks } = lead.late;
  return (
    <Widget
      labelledBy="lead-late"
      className="min-h-72"
      header={
        <div className="pb-2">
          <WidgetTitle id="lead-late">Late &amp; at risk</WidgetTitle>
          <p className="text-xs text-zinc-500">
            <span className={overdue ? "font-medium text-red-600" : ""}>{overdue} overdue</span> · {atRisk} due within 2 days with no activity for 3 days
          </p>
        </div>
      }
    >
      {tasks.length === 0 ? (
        <p className="px-5 py-6 text-sm text-zinc-500">Nothing late or at risk. Nice.</p>
      ) : (
        <ul className="flex flex-col px-3 pb-3">
          {tasks.map((t) => (
            <li key={t.id}>
              <TaskLink taskId={t.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-50">
                <span className={`w-16 shrink-0 text-xs font-medium tabular-nums ${t.overdue ? "text-red-600" : "text-amber-700"}`}>
                  {checklistDueLabel(t.dueOn, today)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-900">{t.title}</span>
                  <span className="block truncate text-xs text-zinc-500">
                    {[t.assigneeName ?? "Nobody assigned", t.projectName].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="sr-only">{t.overdue ? "Overdue" : "At risk"}</span>
              </TaskLink>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

function ProjectHealth({ lead }: { lead: LeadData }) {
  return (
    <Widget
      labelledBy="lead-health"
      className="min-h-72"
      header={
        <div className="pb-2">
          <WidgetTitle id="lead-health">Project health</WidgetTitle>
          <p className="text-xs text-zinc-500">Done, overdue, and status — most overdue first</p>
        </div>
      }
      footer={
        <Link href="/reports/projects" className={WIDGET_FOOTER_LINK}>
          All projects report
        </Link>
      }
    >
      {lead.health.length === 0 ? (
        <p className="px-5 py-6 text-sm text-zinc-500">No projects to show.</p>
      ) : (
        <ul className="flex flex-col px-3 pb-3">
          {lead.health.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}/overview`} className="flex flex-col gap-1 rounded-lg px-2 py-2 hover:bg-zinc-50">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className={`size-3 shrink-0 rounded ${projectColorClass(p.id)}`} />
                  <span className="min-w-0 truncate text-sm font-medium text-zinc-900">{p.name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {p.overdue > 0 ? <span className="text-xs font-medium text-red-600">{p.overdue} overdue</span> : null}
                    {p.statusSet ? <ProjectStatusBadge status={p.status} /> : <span className="text-xs text-zinc-400">No status</span>}
                  </span>
                </span>
                <ProgressBar completed={p.completed} total={p.total} label={`${p.name}: progress`} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

function DoneThisWeek({ lead }: { lead: LeadData }) {
  const { total, people } = lead.done;
  const max = Math.max(1, ...people.map((p) => p.count));
  return (
    <Widget
      labelledBy="lead-done"
      className="min-h-72"
      header={
        <div className="pb-2">
          <WidgetTitle id="lead-done">Done this week</WidgetTitle>
          <p className="text-xs text-zinc-500">
            <span className="text-2xl font-semibold tabular-nums text-zinc-900">{total}</span> {total === 1 ? "task" : "tasks"} completed since Sunday
          </p>
        </div>
      }
    >
      {people.length === 0 ? (
        <p className="px-5 py-6 text-sm text-zinc-500">Nothing completed yet this week.</p>
      ) : (
        <ul className="flex flex-col gap-2 px-5 pb-4 pt-1">
          {people.map((p) => (
            <li key={p.profileId ?? "nobody"} className="flex items-center gap-3 text-sm">
              <span className="w-32 shrink-0 truncate text-zinc-800">
                {p.profileId ? (
                  <Link href={personHref(p.profileId)} className="hover:underline">
                    {p.name ?? "Someone"}
                  </Link>
                ) : (
                  "Nobody assigned"
                )}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100" aria-hidden>
                <span className="block h-full rounded-full bg-green-600" style={{ width: `${Math.round((100 * p.count) / max)}%` }} />
              </span>
              <span className="w-8 shrink-0 text-right tabular-nums text-zinc-600">{p.count}</span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}
