// Templates (browser + server): shapes shared by the gallery, the project dialogs, and task templates.
// The copy engine itself lives in SQL (20261006020000_templates.sql): project_snapshot() +
// instantiate_project_snapshot() behind save_project_as_template / create_project_from_template /
// duplicate_project. Copied rules always land disabled.

export type TemplateSummary = {
  sections: number;
  tasks: number;
  fields: number;
  rules: number;
  forms: number;
  views: number;
  // Tasks with a start or due date (stored as day offsets from the template's start date).
  datedTasks: number;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function parseTemplateSummary(value: unknown): TemplateSummary {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    sections: count(v.sections),
    tasks: count(v.tasks),
    fields: count(v.fields),
    rules: count(v.rules),
    forms: count(v.forms),
    views: count(v.views),
    datedTasks: count(v.dated_tasks),
  };
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// "5 sections · 12 tasks · 2 fields · 3 rules"
export function describeSummary(summary: TemplateSummary): string {
  const parts = [plural(summary.sections, "section"), plural(summary.tasks, "task")];
  if (summary.fields) parts.push(plural(summary.fields, "field"));
  if (summary.rules) parts.push(plural(summary.rules, "rule"));
  if (summary.forms) parts.push(plural(summary.forms, "form"));
  return parts.join(" · ");
}

// Options of Duplicate project (mirrors duplicate_project()).
export type DuplicateOptions = {
  tasks: boolean;
  assignees: boolean;
  dates: boolean;
  // New start date (YYYY-MM-DD): every date shifts by the same number of days. Null keeps the dates.
  startOn: string | null;
  rules: boolean;
  forms: boolean;
  members: boolean;
};

export const DEFAULT_DUPLICATE_OPTIONS: DuplicateOptions = {
  tasks: true,
  assignees: true,
  dates: true,
  startOn: null,
  rules: true,
  forms: true,
  members: false,
};

// What instantiate_project_snapshot() reports back.
export type CopyResult = {
  projectId: string;
  tasks: number;
  rules: number;
  rulesSkipped: number;
  formsSkipped: number;
  viewsSkipped: number;
  valuesSkipped: number;
};

export function parseCopyResult(value: unknown): CopyResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.project_id !== "string") return null;
  return {
    projectId: v.project_id,
    tasks: count(v.tasks),
    rules: count(v.rules),
    rulesSkipped: count(v.rules_skipped),
    formsSkipped: count(v.forms_skipped),
    viewsSkipped: count(v.views_skipped),
    valuesSkipped: count(v.values_skipped),
  };
}

// Task template subtasks are stored as a JSON array of titles.
export function parseSubtaskTitles(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
}

export const MAX_TEMPLATE_SUBTASKS = 100;

// The viewer's local date as YYYY-MM-DD (client only).
export function localIsoDate(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
