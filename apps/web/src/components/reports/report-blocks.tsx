import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDot, EyeOff, Gauge, type LucideIcon } from "lucide-react";
import { CountBarChart, type BarDatum, type BarTone } from "@/components/dashboard/bar-chart";
// Not "@/lib/dates": that module is client-only, and this file renders on the server.
import { dayLabel } from "@alhc/core/date-input";
import { RECENT_DAYS, formatProgress, progressPercent, type PortfolioCounts } from "@alhc/core/portfolios";

// Server-safe building blocks shared by the Reports overview and personal dashboards. Charts are the
// existing Recharts components with sr-only tables; nothing here fetches.

// Nov 2 notes (batch 13, note 91): cards read as cards, not spreadsheet cells — a clear title, an optional
// one-line subtitle in muted ink, and actions on the right.
export function ReportCard({
  title,
  id,
  actions,
  subtitle,
  wide = false,
  children,
}: {
  title: string;
  id: string;
  actions?: ReactNode;
  subtitle?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`report-card flex min-w-0 flex-col rounded-xl border border-zinc-200 bg-white p-5 shadow-sm ${wide ? "lg:col-span-2" : ""}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={id} className="text-sm font-semibold text-zinc-900">
            {title}
          </h2>
          {subtitle ? <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p> : null}
        </div>
        {actions ? <div className="-mt-1 flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      <div className="mt-4 flex-1">{children}</div>
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

type Tile = {
  label: string;
  value: number | string;
  hint: string;
  icon: LucideIcon;
  // The tile's accent: a colored edge and icon chip; the number stays in text ink (red only when overdue).
  accent: "blue" | "red" | "green" | "violet" | "zinc";
};

const ACCENT: Record<Tile["accent"], { edge: string; chip: string }> = {
  blue: { edge: "before:bg-accent-500", chip: "bg-accent-50 text-accent-700" },
  red: { edge: "before:bg-red-500", chip: "bg-red-50 text-red-700" },
  green: { edge: "before:bg-emerald-500", chip: "bg-emerald-50 text-emerald-700" },
  violet: { edge: "before:bg-violet-500", chip: "bg-violet-50 text-violet-700" },
  zinc: { edge: "before:bg-zinc-300", chip: "bg-zinc-100 text-zinc-500" },
};

export function statTiles(counts: PortfolioCounts): Tile[] {
  const open = counts.incomplete - counts.overdue;
  const percent = progressPercent(counts.completed, counts.total);
  return [
    { label: "Open", value: open, hint: "Incomplete, not overdue", icon: CircleDot, accent: "blue" },
    {
      label: "Overdue",
      value: counts.overdue,
      hint: counts.overdue > 0 ? "Incomplete and due before today" : "Nothing is late",
      icon: AlertTriangle,
      accent: counts.overdue > 0 ? "red" : "zinc",
    },
    {
      label: "Completed",
      value: counts.completed,
      hint: `${counts.completedRecent.toLocaleString("en-US")} in the last ${RECENT_DAYS} days`,
      icon: CheckCircle2,
      accent: "green",
    },
    { label: "Progress", value: formatProgress(percent), hint: `${counts.total.toLocaleString("en-US")} tasks in all`, icon: Gauge, accent: "violet" },
  ];
}

export function StatTiles({ counts }: { counts: PortfolioCounts }) {
  const percent = progressPercent(counts.completed, counts.total);
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {statTiles(counts).map((tile) => {
        const Icon = tile.icon;
        const accent = ACCENT[tile.accent];
        return (
          <div
            key={tile.label}
            className={`report-card relative overflow-hidden rounded-xl border border-zinc-200 bg-white px-4 py-3.5 shadow-sm before:absolute before:inset-y-0 before:left-0 before:w-1 ${accent.edge}`}
          >
            <dt className="flex items-center gap-2 text-xs font-medium text-zinc-600">
              <span aria-hidden className={`flex size-6 items-center justify-center rounded-md ${accent.chip}`}>
                <Icon className="size-3.5" />
              </span>
              {tile.label}
            </dt>
            <dd
              className={`mt-2 text-3xl font-semibold tabular-nums tracking-tight ${
                tile.accent === "red" ? "text-red-700" : "text-zinc-900"
              }`}
            >
              {typeof tile.value === "number" ? tile.value.toLocaleString("en-US") : tile.value}
            </dd>
            {tile.label === "Progress" && percent !== null ? (
              <dd aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                <span className="block h-full rounded-full bg-violet-500" style={{ width: `${percent}%` }} />
              </dd>
            ) : null}
            <dd className="mt-1 text-xs text-zinc-500">{tile.hint}</dd>
          </div>
        );
      })}
    </dl>
  );
}

// Status bars wear the status colors (open blue, overdue red, completed green) next to their labels.
export function statusBars(counts: PortfolioCounts): BarDatum[] {
  return [
    { key: "open", label: "Open", count: counts.incomplete - counts.overdue, tone: "blue" },
    { key: "overdue", label: "Overdue", count: counts.overdue, tone: "red" },
    { key: "completed", label: "Completed", count: counts.completed, tone: "green" },
  ];
}

export function BarsOrEmpty({
  data,
  caption,
  empty = "No tasks match.",
  tone,
}: {
  data: BarDatum[];
  caption: string;
  empty?: string;
  tone?: BarTone;
}) {
  if (data.every((d) => d.count === 0)) return <p className="py-8 text-center text-sm text-zinc-500">{empty}</p>;
  return <CountBarChart data={data} caption={caption} tone={tone} />;
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
// Soft tables (note 91): a sticky, tinted header, roomier rows, zebra stripes, overdue in red.
export const REPORT_TH = "sticky top-0 z-[1] bg-zinc-50 px-3 py-2.5 text-left text-xs font-medium text-zinc-500";
export const REPORT_TD = "px-3 py-2.5 text-sm text-zinc-800";
export const REPORT_ROW = "odd:bg-white even:bg-zinc-50/60 hover:bg-accent-50/40";
const TH = REPORT_TH;
const TD = REPORT_TD;

export function OverdueTable({ rows, caption, limit }: { rows: OverdueRow[]; caption: string; limit?: number }) {
  if (rows.length === 0)
    return (
      <p className="flex items-center justify-center gap-2 py-8 text-sm text-emerald-700">
        <CheckCircle2 className="size-4" aria-hidden /> Nothing is overdue.
      </p>
    );
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <div className="max-h-[32rem] overflow-auto rounded-lg border border-zinc-100">
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
        <tbody>
          {shown.map((row) => (
            <tr key={row.taskId} className={REPORT_ROW}>
              <th scope="row" className={`${TD} max-w-72 text-left font-normal`}>
                <Link href={`/projects/${row.projectId}?task=${row.taskId}`} className="line-clamp-2 hover:underline">
                  {row.title}
                </Link>
                {row.subtask ? <span className="chip ml-1 align-middle">Subtask</span> : null}
              </th>
              <td className={`${TD} max-w-48 truncate text-zinc-600`}>{row.projectName}</td>
              <td className={`${TD} text-zinc-600`}>{row.assignee || <span className="text-zinc-400">Unassigned</span>}</td>
              <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
                <span className="text-red-700">{dayLabel(row.dueOn, CURRENT_YEAR)}</span>{" "}
                <span className="ml-1 inline-flex rounded-full bg-red-50 px-1.5 py-0.5 text-2xs font-medium text-red-700">
                  {row.daysOverdue} {row.daysOverdue === 1 ? "day" : "days"} late
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
