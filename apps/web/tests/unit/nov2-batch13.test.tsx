// Nov 2 notes, batch 13: the portfolio picker (85), the workload people view (86), nested portfolio projects
// (87), the reports' default window (89), personal dashboard starter widgets (90), and report polish (91).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatTiles, statusBars } from "@/components/reports/report-blocks";
import { CountBarChart } from "@/components/dashboard/bar-chart";
import { starterDashboardWidgets } from "@alhc/core/personal-dashboards";
import { filterPickerProjects, nestedPortfolioProjects, pickedLabel } from "@alhc/core/portfolio-picker";
import { defaultReportWindow, isDefaultWindow, withDefaultWindow } from "@alhc/core/reports";
import { columnCapacity, workloadWindow } from "@alhc/core/workload";
import {
  parseCompletedDays,
  peopleWindow,
  periodLabel,
  sortPeople,
  trendBuckets,
  workweekShort,
  type PersonSummary,
} from "@alhc/core/workload-people";

test("90: every starter widget names every column, so none is sent as null", () => {
  const rows = starterDashboardWidgets("d-1");
  assert.equal(rows.length, 4);
  const keys = Object.keys(rows[0]).sort();
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), keys, "same columns on every row");
    assert.ok(row.series_interval === "week" || row.series_interval === "day");
    assert.ok(row.filters && typeof row.filters === "object");
    assert.equal(row.dashboard_id, "d-1");
  }
  assert.deepEqual(
    rows.map((r) => r.sort_order),
    [1024, 2048, 3072, 4096],
  );
  assert.equal(rows.find((r) => r.kind === "completed_series")?.title, "Completed per week");
});

test("90: the migration's widget guard takes the defaults", () => {
  const sql = fs.readFileSync("../../supabase/migrations/20261102010000_nov2_batch13_a.sql", "utf8");
  assert.match(sql, /new\.series_interval := coalesce\(new\.series_interval, 'week'\)/);
  assert.doesNotMatch(sql, /\b(drop|delete)\b/i, "no removal keywords (the connector refuses them)");
});

test("89: reports open on 30 days centered on today unless the URL says otherwise", () => {
  assert.deepEqual(defaultReportWindow("2026-11-02"), { from: "2026-10-19", to: "2026-11-16" });
  assert.deepEqual(defaultReportWindow("2026-12-25"), { from: "2026-12-11", to: "2027-01-08" });
  assert.deepEqual(withDefaultWindow({}, new URLSearchParams(), "2026-11-02"), { from: "2026-10-19", to: "2026-11-16" });
  assert.deepEqual(withDefaultWindow({ status: "open" }, {}, "2026-11-02"), {
    status: "open",
    from: "2026-10-19",
    to: "2026-11-16",
  });
  assert.deepEqual(withDefaultWindow({}, new URLSearchParams("range=all"), "2026-11-02"), {}, "All dates keeps no window");
  assert.deepEqual(withDefaultWindow({ from: "2026-01-01" }, {}, "2026-11-02"), { from: "2026-01-01" }, "an explicit date wins");
  assert.equal(isDefaultWindow({ from: "2026-10-19", to: "2026-11-16" }, "2026-11-02"), true);
  assert.equal(isDefaultWindow({ from: "2026-10-20", to: "2026-11-16" }, "2026-11-02"), false);
});

test("85: the picker lists addable projects first, already-added ones after, by search", () => {
  const projects = [
    { id: "a", name: "Website", teamName: "Marketing", inPortfolio: true },
    { id: "b", name: "Brochure", teamName: "Marketing", inPortfolio: false },
    { id: "c", name: "Annual report", teamName: "Finance", inPortfolio: false },
  ];
  assert.deepEqual(
    filterPickerProjects(projects, "").map((p) => p.id),
    ["c", "b", "a"],
  );
  assert.deepEqual(
    filterPickerProjects(projects, "market").map((p) => p.id),
    ["b", "a"],
    "matches the team too",
  );
  assert.deepEqual(
    filterPickerProjects(projects, "annual fin").map((p) => p.id),
    ["c"],
    "every word",
  );
  assert.equal(pickedLabel(1, "Add"), "Add 1 project");
  assert.equal(pickedLabel(3, "Added"), "Added 3 projects");
});

test("87: a parent lists nested portfolios' projects once, never its own twice", () => {
  const rollup = [
    { id: "own", name: "Own", portfolioId: "parent", groupId: null, sortOrder: 1 },
    { id: "n1", name: "Nested one", portfolioId: "child-b", groupId: "child-b", sortOrder: 2 },
    { id: "n2", name: "Nested two", portfolioId: "child-a", groupId: "child-a", sortOrder: 1 },
    { id: "deep", name: "Deep", portfolioId: "grandchild", groupId: "child-a", sortOrder: 0 },
    { id: "both", name: "Also own", portfolioId: "child-a", groupId: "child-a", sortOrder: 5 },
  ];
  const names = new Map([
    ["child-a", "Child A"],
    ["child-b", "Child B"],
    ["grandchild", "Grandchild"],
  ]);
  const nested = nestedPortfolioProjects(rollup, ["own", "both"], ["child-a", "child-b"], names);
  assert.deepEqual(
    nested.map((p) => p.id),
    ["n2", "deep", "n1"],
    "in the nested portfolios' order; a direct project isn't repeated",
  );
  assert.equal(nested.find((p) => p.id === "deep")?.fromPortfolioName, "Grandchild", "named after the portfolio it sits in");
  assert.equal(nested.find((p) => p.id === "deep")?.fromPortfolioId, "grandchild");
});

test("86: periods — this week (Sun–Sat), last week, last 30 days, custom", () => {
  // 2026-11-02 is a Monday.
  assert.deepEqual(peopleWindow(undefined, "2026-11-02"), { period: "this_week", start: "2026-11-01", end: "2026-11-07" });
  assert.deepEqual(peopleWindow("last_week", "2026-11-02"), { period: "last_week", start: "2026-10-25", end: "2026-10-31" });
  assert.deepEqual(peopleWindow("last_30", "2026-11-02"), { period: "last_30", start: "2026-10-04", end: "2026-11-02" });
  assert.deepEqual(peopleWindow("custom", "2026-11-02", "2026-09-01", "2026-09-30"), {
    period: "custom",
    start: "2026-09-01",
    end: "2026-09-30",
  });
  assert.equal(peopleWindow("custom", "2026-11-02", "2026-09-30", "2026-09-01").period, "this_week", "backwards falls back");
  assert.equal(peopleWindow("custom", "2026-11-02", "2024-01-01", "2026-09-01").period, "this_week", "over a year falls back");
});

test("86: labels name the workweek (Sun–Thu by default)", () => {
  assert.equal(workweekShort([0, 1, 2, 3, 4]), "Sun–Thu");
  assert.equal(workweekShort([1, 2, 3, 4, 5]), "Mon–Fri");
  assert.equal(workweekShort([0, 2, 4]), "Sun, Tue, Thu");
  assert.equal(
    periodLabel({ period: "this_week", start: "2026-11-01", end: "2026-11-07" }, [0, 1, 2, 3, 4]),
    "This week · Sun, Nov 1 – Sat, Nov 7 (workweek Sun–Thu)",
  );
});

test("86: trend bars are per day for short periods (days off marked) and per week for longer", () => {
  const days = trendBuckets({ start: "2026-11-01", end: "2026-11-07" }, { "2026-11-02": 3, "2026-11-06": 1 }, [0, 1, 2, 3, 4]);
  assert.equal(days.length, 7);
  assert.deepEqual(
    days.map((d) => d.count),
    [0, 3, 0, 0, 0, 1, 0],
  );
  assert.deepEqual(
    days.filter((d) => d.dayOff).map((d) => d.label),
    ["Fri 6", "Sat 7"],
    "Friday and Saturday are days off in a Sun–Thu week",
  );
  const weeks = trendBuckets({ start: "2026-10-04", end: "2026-11-02" }, { "2026-10-04": 2, "2026-10-10": 1, "2026-11-02": 4 });
  assert.equal(weeks[0].start, "2026-10-04");
  assert.equal(weeks[0].end, "2026-10-10");
  assert.equal(weeks[0].count, 3);
  assert.equal(weeks.at(-1)!.start, "2026-11-01");
  assert.equal(weeks.at(-1)!.end, "2026-11-02", "the last week ends with the period");
  assert.equal(weeks.at(-1)!.count, 4);
  assert.equal(weeks.reduce((s, w) => s + w.count, 0), 7);
});

test("86: sorting people and reading the database's per-day counts", () => {
  const rows: PersonSummary[] = [
    { id: "1", name: "Bo", completed: 2, open: 5, overdue: 0, completedDays: {} },
    { id: "2", name: "ann", completed: 2, open: 1, overdue: 3, completedDays: {} },
    { id: "3", name: "Cy", completed: 7, open: 0, overdue: 1, completedDays: {} },
  ];
  assert.deepEqual(sortPeople(rows, "completed", "desc").map((r) => r.id), ["3", "2", "1"], "ties by name");
  assert.deepEqual(sortPeople(rows, "name", "asc").map((r) => r.id), ["2", "1", "3"], "names ignore case");
  assert.deepEqual(sortPeople(rows, "overdue", "asc").map((r) => r.id), ["1", "3", "2"]);
  assert.deepEqual(parseCompletedDays({ "2026-11-02": 2, nope: 1, "2026-11-03": "x", "2026-11-04": 0 }), { "2026-11-02": 2 });
  assert.deepEqual(parseCompletedDays(null), {});
});

test("86: the day-by-day grid shades the workspace's days off and splits capacity over its workdays", () => {
  const { columns } = workloadWindow("2026-11-02", "day", [0, 1, 2, 3, 4]);
  assert.deepEqual(
    columns.slice(0, 7).map((c) => c.weekend),
    [false, false, false, false, false, true, true],
  );
  assert.equal(columnCapacity(10, columns[0], "day", 5), 2);
  assert.equal(columnCapacity(10, columns[5], "day", 5), null, "no capacity on a day off");
});

test("91: stat tiles and status bars wear the status colors with their labels", () => {
  const counts = { total: 10, completed: 4, incomplete: 6, overdue: 2, completedRecent: 3 };
  const html = renderToStaticMarkup(<StatTiles counts={counts} />);
  for (const label of ["Open", "Overdue", "Completed", "Progress"]) assert.ok(html.includes(label), label);
  assert.ok(html.includes("text-red-700"), "overdue reads red");
  assert.ok(html.includes("bg-emerald-50"), "completed has a green accent");
  const calm = renderToStaticMarkup(<StatTiles counts={{ ...counts, overdue: 0 }} />);
  assert.ok(calm.includes("Nothing is late"));
  assert.deepEqual(
    statusBars(counts).map((b) => b.tone),
    ["blue", "red", "green"],
  );
  const chart = renderToStaticMarkup(<CountBarChart data={statusBars(counts)} caption="By status" tone="violet" />);
  assert.ok(chart.includes("bg-red-500") && chart.includes("bg-emerald-500"), "a bar's own tone wins");
  assert.ok(chart.includes("<caption>By status</caption>"), "the table view stays for screen readers");
});
