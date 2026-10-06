import "server-only";
import { displayName } from "@/components/avatar";
import type { BarDatum } from "@/components/dashboard/bar-chart";
import type { OverdueRow } from "@/components/reports/report-blocks";
import { allProjectsReport, listProfiles, listSectionLabels, listTags, reportOverdueTasks, type ReportRow } from "@/lib/data";
import type { ReportFilters } from "@/lib/reports";

// Labels for report buckets. Project names only ever come from all_projects_report (readable projects),
// so a project the viewer can't read can't be named here; its rows don't exist anyway.

export type ReportContext = {
  projects: { id: string; name: string }[];
  people: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  projectName: (id: string | null) => string;
  personName: (id: string | null) => string;
};

export async function loadReportContext(timeZone: string): Promise<ReportContext> {
  const [projects, profiles, tags] = await Promise.all([allProjectsReport(timeZone), listProfiles(), listTags()]);
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const people = profiles.map((p) => ({ id: p.id, name: displayName(p) }));
  const personNames = new Map(people.map((p) => [p.id, p.name]));
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    people: people.sort((a, b) => a.name.localeCompare(b.name)),
    tags: tags.map((t) => ({ id: t.id, name: t.archivedAt ? `${t.name} (archived)` : t.name })),
    projectName: (id) => (id ? (projectNames.get(id) ?? "A project you can’t open") : ""),
    personName: (id) => (id ? (personNames.get(id) ?? "Former member") : ""),
  };
}

const byCount = (a: BarDatum, b: BarDatum) => b.count - a.count || a.label.localeCompare(b.label);

export function projectBars(rows: ReportRow[], context: ReportContext): BarDatum[] {
  return rows
    .filter((r) => r.bucket)
    .map((r) => ({ key: r.bucket!, label: context.projectName(r.bucket), count: r.total }))
    .sort(byCount);
}

export function assigneeBars(rows: ReportRow[], context: ReportContext): BarDatum[] {
  const people = rows
    .filter((r) => r.bucket)
    .map((r) => ({ key: r.bucket!, label: context.personName(r.bucket), count: r.total }))
    .sort(byCount);
  const none = rows.find((r) => !r.bucket);
  return none ? [...people, { key: "none", label: "Unassigned", count: none.total }] : people;
}

export const MAX_SECTION_BARS = 20;

export async function sectionBars(rows: ReportRow[], context: ReportContext): Promise<{ bars: BarDatum[]; more: number }> {
  const labels = await listSectionLabels(rows.flatMap((r) => (r.bucket ? [r.bucket] : [])));
  const multiProject = new Set(rows.map((r) => r.projectId)).size > 1;
  const bars = rows
    .map((r) => {
      const section = r.bucket ? (labels.get(r.bucket)?.name ?? "Deleted section") : "No section";
      return {
        key: `${r.projectId}:${r.bucket ?? "none"}`,
        label: multiProject ? `${section} · ${context.projectName(r.projectId)}` : section,
        count: r.total,
      };
    })
    .sort(byCount);
  return { bars: bars.slice(0, MAX_SECTION_BARS), more: Math.max(0, bars.length - MAX_SECTION_BARS) };
}

export async function loadOverdueRows(
  filters: ReportFilters,
  timeZone: string,
  context: ReportContext,
  max = 200,
): Promise<OverdueRow[]> {
  const tasks = await reportOverdueTasks(filters, timeZone, max);
  return tasks.map((t) => ({
    taskId: t.taskId,
    title: t.title,
    projectId: t.projectId,
    projectName: context.projectName(t.projectId),
    assignee: context.personName(t.assigneeId),
    dueOn: t.dueOn,
    daysOverdue: t.daysOverdue,
    subtask: t.parentTaskId !== null,
  }));
}
