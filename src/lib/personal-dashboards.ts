// The starter widgets a new personal dashboard gets (Reports → My dashboards → New dashboard).
//
// Nov 2 notes (batch 13, note 90): these go in one insert, and a multi-row insert sends null for any column
// a row leaves out (it doesn't fall back to the column's default) — the Completed per week widget used to
// be the only one with series_interval, so every other row failed its NOT NULL check and creating a
// dashboard failed. Every row names every column (the database also takes the defaults since this batch).
// Unit-tested (tests/unit/nov2-batch13.test.ts).

const ORDER_STEP = 1024;

export type StarterWidget = {
  dashboard_id: string;
  kind: "count" | "by_project" | "completed_series";
  title: string;
  filters: { status?: "open" | "overdue" };
  series_interval: "day" | "week";
  sort_order: number;
};

export function starterDashboardWidgets(dashboardId: string): StarterWidget[] {
  const rows: Omit<StarterWidget, "dashboard_id" | "sort_order">[] = [
    { kind: "count", title: "Open tasks", filters: { status: "open" }, series_interval: "week" },
    { kind: "count", title: "Overdue", filters: { status: "overdue" }, series_interval: "week" },
    { kind: "completed_series", title: "Completed per week", filters: {}, series_interval: "week" },
    { kind: "by_project", title: "Open tasks by project", filters: { status: "open" }, series_interval: "week" },
  ];
  return rows.map((row, index) => ({ ...row, dashboard_id: dashboardId, sort_order: (index + 1) * ORDER_STEP }));
}
