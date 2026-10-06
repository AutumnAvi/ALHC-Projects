import type { Metadata } from "next";
import Link from "next/link";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { HiddenProjectsNote } from "@/components/reports/report-blocks";
import { ExportLink, PrintButton } from "@/components/reports/report-chrome";
import { Timestamp } from "@/components/timestamp";
import { allProjectsReport, countHiddenWorkspaceProjects, listLatestStatusUpdates, workspaceTotals } from "@/lib/data";
import { RECENT_DAYS, formatProgress, progressPercent } from "@/lib/portfolios";
import { getViewerTimeZone } from "@/lib/timezone";

export const metadata: Metadata = { title: "All projects · Reports" };

const TH = "px-3 py-2 text-left text-xs font-medium text-zinc-500";
const TH_NUM = "px-3 py-2 text-right text-xs font-medium text-zinc-500";
const TD = "px-3 py-2 text-sm text-zinc-800";
const TD_NUM = "px-3 py-2 text-right text-sm tabular-nums text-zinc-800";

// One row per project the viewer can read, with the portfolio Report's columns. A multi-homed task
// counts in each of its projects; the total row counts it once.
export default async function AllProjectsReportPage() {
  const timeZone = await getViewerTimeZone();
  const [projects, hidden, totals] = await Promise.all([
    allProjectsReport(timeZone),
    countHiddenWorkspaceProjects(),
    workspaceTotals({}, timeZone),
  ]);
  const latest = await listLatestStatusUpdates(projects.map((p) => p.id));

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-gutter py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-600">
          Every project you can open, with its status and task counts. “Recently” means completed on one of the last{" "}
          {RECENT_DAYS} days in your time zone.
        </p>
        <div className="flex items-center gap-2">
          <ExportLink href="/export/report?table=projects" />
          <PrintButton />
        </div>
      </div>
      <HiddenProjectsNote count={hidden} what="this report" />

      <div className="report-card overflow-x-auto rounded-lg border border-zinc-200">
        <table className="w-full min-w-[48rem] border-collapse">
          <caption className="sr-only">Status and task counts for every project you can open</caption>
          <thead className="border-b border-zinc-200 bg-zinc-50">
            <tr>
              <th scope="col" className={TH}>
                Project
              </th>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={TH}>
                Latest update
              </th>
              <th scope="col" className={TH_NUM}>
                Incomplete
              </th>
              <th scope="col" className={TH_NUM}>
                Overdue
              </th>
              <th scope="col" className={TH_NUM}>
                Completed (last {RECENT_DAYS} days)
              </th>
              <th scope="col" className={TH_NUM}>
                Complete
              </th>
              <th scope="col" className={TH_NUM}>
                Progress
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {projects.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-sm text-zinc-500">
                  You aren’t a member of any project yet. Create one from the sidebar, or ask a project admin to invite you.
                </td>
              </tr>
            ) : (
              projects.map((p) => {
                const update = latest.get(p.id);
                return (
                  <tr key={p.id} className="break-inside-avoid">
                    <th scope="row" className={`${TD} text-left font-medium`}>
                      <Link href={`/projects/${p.id}`} className="hover:underline">
                        {p.name}
                      </Link>
                    </th>
                    <td className={TD}>
                      <ProjectStatusBadge status={p.status} note={p.statusNote} />
                    </td>
                    <td className={`${TD} max-w-64 text-xs`}>
                      {update ? (
                        <>
                          {update.note ? <span className="line-clamp-2 block text-zinc-700">{update.note}</span> : null}
                          <span className="block text-zinc-400">
                            {update.authorName ?? "Someone"} · <Timestamp iso={update.createdAt} />
                          </span>
                        </>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className={TD_NUM}>{p.counts.incomplete}</td>
                    <td className={`${TD_NUM} ${p.counts.overdue > 0 ? "text-red-700" : ""}`}>{p.counts.overdue}</td>
                    <td className={TD_NUM}>{p.counts.completedRecent}</td>
                    <td className={TD_NUM}>{p.counts.completed}</td>
                    <td className={TD_NUM}>{formatProgress(progressPercent(p.counts.completed, p.counts.total))}</td>
                  </tr>
                );
              })
            )}
          </tbody>
          {projects.length > 1 ? (
            <tfoot className="border-t border-zinc-200 bg-zinc-50">
              <tr>
                <th scope="row" colSpan={3} className={`${TD} text-left font-medium`}>
                  All projects <span className="font-normal text-zinc-500">(each task once)</span>
                </th>
                <td className={TD_NUM}>{totals.incomplete}</td>
                <td className={`${TD_NUM} ${totals.overdue > 0 ? "text-red-700" : ""}`}>{totals.overdue}</td>
                <td className={TD_NUM}>{totals.completedRecent}</td>
                <td className={TD_NUM}>{totals.completed}</td>
                <td className={`${TD_NUM} font-medium`}>{formatProgress(progressPercent(totals.completed, totals.total))}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}
