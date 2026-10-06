import "server-only";
import { displayName } from "@/components/avatar";
import { groupTasks } from "@/components/project/view-groups";
import { csvTable, MAX_EXPORT_ROWS, type CsvCell, type CsvTable } from "@/lib/csv";
import {
  allProjectsReport,
  filterProjectTaskIds,
  getPortfolio,
  getProject,
  getProjectView,
  listDashboardWidgets,
  listLatestStatusUpdates,
  listPortfolioRollupProjects,
  listProfiles,
  listProjectFields,
  listProjectTasks,
  listSectionLabels,
  listSections,
  portfolioReport,
  projectMetrics,
  reportCompletedSeries,
  reportOverdueTasks,
  searchTasks,
  workspaceReport,
  type Profile,
} from "@/lib/data";
import { fieldChips, type FieldDef } from "@/lib/fields";
import { PROJECT_STATUS_LABELS, isProjectStatus, progressPercent, type PortfolioCounts } from "@/lib/portfolios";
import { isSeriesInterval, seriesLabel, type ReportFilters } from "@/lib/reports";
import type { Json } from "@/lib/supabase/database.types";
import { columnsOf, decodeConfig, pruneConfig, pruneFilters, refFieldId } from "@/lib/views";

// CSV builders for the export route (src/app/export/[kind]/route.ts). Each one reads through the same
// data.ts functions as the page it mirrors — the signed-in user's Supabase client, never the service
// role — so an export only ever contains rows RLS lets that person read. `null` = not found / no access.

export type ExportResult = { title: string; table: CsvTable } | null;

const statusLabel = (status: string) => (isProjectStatus(status) ? PROJECT_STATUS_LABELS[status] : status);
const percent = (counts: PortfolioCounts) => progressPercent(counts.completed, counts.total);
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

function people(profiles: Profile[]) {
  const byId = new Map(profiles.map((p) => [p.id, displayName(p)]));
  return (profileId: string | null) => (profileId ? (byId.get(profileId) ?? "Former member") : "");
}

function fieldCell(field: FieldDef, value: Json | undefined, personName: (id: string) => string | null, sectionName: string | null): CsvCell {
  if (!field.boundToSections && field.fieldType === "number") return typeof value === "number" ? value : null;
  return fieldChips(field, value, { personName, sectionName })
    .map((chip) => chip.label)
    .join("; ");
}

// List: the view's filters (or the `?f=` draft), its sort and grouping order, and its columns, with
// custom field values as text (numbers stay numbers).
export async function exportList(projectId: string, viewId: string | null, draft: string | null, timeZone: string): Promise<ExportResult> {
  const project = await getProject(projectId);
  if (!project) return null;
  const view = viewId ? await getProjectView(viewId) : null;
  if (viewId && (!view || view.projectId !== projectId)) return null;

  const [sections, tasks, profiles, fields] = await Promise.all([
    listSections(projectId),
    listProjectTasks(projectId),
    listProfiles(),
    listProjectFields(projectId),
  ]);
  const context = { sectionIds: new Set(sections.map((s) => s.id)), fields, profileIds: new Set(profiles.map((p) => p.id)) };
  const base = pruneConfig(view?.config ?? {}, context);
  const config = pruneConfig(decodeConfig(draft ?? undefined) ?? base, context);
  const matching = await filterProjectTaskIds(projectId, config.filters ?? {}, timeZone);
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const groups = groupTasks(
    tasks.filter((t) => matching.has(t.id)),
    config,
    { sections, profilesById, fields },
  );
  const sectionNames = new Map(sections.map((s) => [s.id, s.name]));
  const person = people(profiles);
  const personName = (profileId: string) => person(profileId) || null;
  const columns = columnsOf(config, fields).filter((c) => c !== "section");

  const header = ["Task", "Section"];
  const cells: ((task: (typeof tasks)[number]) => CsvCell)[] = [
    (t) => t.title,
    (t) => (t.sectionId ? (sectionNames.get(t.sectionId) ?? "") : "No section"),
  ];
  for (const column of columns) {
    if (column === "assignee") {
      header.push("Assignee");
      cells.push((t) => person(t.assigneeId));
    } else if (column === "due") {
      header.push("Due date");
      cells.push((t) => t.dueOn);
    } else if (column === "start") {
      header.push("Start date");
      cells.push((t) => t.startOn);
    } else {
      const field = fields.find((f) => f.id === refFieldId(column));
      if (!field) continue;
      header.push(field.name);
      cells.push((t) =>
        fieldCell(field, t.fieldValues[field.id], personName, t.sectionId ? (sectionNames.get(t.sectionId) ?? null) : null),
      );
    }
  }
  header.push("Completed on", "Task ID");
  cells.push((t) => day(t.completedAt), (t) => t.id);

  const seen = new Set<string>();
  const rows: CsvCell[][] = [];
  for (const group of groups) {
    for (const task of group.tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      rows.push(cells.map((cell) => cell(task)));
    }
  }
  return { title: `${project.name} ${view?.name ?? "List"}`, table: csvTable(header, rows) };
}

// Search: the same results as the search page (search_tasks under RLS, up to 50).
export async function exportSearch(query: string): Promise<ExportResult> {
  const trimmed = query.trim();
  if (!trimmed) return { title: "search", table: csvTable(["Task", "Project", "Completed", "Due date", "Task ID"], []) };
  const results = await searchTasks(trimmed.slice(0, 200));
  return {
    title: `search ${trimmed}`,
    table: csvTable(
      ["Task", "Project", "Completed", "Due date", "Task ID"],
      results.map((r) => [r.title, r.home_project_name, Boolean(r.completed_at), r.due_on, r.id]),
    ),
  };
}

const WIDGET_GROUP = { count: "none", by_section: "section", by_assignee: "assignee" } as const;

// Project dashboard: one row per widget bucket (a number widget is a single "Total" row).
export async function exportProjectDashboard(projectId: string, timeZone: string): Promise<ExportResult> {
  const project = await getProject(projectId);
  if (!project) return null;
  const [widgets, sections, profiles, fields] = await Promise.all([
    listDashboardWidgets(projectId),
    listSections(projectId),
    listProfiles(),
    listProjectFields(projectId),
  ]);
  const context = { sectionIds: new Set(sections.map((s) => s.id)), fields, profileIds: new Set(profiles.map((p) => p.id)) };
  const sectionNames = new Map(sections.map((s) => [s.id, s.name]));
  const person = people(profiles);
  const rows: CsvCell[][] = [];
  for (const widget of widgets) {
    const buckets = await projectMetrics(projectId, pruneFilters(widget.filters, context), WIDGET_GROUP[widget.kind], timeZone);
    if (widget.kind === "count") {
      rows.push([widget.title, "Total", "", buckets.reduce((sum, b) => sum + b.count, 0)]);
      continue;
    }
    for (const b of buckets) {
      const label =
        widget.kind === "by_section"
          ? b.bucket
            ? (sectionNames.get(b.bucket) ?? "Deleted section")
            : "No section"
          : b.bucket
            ? person(b.bucket)
            : "Unassigned";
      rows.push([widget.title, widget.kind === "by_section" ? "Section" : "Assignee", label, b.count]);
    }
  }
  return { title: `${project.name} dashboard`, table: csvTable(["Widget", "Group", "Bucket", "Tasks"], rows) };
}

const COUNT_HEADER = ["Tasks", "Incomplete", "Overdue", "Completed (last 7 days)", "Complete", "Progress %"];
const countCells = (c: PortfolioCounts): CsvCell[] => [c.total, c.incomplete, c.overdue, c.completedRecent, c.completed, percent(c)];

// Workspace report tables. `breakdown` = totals, by project, by section, and by assignee in one table
// (the Group column tells them apart); `series` = completed per day or week; `overdue` = the overdue
// list; `projects` = the all-projects report.
export async function exportWorkspaceReport(
  table: string,
  filters: ReportFilters,
  interval: string,
  timeZone: string,
): Promise<ExportResult> {
  const profiles = await listProfiles();
  const person = people(profiles);

  if (table === "series") {
    const bucket = isSeriesInterval(interval) ? interval : "week";
    const series = await reportCompletedSeries(filters, bucket, timeZone);
    return {
      title: `completed per ${bucket}`,
      table: csvTable(
        [bucket === "week" ? "Week starting" : "Day", "Label", "Completed"],
        series.map((p) => [p.start, seriesLabel(p.start, bucket), p.count]),
      ),
    };
  }

  if (table === "overdue") {
    const [overdue, projects] = await Promise.all([reportOverdueTasks(filters, timeZone, MAX_EXPORT_ROWS), allProjectsReport(timeZone)]);
    const projectNames = new Map(projects.map((p) => [p.id, p.name]));
    return {
      title: "overdue tasks",
      table: csvTable(
        ["Task", "Subtask", "Project", "Assignee", "Due date", "Days overdue", "Task ID"],
        overdue.map((t) => [
          t.title,
          Boolean(t.parentTaskId),
          projectNames.get(t.projectId) ?? "",
          person(t.assigneeId),
          t.dueOn,
          t.daysOverdue,
          t.taskId,
        ]),
      ),
    };
  }

  if (table === "projects") {
    const projects = await allProjectsReport(timeZone);
    const latest = await listLatestStatusUpdates(projects.map((p) => p.id));
    return {
      title: "all projects report",
      table: csvTable(
        ["Project", "Status", "Latest update", ...COUNT_HEADER],
        projects.map((p) => [p.name, statusLabel(p.status), latest.get(p.id)?.note ?? "", ...countCells(p.counts)]),
      ),
    };
  }

  if (table !== "breakdown") return null;
  const [totals, byProject, bySection, byAssignee, projects] = await Promise.all([
    workspaceReport(filters, "none", timeZone),
    workspaceReport(filters, "project", timeZone),
    workspaceReport(filters, "section", timeZone),
    workspaceReport(filters, "assignee", timeZone),
    allProjectsReport(timeZone),
  ]);
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const sections = await listSectionLabels(bySection.flatMap((r) => (r.bucket ? [r.bucket] : [])));
  const rows: CsvCell[][] = [];
  for (const r of totals) rows.push(["Total", "All matching tasks", "", ...countCells(r)]);
  for (const r of byProject) rows.push(["Project", projectNames.get(r.bucket ?? "") ?? "", "", ...countCells(r)]);
  for (const r of bySection) {
    const name = r.bucket ? (sections.get(r.bucket)?.name ?? "Deleted section") : "No section";
    rows.push(["Section", name, projectNames.get(r.projectId ?? "") ?? "", ...countCells(r)]);
  }
  for (const r of byAssignee) rows.push(["Assignee", r.bucket ? person(r.bucket) : "Unassigned", "", ...countCells(r)]);
  return { title: "workspace report", table: csvTable(["Group", "Name", "Project", ...COUNT_HEADER], rows) };
}

// Portfolio report: by project (with the latest status update) then by assignee, then the total.
export async function exportPortfolioReport(portfolioId: string, timeZone: string): Promise<ExportResult> {
  const portfolio = await getPortfolio(portfolioId);
  if (!portfolio) return null;
  const [projects, byProject, byAssignee, totals, profiles] = await Promise.all([
    listPortfolioRollupProjects(portfolioId),
    portfolioReport(portfolioId, "project", timeZone),
    portfolioReport(portfolioId, "assignee", timeZone),
    portfolioReport(portfolioId, "none", timeZone),
    listProfiles(),
  ]);
  const latest = await listLatestStatusUpdates(projects.map((p) => p.id));
  const counts = new Map(byProject.map((r) => [r.bucket, r]));
  const person = people(profiles);
  const empty: PortfolioCounts = { total: 0, completed: 0, incomplete: 0, overdue: 0, completedRecent: 0 };
  const rows: CsvCell[][] = [
    ...projects.map((p): CsvCell[] => [
      "Project",
      p.name,
      statusLabel(p.status),
      latest.get(p.id)?.note ?? "",
      ...countCells(counts.get(p.id) ?? empty),
    ]),
    ...byAssignee.map((r): CsvCell[] => ["Assignee", r.bucket ? person(r.bucket) : "Unassigned", "", "", ...countCells(r)]),
    ...totals.map((r): CsvCell[] => ["Total", "Portfolio total (each task once)", "", "", ...countCells(r)]),
  ];
  return {
    title: `${portfolio.name} report`,
    table: csvTable(["Group", "Name", "Status", "Latest update", ...COUNT_HEADER], rows),
  };
}
