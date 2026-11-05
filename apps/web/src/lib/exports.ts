import "server-only";
import { displayName } from "@alhc/core/people";
import { displayTaskTitle } from "@alhc/core/request-numbers";
import { groupTasks } from "@/components/project/view-groups";
import type { CsvCell, CsvRows } from "@alhc/core/csv";
import type { ApiContext } from "@alhc/core/api/core/context";
import type { ReportCountRow } from "@alhc/core/api/exports/model";
import {
  exportAllProjectsRows,
  exportCells,
  exportMatchingIds,
  exportOverdueRows,
  exportSectionNames,
  exportTaskKeys,
  exportWorkspaceReportRows,
} from "@alhc/core/api/exports/queries";
import { listProfiles } from "@alhc/core/api/people/queries";
import { type Profile } from "@alhc/core/api/people/model";
import { getPortfolio, listPortfolioRollupProjects, portfolioReport } from "@alhc/core/api/portfolios/queries";
import { getProject, listLatestStatusUpdates, listReadableProjects, listSections } from "@alhc/core/api/projects/queries";
import { reportCompletedSeries } from "@alhc/core/api/reports/queries";
import { listVisibleTags, tagsEnabled } from "@alhc/core/api/tags/queries";
import { searchTasks } from "@alhc/core/api/tasks/queries";
import { type ProjectTask } from "@alhc/core/api/tasks/model";
import { getProjectView, listDashboardWidgets, projectMetrics } from "@alhc/core/api/views/queries";
import { listProjectFields } from "@alhc/core/api/fields/queries";
import { fieldChips, fieldNameWithSymbol, type FieldDef } from "@alhc/core/fields";
import { PROJECT_STATUS_LABELS, isProjectStatus, progressPercent, type PortfolioCounts } from "@alhc/core/portfolios";
import { isSeriesInterval, seriesLabel, type ReportFilters } from "@alhc/core/reports";
import type { Json } from "@alhc/core/supabase/database.types";
import {
  columnsOf,
  decodeConfig,
  groupOf,
  pruneConfig,
  pruneFilters,
  refFieldId,
  sortOf,
  withoutTags,
  type ViewConfig,
} from "@alhc/core/views";
import { tagsFor } from "@alhc/core/tags";

// CSV builders for the export route (src/app/export/[kind]/route.ts). Each one reads through the same
// access-checked queries as the page it mirrors (the data-access layer, packages/core/src/api/) with the context the
// route made from the signed-in user's cookies — never the service role — so an export only ever contains
// rows RLS lets that person read. `null` = not found / no access.
//
// Since Real features 4 there is no row cap: `rows` is an async iterable that reads a page at a time
// (keyset pages through task memberships and the overdue report, 1,000 rows each — PostgREST's max_rows
// on the hosted project — and the cells of 250 tasks at a time), and the route streams it. Only the keys
// that decide the List's order (title, dates, section, assignee, the sort / group field's value) are held
// for every matching task; the rest of each row is read and written in chunks. The context is made in the
// request: the stream is read after the route has returned, where cookies() isn't available any more (its
// client keeps the session it read). The paged reads themselves live in packages/core/src/api/exports/queries.ts.

export type ExportResult = { title: string; header: string[]; rows: CsvRows } | null;

// Tasks per chunk of cells.
const CHUNK = 250;

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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
// custom field values as text (numbers stay numbers). Every matching task, however many.
export async function exportList(ctx: ApiContext, projectId: string, viewId: string | null, draft: string | null, timeZone: string): Promise<ExportResult> {
  const project = await getProject(ctx, projectId);
  if (!project) return null;
  const view = viewId ? await getProjectView(ctx, viewId) : null;
  if (viewId && (!view || view.projectId !== projectId)) return null;

  const [sections, profiles, fields, tags, tagsOn] = await Promise.all([
    listSections(ctx, projectId),
    listProfiles(ctx),
    listProjectFields(ctx, projectId),
    listVisibleTags(ctx),
    tagsEnabled(ctx),
  ]);
  const context = {
    sectionIds: new Set(sections.map((s) => s.id)),
    fields,
    profileIds: new Set(profiles.map((p) => p.id)),
    tagIds: new Set(tags.map((t) => t.id)),
  };
  const tagsById = new Map(tags.map((t) => [t.id, t] as const));
  // Oct 26 notes (batch 3): with the workspace's tags off, no tag filter, grouping, or column.
  const tagless = (c: ViewConfig) => (tagsOn ? c : withoutTags(c));
  const base = tagless(pruneConfig(view?.config ?? {}, context));
  const config = tagless(pruneConfig(decodeConfig(draft ?? undefined) ?? base, context));
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const sectionNames = new Map(sections.map((s) => [s.id, s.name]));
  const person = people(profiles);
  const personName = (profileId: string) => person(profileId) || null;
  const columns = columnsOf(config, fields, tagsOn).filter((c) => c !== "section");

  const header = ["Task", "Section"];
  const cells: ((task: ProjectTask) => CsvCell)[] = [
    (t) => displayTaskTitle(t.title, t.requestLabel),
    (t) => (t.sectionId ? (sectionNames.get(t.sectionId) ?? "") : "No section"),
  ];
  const columnFieldIds: string[] = [];
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
      // A number field's symbol goes in the header ("Budget ($)"); its cells stay raw numbers so
      // spreadsheets can add them up (item 49).
      header.push(fieldNameWithSymbol(field));
      if (!field.boundToSections) columnFieldIds.push(field.id);
      cells.push((t) =>
        fieldCell(field, t.fieldValues[field.id], personName, t.sectionId ? (sectionNames.get(t.sectionId) ?? null) : null),
      );
    }
  }
  header.push("Tags", "Completed on", "Task ID");
  cells.push(
    (t) => tagsFor(t.tagIds, tagsById).map((tag) => tag.name).join(", ") || null,
    (t) => day(t.completedAt),
    (t) => t.id,
  );

  // What the order needs besides the keys: the sort / group field's values, and tags to group by tag.
  const orderFieldIds = [
    ...new Set(
      [...sortOf(config).map((s) => s.key), groupOf(config)]
        .filter((key) => key.startsWith("field:"))
        .flatMap((key) => refFieldId(key) ?? []),
    ),
  ].filter((fid) => fields.some((f) => f.id === fid && !f.boundToSections));
  const groupByTag = groupOf(config) === "tag";
  const restFieldIds = columnFieldIds.filter((fid) => !orderFieldIds.includes(fid));

  // The context was made in the request (the route): the stream is read after the route has returned,
  // where cookies() isn't available any more (its client keeps the session it read).
  async function* rows(): AsyncGenerator<CsvCell[]> {
    const [keys, matching] = await Promise.all([
      exportTaskKeys(ctx, projectId),
      exportMatchingIds(ctx, projectId, config.filters ?? {}, timeZone),
    ]);
    const tasks = keys.filter((t) => matching.has(t.id));
    if (orderFieldIds.length || groupByTag) {
      for (const chunk of chunks(tasks)) {
        const { values, tags: tagIds } = await exportCells(ctx, chunk.map((t) => t.id), orderFieldIds, groupByTag);
        for (const t of chunk) {
          t.fieldValues = values.get(t.id) ?? {};
          t.tagIds = tagIds.get(t.id) ?? [];
        }
      }
    }
    const seen = new Set<string>();
    const ordered: ProjectTask[] = [];
    for (const group of groupTasks(tasks, config, { sections, profilesById, fields, tags })) {
      for (const task of group.tasks) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        ordered.push(task);
      }
    }
    for (const chunk of chunks(ordered)) {
      const { values, tags: tagIds } = await exportCells(ctx, chunk.map((t) => t.id), restFieldIds, !groupByTag);
      for (const task of chunk) {
        if (restFieldIds.length) task.fieldValues = { ...task.fieldValues, ...(values.get(task.id) ?? {}) };
        if (!groupByTag) task.tagIds = tagIds.get(task.id) ?? [];
        yield cells.map((cell) => cell(task));
      }
    }
  }

  return { title: `${project.name} ${view?.name ?? "List"}`, header, rows: rows() };
}

// Search: the same results as the search page (search_tasks under RLS, up to 50). Project = the first one
// the task was added to that the viewer can read (search_tasks' home_project_name column; Oct 29 notes,
// 55b: there's no home project); the name carries that task's first number.
export async function exportSearch(ctx: ApiContext, query: string): Promise<ExportResult> {
  const trimmed = query.trim();
  const header = ["Task", "Project", "Completed", "Due date", "Task ID"];
  if (!trimmed) return { title: "search", header, rows: [] };
  const results = await searchTasks(ctx, trimmed.slice(0, 200));
  return {
    title: `search ${trimmed}`,
    header,
    rows: results.map((r) => [r.title, r.home_project_name, Boolean(r.completed_at), r.due_on, r.id]),
  };
}

const WIDGET_GROUP = { count: "none", by_section: "section", by_assignee: "assignee" } as const;

// Project dashboard: one row per widget bucket (a number widget is a single "Total" row).
export async function exportProjectDashboard(ctx: ApiContext, projectId: string, timeZone: string): Promise<ExportResult> {
  const project = await getProject(ctx, projectId);
  if (!project) return null;
  const [widgets, sections, profiles, fields] = await Promise.all([
    listDashboardWidgets(ctx, projectId),
    listSections(ctx, projectId),
    listProfiles(ctx),
    listProjectFields(ctx, projectId),
  ]);
  const context = { sectionIds: new Set(sections.map((s) => s.id)), fields, profileIds: new Set(profiles.map((p) => p.id)) };
  const sectionNames = new Map(sections.map((s) => [s.id, s.name]));
  const person = people(profiles);
  const rows: CsvCell[][] = [];
  for (const widget of widgets) {
    const buckets = await projectMetrics(ctx, projectId, pruneFilters(widget.filters, context), WIDGET_GROUP[widget.kind], timeZone);
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
  return { title: `${project.name} dashboard`, header: ["Widget", "Group", "Bucket", "Tasks"], rows };
}

const COUNT_HEADER = ["Tasks", "Incomplete", "Overdue", "Completed (last 7 days)", "Complete", "Progress %"];
const countCells = (c: PortfolioCounts): CsvCell[] => [c.total, c.incomplete, c.overdue, c.completedRecent, c.completed, percent(c)];

const toCounts = (r: Omit<ReportCountRow, "bucket" | "project_id">): PortfolioCounts => ({
  total: Number(r.task_count),
  completed: Number(r.completed_count),
  incomplete: Number(r.incomplete_count),
  overdue: Number(r.overdue_count),
  completedRecent: Number(r.completed_recent_count),
});

// Workspace report tables. `breakdown` = totals, by project, by section, and by assignee in one table
// (the Group column tells them apart); `series` = completed per day or week; `overdue` = the overdue
// list (every overdue task, however many); `projects` = the all-projects report.
export async function exportWorkspaceReport(
  ctx: ApiContext,
  table: string,
  filters: ReportFilters,
  interval: string,
  timeZone: string,
): Promise<ExportResult> {
  const profiles = await listProfiles(ctx);
  const person = people(profiles);

  if (table === "series") {
    const bucket = isSeriesInterval(interval) ? interval : "week";
    const series = await reportCompletedSeries(ctx, filters, bucket, timeZone);
    return {
      title: `completed per ${bucket}`,
      header: [bucket === "week" ? "Week starting" : "Day", "Label", "Completed"],
      rows: series.map((p) => [p.start, seriesLabel(p.start, bucket), p.count]),
    };
  }

  if (table === "overdue") {
    const projects = await listReadableProjects(ctx);
    const projectNames = new Map(projects.map((p) => [p.id, p.name]));
    async function* rows(): AsyncGenerator<CsvCell[]> {
      for await (const t of exportOverdueRows(ctx, filters, timeZone)) {
        yield [t.title, Boolean(t.parentTaskId), projectNames.get(t.projectId) ?? "", person(t.assigneeId), t.dueOn, t.daysOverdue, t.taskId];
      }
    }
    return {
      title: "overdue tasks",
      header: ["Task", "Subtask", "Project", "Assignee", "Due date", "Days overdue", "Task ID"],
      rows: rows(),
    };
  }

  if (table === "projects") {
    const projects = await collect(exportAllProjectsRows(ctx, timeZone));
    const latest = await listLatestStatusUpdates(ctx, projects.flatMap((p) => (p.project_id ? [p.project_id] : [])));
    return {
      title: "all projects report",
      header: ["Project", "Status", "Latest update", ...COUNT_HEADER],
      rows: projects.map((p) => [p.name, statusLabel(p.status), latest.get(p.project_id)?.note ?? "", ...countCells(toCounts(p))]),
    };
  }

  if (table !== "breakdown") return null;
  const projects = await listReadableProjects(ctx);
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  async function* rows(): AsyncGenerator<CsvCell[]> {
    // One row per bucket (not per task), so the four breakdowns are read side by side.
    const [totals, byProject, bySection, byAssignee] = await Promise.all(
      (["none", "project", "section", "assignee"] as const).map((groupBy) =>
        collect(exportWorkspaceReportRows(ctx, filters, groupBy, timeZone)),
      ),
    );
    for (const r of totals) yield ["Total", "All matching tasks", "", ...countCells(toCounts(r))];
    for (const r of byProject) yield ["Project", projectNames.get(r.bucket ?? "") ?? "", "", ...countCells(toCounts(r))];
    for (const chunk of chunks(bySection, CHUNK)) {
      const ids = chunk.flatMap((r) => (r.bucket ? [r.bucket] : []));
      const sections = await exportSectionNames(ctx, ids);
      for (const r of chunk) {
        const name = r.bucket ? (sections.get(r.bucket) ?? "Deleted section") : "No section";
        yield ["Section", name, projectNames.get(r.project_id ?? "") ?? "", ...countCells(toCounts(r))];
      }
    }
    for (const r of byAssignee) yield ["Assignee", r.bucket ? person(r.bucket) : "Unassigned", "", ...countCells(toCounts(r))];
  }
  return { title: "workspace report", header: ["Group", "Name", "Project", ...COUNT_HEADER], rows: rows() };
}

// Portfolio report: by project (with the latest status update) then by assignee, then the total.
export async function exportPortfolioReport(ctx: ApiContext, portfolioId: string, timeZone: string): Promise<ExportResult> {
  const portfolio = await getPortfolio(ctx, portfolioId);
  if (!portfolio) return null;
  const [projects, byProject, byAssignee, totals, profiles] = await Promise.all([
    listPortfolioRollupProjects(ctx, portfolioId),
    portfolioReport(ctx, portfolioId, "project", timeZone),
    portfolioReport(ctx, portfolioId, "assignee", timeZone),
    portfolioReport(ctx, portfolioId, "none", timeZone),
    listProfiles(ctx),
  ]);
  const latest = await listLatestStatusUpdates(ctx, projects.map((p) => p.id));
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
    header: ["Group", "Name", "Status", "Latest update", ...COUNT_HEADER],
    rows,
  };
}
