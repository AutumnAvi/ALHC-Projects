import Link from "next/link";
import type { ReactNode } from "react";
import { EyeOff } from "lucide-react";
import { CountBarChart, type BarDatum } from "@/components/dashboard/bar-chart";
import { formatDueDate } from "@/lib/dates";
import { RECENT_DAYS, formatProgress, progressPercent, type PortfolioCounts } from "@/lib/portfolios";

// Server-safe building blocks shared by the Reports overview and personal dashboards. Charts are the
// existing Recharts components with sr-only tables; nothing here fetches.

export function ReportCard({
  title,
  id,
  actions,
  wide = false,
  children,
}: {
  title: string;
  id: string;
  actions?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`report-card flex min-w-0 flex-col rounded-xl border border-zinc-200 bg-white p-4 ${wide ? "lg:col-span-2" : ""}`}
    >
      <div className="flex items-start gap-2">
        <h2 id={id} className="min-w-0 flex-1 text-sm font-medium text-zinc-700">
          {title}
        </h2>
        {actions ? <div className="-mt-1 flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      <div className="mt-3 flex-1">{children}</div>
    </section>
  );
}

export function HiddenProjectsNote({ count, what = "these numbers" }: { count: number; what?: string }) {
  if (count <= 0) return null;
  return (
    <p className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
      <EyeOff className="size-4 shrink-0 text-zinc-500" aria-hidden />
      {count === 1 ? "1 project" : `${count} projects`} you’re not a member of {count === 1 ? "is" : "are"} left out of{" "}
      {what}.
    </p>
  );
}

export function StatTiles({ counts }: { counts: PortfolioCounts }) {
  const open = counts.incomplete - counts.overdue;
  const tiles = [
    { label: "Open", value: open, hint: "Incomplete, not overdue" },
    { label: "Overdue", value: counts.overdue, hint: "Incomplete and due before today", danger: counts.overdue > 0 },
    { label: "Completed", value: counts.completed, hint: `${counts.completedRecent} in the last ${RECENT_DAYS} days` },
    { label: "Progress", value: formatProgress(progressPercent(counts.completed, counts.total)), hint: `${counts.total} tasks in all` },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="report-card rounded-xl border border-zinc-200 bg-white px-4 py-3">
          <dt className="text-xs font-medium text-zinc-500">{tile.label}</dt>
          <dd className={`mt-1 text-2xl font-semibold tabular-nums ${tile.danger ? "text-red-700" : "text-zinc-900"}`}>
            {typeof tile.value === "number" ? tile.value.toLocaleString("en-US") : tile.value}
          </dd>
          <dd className="mt-0.5 text-xs text-zinc-500">{tile.hint}</dd>
        </div>
      ))}
    </dl>
  );
}

export function statusBars(counts: PortfolioCounts): BarDatum[] {
  return [
    { key: "open", label: "Open", count: counts.incomplete - counts.overdue },
    { key: "overdue", label: "Overdue", count: counts.overdue },
    { key: "completed", label: "Completed", count: counts.completed },
  ];
}

export function BarsOrEmpty({ data, caption, empty = "No tasks match." }: { data: BarDatum[]; caption: string; empty?: string }) {
  if (data.every((d) => d.count === 0)) return <p className="py-6 text-center text-sm text-zinc-500">{empty}</p>;
  return <CountBarChart data={data} caption={caption} />;
}

export type OverdueRow = {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  assignee: string;
  dueOn: string;
  daysOverdue: number;
  subtask: boolean;
};

const CURRENT_YEAR = new Date().getUTCFullYear();
const TH = "px-3 py-2 text-left text-xs font-medium text-zinc-500";
const TD = "px-3 py-2 text-sm text-zinc-800";

export function OverdueTable({ rows, caption, limit }: { rows: OverdueRow[]; caption: string; limit?: number }) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-zinc-500">Nothing is overdue.</p>;
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-zinc-200">
          <tr>
            <th scope="col" className={TH}>
              Task
            </th>
            <th scope="col" className={TH}>
              Project
            </th>
            <th scope="col" className={TH}>
              Assignee
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Due
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {shown.map((row) => (
            <tr key={row.taskId}>
              <th scope="row" className={`${TD} max-w-72 text-left font-normal`}>
                <Link href={`/projects/${row.projectId}?task=${row.taskId}`} className="line-clamp-2 hover:underline">
                  {row.title}
                </Link>
                {row.subtask ? <span className="chip ml-1 align-middle">Subtask</span> : null}
              </th>
              <td className={`${TD} max-w-48 truncate text-zinc-600`}>{row.projectName}</td>
              <td className={`${TD} text-zinc-600`}>{row.assignee || <span className="text-zinc-400">Unassigned</span>}</td>
              <td className={`${TD} whitespace-nowrap text-right tabular-nums text-red-700`}>
                {formatDueDate(row.dueOn, CURRENT_YEAR)}{" "}
                <span className="text-xs text-zinc-500">
                  ({row.daysOverdue} {row.daysOverdue === 1 ? "day" : "days"})
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {limit && rows.length > limit ? (
        <p className="mt-2 text-xs text-zinc-500">
          Showing {limit} of {rows.length}. Export the CSV for the full list.
        </p>
      ) : null}
    </div>
  );
}
