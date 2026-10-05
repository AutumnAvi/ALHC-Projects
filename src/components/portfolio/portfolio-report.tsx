import Link from "next/link";
import { EyeOff } from "lucide-react";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { RECENT_DAYS, formatProgress, progressPercent, type PortfolioCounts } from "@/lib/portfolios";

type ProjectRow = { id: string; name: string; status: string; statusNote: string | null; counts: PortfolioCounts };
type AssigneeRow = { id: string | null; name: string; counts: PortfolioCounts };

const TH = "px-3 py-2 text-left text-xs font-medium text-zinc-500";
const TH_NUM = "px-3 py-2 text-right text-xs font-medium text-zinc-500";
const TD = "px-3 py-2 text-sm text-zinc-800";
const TD_NUM = "px-3 py-2 text-right text-sm tabular-nums text-zinc-800";

// Cross-project report. Every number comes from portfolio_report(), which only counts projects the
// viewer can read. Per-project rows count a multi-homed task in each project; the portfolio total
// and the per-assignee rows count it once.
export function PortfolioReport({
  totals,
  hiddenCount,
  projects,
  assignees,
}: {
  totals: PortfolioCounts;
  hiddenCount: number;
  projects: ProjectRow[];
  assignees: AssigneeRow[];
}) {
  const recent = `Completed (last ${RECENT_DAYS} days)`;
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-gutter py-5">
      <p className="text-sm text-zinc-600">
        Incomplete, overdue, and recently completed tasks across this portfolio. “Recently” means completed on one of
        the last {RECENT_DAYS} days in your time zone, today included. Overdue means incomplete and due before today.
      </p>
      {hiddenCount > 0 ? (
        <p className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
          <EyeOff className="size-4 shrink-0 text-zinc-500" aria-hidden />
          {hiddenCount === 1 ? "1 project" : `${hiddenCount} projects`} you’re not a member of{" "}
          {hiddenCount === 1 ? "is" : "are"} left out of this report.
        </p>
      ) : null}

      <section aria-labelledby="by-project-heading">
        <h2 id="by-project-heading" className="text-sm font-semibold text-zinc-900">
          By project
        </h2>
        <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200">
          <table className="w-full min-w-[40rem] border-collapse">
            <caption className="sr-only">Task counts by project</caption>
            <thead className="border-b border-zinc-200 bg-zinc-50">
              <tr>
                <th scope="col" className={TH}>
                  Project
                </th>
                <th scope="col" className={TH}>
                  Status
                </th>
                <th scope="col" className={TH_NUM}>
                  Incomplete
                </th>
                <th scope="col" className={TH_NUM}>
                  Overdue
                </th>
                <th scope="col" className={TH_NUM}>
                  {recent}
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
                  <td colSpan={7} className="px-3 py-6 text-center text-sm text-zinc-500">
                    No projects you’re a member of are in this portfolio yet.
                  </td>
                </tr>
              ) : (
                projects.map((p) => (
                  <tr key={p.id}>
                    <th scope="row" className={`${TD} text-left font-medium`}>
                      <Link href={`/projects/${p.id}`} className="hover:underline">
                        {p.name}
                      </Link>
                    </th>
                    <td className={TD}>
                      <ProjectStatusBadge status={p.status} note={p.statusNote} />
                    </td>
                    <td className={TD_NUM}>{p.counts.incomplete}</td>
                    <td className={`${TD_NUM} ${p.counts.overdue > 0 ? "text-red-700" : ""}`}>{p.counts.overdue}</td>
                    <td className={TD_NUM}>{p.counts.completedRecent}</td>
                    <td className={TD_NUM}>{p.counts.completed}</td>
                    <td className={TD_NUM}>{formatProgress(progressPercent(p.counts.completed, p.counts.total))}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot className="border-t border-zinc-200 bg-zinc-50">
              <tr>
                <th scope="row" colSpan={2} className={`${TD} text-left font-medium`}>
                  Portfolio total <span className="font-normal text-zinc-500">(each task once)</span>
                </th>
                <td className={TD_NUM}>{totals.incomplete}</td>
                <td className={`${TD_NUM} ${totals.overdue > 0 ? "text-red-700" : ""}`}>{totals.overdue}</td>
                <td className={TD_NUM}>{totals.completedRecent}</td>
                <td className={TD_NUM}>{totals.completed}</td>
                <td className={`${TD_NUM} font-medium`}>{formatProgress(progressPercent(totals.completed, totals.total))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section aria-labelledby="by-assignee-heading">
        <h2 id="by-assignee-heading" className="text-sm font-semibold text-zinc-900">
          By assignee
        </h2>
        <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200">
          <table className="w-full min-w-[32rem] border-collapse">
            <caption className="sr-only">Task counts by assignee across the portfolio</caption>
            <thead className="border-b border-zinc-200 bg-zinc-50">
              <tr>
                <th scope="col" className={TH}>
                  Assignee
                </th>
                <th scope="col" className={TH_NUM}>
                  Incomplete
                </th>
                <th scope="col" className={TH_NUM}>
                  Overdue
                </th>
                <th scope="col" className={TH_NUM}>
                  {recent}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {assignees.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-sm text-zinc-500">
                    No tasks yet.
                  </td>
                </tr>
              ) : (
                assignees.map((a) => (
                  <tr key={a.id ?? "unassigned"}>
                    <th scope="row" className={`${TD} text-left font-medium ${a.id ? "" : "text-zinc-500"}`}>
                      {a.name}
                    </th>
                    <td className={TD_NUM}>{a.counts.incomplete}</td>
                    <td className={`${TD_NUM} ${a.counts.overdue > 0 ? "text-red-700" : ""}`}>{a.counts.overdue}</td>
                    <td className={TD_NUM}>{a.counts.completedRecent}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
