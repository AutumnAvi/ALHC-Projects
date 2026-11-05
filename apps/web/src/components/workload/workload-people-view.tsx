"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Users } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Segmented } from "@/components/project/view-chrome";
import { EmptyState } from "@/components/ui";
import {
  DAILY_TREND_MAX_DAYS,
  WORKLOAD_PERIODS,
  defaultDir,
  periodLabel,
  sortPeople,
  trendBuckets,
  type PeopleSort,
  type PeopleWindow,
  type PersonSummary,
  type SortDir,
  type TrendBucket,
} from "@alhc/core/workload-people";
import { daysBetween } from "@alhc/core/workload";

// Nov 2 notes (batch 13, note 86): the Workload tab's default view (projects and portfolios) — a list of
// people for a chosen period: what each got done, what's open and overdue today, and a small trend of
// completions per day (short periods) or per week. Sortable by any column; a person opens the day-by-day
// grid for them (?view=grid&person=<id>).
export function WorkloadPeopleView({
  window: period,
  people,
  workWeek,
  available = true,
  hiddenProjects = 0,
}: {
  window: PeopleWindow;
  people: PersonSummary[];
  workWeek: number[];
  // False before this release's database (workload_people_summary missing).
  available?: boolean;
  hiddenProjects?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();
  const [sort, setSort] = useState<{ key: PeopleSort; dir: SortDir }>({ key: "completed", dir: "desc" });
  const [from, setFrom] = useState(period.start);
  const [to, setTo] = useState(period.end);

  const rows = useMemo(() => sortPeople(people, sort.key, sort.dir), [people, sort]);
  const totals = people.reduce(
    (sum, p) => ({ completed: sum.completed + p.completed, open: sum.open + p.open, overdue: sum.overdue + p.overdue }),
    { completed: 0, open: 0, overdue: 0 },
  );
  const daily = daysBetween(period.start, period.end) + 1 <= DAILY_TREND_MAX_DAYS;

  function go(patch: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("task");
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    startNavigation(() => router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  }

  function openPerson(person: PersonSummary) {
    go({ view: "grid", person: person.id, d: period.start, wl: daily ? "day" : null });
  }

  function sortBy(key: PeopleSort) {
    setSort((current) => (current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir(key) }));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-gutter py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Period"
          options={WORKLOAD_PERIODS}
          value={period.period}
          onChange={(next) => {
            if (next === "custom") go({ period: "custom", from, to });
            else go({ period: next === "this_week" ? null : next, from: null, to: null });
          }}
        />
        {period.period === "custom" ? (
          <form
            className="flex flex-wrap items-center gap-2 text-sm text-zinc-600"
            onSubmit={(e) => {
              e.preventDefault();
              if (from && to && from <= to) go({ period: "custom", from, to });
            }}
          >
            <label className="flex items-center gap-1.5">
              From
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.currentTarget.value)} className="control" />
            </label>
            <label className="flex items-center gap-1.5">
              To
              <input type="date" value={to} min={from} onChange={(e) => setTo(e.currentTarget.value)} className="control" />
            </label>
            <button type="submit" disabled={!from || !to || from > to} className="btn-secondary h-7">
              Apply
            </button>
          </form>
        ) : null}
        <p className="text-xs text-zinc-500">{periodLabel(period, workWeek)}</p>
      </div>

      {hiddenProjects > 0 ? (
        <p className="text-xs text-zinc-500">
          {hiddenProjects === 1 ? "1 project" : `${hiddenProjects} projects`} in this portfolio {hiddenProjects === 1 ? "isn’t" : "aren’t"}{" "}
          counted because you aren’t a member.
        </p>
      ) : null}

      {!available ? (
        <EmptyState icon={Users} title="This view needs this release’s database update">
          Use Day by day in the meantime.
        </EmptyState>
      ) : people.length === 0 ? (
        <EmptyState icon={Users} title="No one has work here in this period">
          People show up once they have open tasks assigned to them, or completed one in the period. Pick a longer
          period, or assign tasks to see who’s doing what.
        </EmptyState>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-3 sm:max-w-xl">
            <Total label="Completed" value={totals.completed} tone="text-emerald-700" />
            <Total label="Open now" value={totals.open} tone="text-zinc-900" />
            <Total label="Overdue now" value={totals.overdue} tone={totals.overdue > 0 ? "text-red-700" : "text-zinc-900"} />
          </dl>
          <div
            className={`min-h-0 overflow-auto rounded-xl border border-zinc-200 bg-white ${navigating ? "opacity-60" : ""}`}
            aria-busy={navigating}
          >
            <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">
                People and their work: completed in the period, open and overdue today, and completions per{" "}
                {daily ? "day" : "week"}. Sorted by {sort.key}, {sort.dir === "asc" ? "ascending" : "descending"}.
              </caption>
              <thead>
                <tr>
                  <SortHeader label="Person" sortKey="name" sort={sort} onSort={sortBy} align="left" />
                  <SortHeader label="Completed" sortKey="completed" sort={sort} onSort={sortBy} />
                  <SortHeader label="Open" sortKey="open" sort={sort} onSort={sortBy} />
                  <SortHeader label="Overdue" sortKey="overdue" sort={sort} onSort={sortBy} />
                  <th scope="col" className="sticky top-0 z-[1] border-b border-zinc-200 bg-zinc-50 px-3 py-2.5 text-left text-xs font-medium text-zinc-500">
                    Completed per {daily ? "day" : "week"}
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] w-8 border-b border-zinc-200 bg-zinc-50">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((person) => {
                  const buckets = trendBuckets(period, person.completedDays, workWeek);
                  return (
                    <tr
                      key={person.id}
                      onClick={() => openPerson(person)}
                      className="group cursor-pointer odd:bg-white even:bg-zinc-50/60 hover:bg-accent-50/50"
                    >
                      <th scope="row" className="border-b border-zinc-100 px-3 py-2.5 text-left font-normal">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openPerson(person);
                          }}
                          aria-label={`Open day by day for ${person.name}`}
                          className="flex items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                        >
                          <Avatar name={person.name} profileId={person.id} />
                          <span className="truncate font-medium text-zinc-900 group-hover:underline">{person.name}</span>
                        </button>
                      </th>
                      <td className="border-b border-zinc-100 px-3 py-2.5 text-right font-medium tabular-nums text-emerald-700">
                        {person.completed}
                      </td>
                      <td className="border-b border-zinc-100 px-3 py-2.5 text-right tabular-nums text-zinc-700">{person.open}</td>
                      <td className="border-b border-zinc-100 px-3 py-2.5 text-right tabular-nums">
                        {person.overdue > 0 ? (
                          <span className="inline-flex rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-700">{person.overdue}</span>
                        ) : (
                          <span className="text-zinc-400">0</span>
                        )}
                      </td>
                      <td className="border-b border-zinc-100 px-3 py-2">
                        <Trend buckets={buckets} name={person.name} daily={daily} />
                      </td>
                      <td className="border-b border-zinc-100 pr-2 text-zinc-300 group-hover:text-zinc-500">
                        <ChevronRight className="size-4" aria-hidden />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">
            Completed counts tasks finished in the period (in your time zone). Open and Overdue are as of today. Click a
            person for their day-by-day view.
          </p>
        </>
      )}
    </div>
  );
}

function Total({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className={`text-xl font-semibold tabular-nums ${tone}`}>{value.toLocaleString("en-US")}</dd>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = "right",
}: {
  label: string;
  sortKey: PeopleSort;
  sort: { key: PeopleSort; dir: SortDir };
  onSort: (key: PeopleSort) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  const Icon = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`sticky top-0 z-[1] border-b border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs font-medium text-zinc-500 ${
        align === "left" ? "w-64 text-left" : "w-28 text-right"
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 rounded hover:text-zinc-900 ${active ? "text-zinc-900" : ""}`}
      >
        {label}
        {active ? <Icon className="size-3" aria-hidden /> : null}
      </button>
    </th>
  );
}

function Trend({ buckets, name, daily }: { buckets: TrendBucket[]; name: string; daily: boolean }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  return (
    <span className="flex items-end gap-0.5" style={{ height: 28 }}>
      <span className="sr-only">
        {name}:{" "}
        {total === 0 ? "nothing completed in the period" : buckets.map((b) => `${b.label} ${b.count}`).join(", ")}
      </span>
      {buckets.map((b) => (
        <span
          key={b.start}
          aria-hidden
          title={`${daily ? "" : "Week of "}${b.label}: ${b.count} completed${b.dayOff ? " (day off)" : ""}`}
          className={`flex h-full flex-col justify-end ${daily ? "w-3" : "w-2.5"} ${b.dayOff ? "opacity-50" : ""}`}
        >
          <span
            className={`block w-full rounded-sm ${b.count === 0 ? "bg-zinc-200" : b.dayOff ? "bg-emerald-300" : "bg-emerald-500"}`}
            style={{ height: b.count === 0 ? 2 : `${Math.max(12, (b.count / max) * 100)}%` }}
          />
        </span>
      ))}
    </span>
  );
}

const MODES = [
  { value: "people", label: "People" },
  { value: "grid", label: "Day by day" },
] as const;

// People (the default) or the day-by-day grid (?view=grid). Switching drops the grid's one-person focus.
export function WorkloadModeSwitch({ mode }: { mode: "people" | "grid" }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startNavigation] = useTransition();
  return (
    <div className="flex items-center gap-2 px-gutter pt-3">
      <Segmented
        label="Workload view"
        options={MODES}
        value={mode}
        onChange={(next) => {
          const params = new URLSearchParams(searchParams.toString());
          params.delete("task");
          params.delete("person");
          if (next === "grid") params.set("view", "grid");
          else params.delete("view");
          const query = params.toString();
          startNavigation(() => router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }));
        }}
      />
    </div>
  );
}
