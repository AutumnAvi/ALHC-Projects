import "server-only";
import { displayName } from "@/components/avatar";
import { displayTaskTitle } from "@/lib/request-numbers";
import { groupTasks } from "@/components/project/view-groups";
import type { CsvCell, CsvRows } from "@/lib/csv";
import {
  getPortfolio,
  getProject,
  getProjectView,
  listDashboardWidgets,
  listLatestStatusUpdates,
  listPortfolioRollupProjects,
  listProfiles,
  listProjectFields,
  listReadableProjects,
  listSections,
  listTags,
  portfolioReport,
  projectMetrics,
  reportCompletedSeries,
  searchTasks,
  type OverdueTask,
  type Profile,
  type ProjectTask,
} from "@/lib/data";
import { fieldChips, type FieldDef } from "@/lib/fields";
import { PROJECT_STATUS_LABELS, isProjectStatus, progressPercent, type PortfolioCounts } from "@/lib/portfolios";
import { isSeriesInterval, reportFiltersJson, seriesLabel, type ReportFilters } from "@/lib/reports";
import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { parseTaskKind } from "@/lib/task-kinds";
import { columnsOf, decodeConfig, groupOf, pruneConfig, pruneFilters, refFieldId, sortOf, toJson, type ViewFilters } from "@/lib/views";
import { tagsFor } from "@/lib/tags";

// CSV builders for the export route (src/app/export/[kind]/route.ts). Each one reads through the same
// access-checked queries as the page it mirrors — the signed-in user's Supabase client, never the service
// role — so an export only ever contains rows RLS lets that person read. `null` = not found / no access.
//
// Since Real features 4 there is no row cap: `rows` is an async iterable that reads a page at a time
// (keyset pages through task memberships and the overdue report, 1,000 rows each — PostgREST's max_rows
// on the hosted project — and the cells of 250 tasks at a time), and the route streams it. Only the keys
// that decide the List's order (title, dates, section, assignee, the sort / group field's value) are held
// for every matching task; the rest of each row is read and written in chunks.

export type ExportResult = { title: string; header: string[]; rows: CsvRows } | null;

// Rows per page of a paged read (the hosted PostgREST's max_rows) and tasks per chunk of cells.
const PAGE = 1000;
const CHUNK = 250;

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Paged<T> = PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>;

// Every row of a paged read, a page at a time (stops at a short page).
async function* pages<T>(read: (from: number, to: number) => Paged<T>, what: string): AsyncGenerator<T> {
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await read(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to export ${what}: ${error.message}`);
    const list = data ?? [];
    yield* list;
    if (list.length < PAGE) return;
  }
}

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

// The project's active task memberships with what ordering needs, by task id in keyset pages.
async function taskKeys(supabase: Supabase, projectId: string): Promise<ProjectTask[]> {
  const out: ProjectTask[] = [];
  let after: string | null = null;
  for (;;) {
    let query = supabase
      .from("task_projects")
      .select(
        "task_id, section_id, sort_order, task:tasks!inner(id, title, req_label, completed_at, start_on, due_on, assignee_id, home_project_id, created_at, kind)",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .is("task.deleted_at", null)
      .order("task_id")
      .limit(PAGE);
    if (after) query = query.gt("task_id", after);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to export tasks: ${error.message}`);
    const list = data ?? [];
    for (const m of list) {
      out.push({
        id: m.task.id,
        title: displayTaskTitle(m.task.title, m.task.req_label),
        completedAt: m.task.completed_at,
        startOn: m.task.start_on,
        dueOn: m.task.due_on,
        assigneeId: m.task.assignee_id,
        homeProjectId: m.task.home_project_id ?? projectId,
        createdAt: m.task.created_at,
        sectionId: m.section_id,
        sortOrder: m.sort_order,
        subtaskCount: 0,
        subtaskDoneCount: 0,
        projectCount: 1,
        fieldValues: {},
        recurring: false,
        blockedBy: 0,
        kind: parseTaskKind(m.task.kind),
        approvalStatus: null,
        tagIds: [],
        commentCount: 0,
      });
    }
    if (list.length === 0) return out;
    after = list[list.length - 1].task_id;
  }
}

// The task ids a view's filters match: one array from filter_project_task_ids (Real features 4), or the
// row-returning filter on a database without it.
async function matchingIds(supabase: Supabase, projectId: string, filters: ViewFilters, timeZone: string): Promise<Set<string>> {
  const result = await supabase.rpc("filter_project_task_ids", { target_project: projectId, filters: toJson(filters), tz: timeZone });
  if (result.error?.code === "PGRST202") {
    const old = await supabase.rpc("filter_project_tasks", { target_project: projectId, filters: toJson(filters), tz: timeZone });
    if (old.error) throw new Error(`Failed to export tasks: ${old.error.message}`);
    return new Set((old.data ?? []).map((r) => r.task_id));
  }
  if (result.error) throw new Error(`Failed to export tasks: ${result.error.message}`);
  return new Set(result.data ?? []);
}

// Field values (of these fields) and tag ids for a chunk of tasks, read through RLS.
async function cellsFor(supabase: Supabase, taskIds: string[], fieldIds: string[], withTags: boolean) {
  const values = new Map<string, Record<string, Json>>();
  const tags = new Map<string, string[]>();
  await Promise.all([
    fieldIds.length
      ? (async () => {
          for await (const v of pages(
            (from, to) =>
              supabase
                .from("task_field_values")
                .select("task_id, field_id, value")
                .in("task_id", taskIds)
                .in("field_id", fieldIds)
                .not("value", "is", null)
                .order("task_id")
                .order("field_id")
                .range(from, to),
            "field values",
          )) {
            const record = values.get(v.task_id) ?? {};
            record[v.field_id] = v.value;
            values.set(v.task_id, record);
          }
        })()
      : Promise.resolve(),
    withTags
      ? (async () => {
          for await (const t of pages(
            (from, to) =>
              supabase
                .from("task_tags")
                .select("id, task_id, tag_id, tag:tags!inner(id)")
                .in("task_id", taskIds)
                .is("deleted_at", null)
                .is("tag.deleted_at", null)
                .order("id")
                .range(from, to),
            "tags",
          )) {
            const list = tags.get(t.task_id) ?? [];
            list.push(t.tag_id);
            tags.set(t.task_id, list);
          }
        })()
      : Promise.resolve(),
  ]);
  return { values, tags };
}

// List: the view's filters (or the `?f=` draft), its sort and grouping order, and its columns, with
// custom field values as text (numbers stay numbers). Every matching task, however many.
export async function exportList(projectId: string, viewId: string | null, draft: string | null, timeZone: string): Promise<ExportResult> {
  const project = await getProject(projectId);
  if (!project) return null;
  const view = viewId ? await getProjectView(viewId) : null;
  if (viewId && (!view || view.projectId !== projectId)) return null;

  const [sections, profiles, fields, tags] = await Promise.all([
    listSections(projectId),
    listProfiles(),
    listProjectFields(projectId),
    listTags(),
  ]);
  const context = {
    sectionIds: new Set(sections.map((s) => s.id)),
    fields,
    profileIds: new Set(profiles.map((p) => p.id)),
    tagIds: new Set(tags.map((t) => t.id)),
  };
  const tagsById = new Map(tags.map((t) => [t.id, t] as const));
  const base = pruneConfig(view?.config ?? {}, context);
  const config = pruneConfig(decodeConfig(draft ?? undefined) ?? base, context);
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const sectionNames = new Map(sections.map((s) => [s.id, s.name]));
  const person = people(profiles);
  const personName = (profileId: string) => person(profileId) || null;
  const columns = columnsOf(config, fields).filter((c) => c !== "section");

  const header = ["Task", "Section"];
  const cells: ((task: ProjectTask) => CsvCell)[] = [
    (t) => t.title,
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
      header.push(field.name);
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

  // Made here, in the request: the stream is read after the route has returned, where cookies() isn't
  // available any more (the client keeps the session it read).
  const supabase = await createClient();
  async function* rows(): AsyncGenerator<CsvCell[]> {
    const [keys, matching] = await Promise.all([
      taskKeys(supabase, projectId),
      matchingIds(supabase, projectId, config.filters ?? {}, timeZone),
    ]);
    const tasks = keys.filter((t) => matching.has(t.id));
    if (orderFieldIds.length || groupByTag) {
      for (const chunk of chunks(tasks)) {
        const { values, tags: tagIds } = await cellsFor(supabase, chunk.map((t) => t.id), orderFieldIds, groupByTag);
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
      const { values, tags: tagIds } = await cellsFor(supabase, chunk.map((t) => t.id), restFieldIds, !groupByTag);
      for (const task of chunk) {
        if (restFieldIds.length) task.fieldValues = { ...task.fieldValues, ...(values.get(task.id) ?? {}) };
        if (!groupByTag) task.tagIds = tagIds.get(task.id) ?? [];
        yield cells.map((cell) => cell(task));
      }
    }
  }

  return { title: `${project.name} ${view?.name ?? "List"}`, header, rows: rows() };
}

// Search: the same results as the search page (search_tasks under RLS, up to 50).
export async function exportSearch(query: string): Promise<ExportResult> {
  const trimmed = query.trim();
  const header = ["Task", "Project", "Completed", "Due date", "Task ID"];
  if (!trimmed) return { title: "search", header, rows: [] };
  const results = await searchTasks(trimmed.slice(0, 200));
  return {
    title: `search ${trimmed}`,
    header,
    rows: results.map((r) => [r.title, r.home_project_name, Boolean(r.completed_at), r.due_on, r.id]),
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
  return { title: `${project.name} dashboard`, header: ["Widget", "Group", "Bucket", "Tasks"], rows };
}

const COUNT_HEADER = ["Tasks", "Incomplete", "Overdue", "Completed (last 7 days)", "Complete", "Progress %"];
const countCells = (c: PortfolioCounts): CsvCell[] => [c.total, c.incomplete, c.overdue, c.completedRecent, c.completed, percent(c)];

type ReportCountRow = {
  bucket: string | null;
  project_id: string | null;
  task_count: number;
  completed_count: number;
  incomplete_count: number;
  overdue_count: number;
  completed_recent_count: number;
};

const toCounts = (r: Omit<ReportCountRow, "bucket" | "project_id">): PortfolioCounts => ({
  total: Number(r.task_count),
  completed: Number(r.completed_count),
  incomplete: Number(r.incomplete_count),
  overdue: Number(r.overdue_count),
  completedRecent: Number(r.completed_recent_count),
});

// Every row of a workspace report breakdown, a page at a time (a workspace can have more than 1,000
// sections), in a fixed order so pages never overlap.
function workspaceReportRows(supabase: Supabase, filters: ReportFilters, groupBy: "none" | "project" | "assignee" | "section", timeZone: string) {
  return pages<ReportCountRow>(
    (from, to) =>
      supabase
        .rpc("workspace_report", { filters: reportFiltersJson(filters), group_by: groupBy, tz: timeZone })
        .order("bucket", { nullsFirst: true })
        .order("project_id", { nullsFirst: true })
        .range(from, to),
    "report",
  );
}

// The all-projects report a page at a time, in its own order.
function allProjectsRows(supabase: Supabase, timeZone: string) {
  return pages(
    (from, to) => supabase.rpc("all_projects_report", { tz: timeZone }).range(from, to),
    "all-projects report",
  );
}

// The overdue report a page at a time: keyset pages of report_overdue_tasks_after (Real features 4), 5,000
// rows each in the report's own order; a database without it gets the old function's first 10,000.
const OVERDUE_PAGE = 5000;

type OverdueRow = {
  task_id: string;
  title: string;
  project_id: string;
  assignee_id: string | null;
  due_on: string;
  days_overdue: number;
  parent_task_id: string | null;
};

async function* overdueRows(supabase: Supabase, filters: ReportFilters, timeZone: string): AsyncGenerator<OverdueTask> {
  let cursor: OverdueRow | null = null;
  for (;;) {
    const result = await supabase.rpc("report_overdue_tasks_after", {
      filters: reportFiltersJson(filters),
      tz: timeZone,
      after_due: cursor?.due_on ?? null,
      after_title: cursor?.title ?? null,
      after_task: cursor?.task_id ?? null,
      max_results: OVERDUE_PAGE,
    });
    let list: OverdueRow[];
    if (result.error?.code === "PGRST202") {
      const old = await supabase.rpc("report_overdue_tasks", { filters: reportFiltersJson(filters), tz: timeZone, max_results: 10_000 });
      if (old.error) throw new Error(`Failed to export overdue tasks: ${old.error.message}`);
      list = old.data ?? [];
    } else if (result.error) {
      throw new Error(`Failed to export overdue tasks: ${result.error.message}`);
    } else {
      list = (Array.isArray(result.data) ? result.data : []) as OverdueRow[];
    }
    for (const r of list) {
      yield {
        taskId: r.task_id,
        title: r.title,
        projectId: r.project_id,
        assigneeId: r.assignee_id,
        dueOn: r.due_on,
        daysOverdue: Number(r.days_overdue),
        parentTaskId: r.parent_task_id,
      };
    }
    if (result.error || list.length < OVERDUE_PAGE) return;
    cursor = list[list.length - 1];
  }
}

// Workspace report tables. `breakdown` = totals, by project, by section, and by assignee in one table
// (the Group column tells them apart); `series` = completed per day or week; `overdue` = the overdue
// list (every overdue task, however many); `projects` = the all-projects report.
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
      header: [bucket === "week" ? "Week starting" : "Day", "Label", "Completed"],
      rows: series.map((p) => [p.start, seriesLabel(p.start, bucket), p.count]),
    };
  }

  if (table === "overdue") {
    const projects = await listReadableProjects();
    const projectNames = new Map(projects.map((p) => [p.id, p.name]));
    const supabase = await createClient();
    async function* rows(): AsyncGenerator<CsvCell[]> {
      for await (const t of overdueRows(supabase, filters, timeZone)) {
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
    const supabase = await createClient();
    const projects = await collect(allProjectsRows(supabase, timeZone));
    const latest = await listLatestStatusUpdates(projects.flatMap((p) => (p.project_id ? [p.project_id] : [])));
    return {
      title: "all projects report",
      header: ["Project", "Status", "Latest update", ...COUNT_HEADER],
      rows: projects.map((p) => [p.name, statusLabel(p.status), latest.get(p.project_id)?.note ?? "", ...countCells(toCounts(p))]),
    };
  }

  if (table !== "breakdown") return null;
  const projects = await listReadableProjects();
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const supabase = await createClient();
  async function* rows(): AsyncGenerator<CsvCell[]> {
    // One row per bucket (not per task), so the four breakdowns are read side by side.
    const [totals, byProject, bySection, byAssignee] = await Promise.all(
      (["none", "project", "section", "assignee"] as const).map((groupBy) =>
        collect(workspaceReportRows(supabase, filters, groupBy, timeZone)),
      ),
    );
    for (const r of totals) yield ["Total", "All matching tasks", "", ...countCells(toCounts(r))];
    for (const r of byProject) yield ["Project", projectNames.get(r.bucket ?? "") ?? "", "", ...countCells(toCounts(r))];
    for (const chunk of chunks(bySection, CHUNK)) {
      const ids = chunk.flatMap((r) => (r.bucket ? [r.bucket] : []));
      const found = ids.length ? await supabase.from("sections").select("id, name").in("id", ids) : { data: [], error: null };
      if (found.error) throw new Error(`Failed to export sections: ${found.error.message}`);
      const sections = new Map((found.data ?? []).map((x) => [x.id, x.name] as const));
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
    header: ["Group", "Name", "Status", "Latest update", ...COUNT_HEADER],
    rows,
  };
}
