// Task numbering labels. The database stores the number and renders `req_label` from the
// project's template. The app draws that label in front of the name and keeps the stored
// title free of it, so renaming never eats the number. A label always travels with its
// project's "Wrap the label in brackets" setting (RequestLabel), so no screen can show one
// without it; formatRequestLabel() mirrors request_display_label() in the database.

export type RequestLabel = { text: string; wrap: boolean };

/** "[Task #3]" or "Task #3", per the issuing project's setting. Mirrors request_display_label(). */
export function formatRequestLabel(label: RequestLabel | null | undefined): string {
  if (!label || !label.text.trim()) return "";
  return label.wrap ? `[${label.text}]` : label.text;
}

export type NumberScope = "all_tasks" | "form_submissions" | "sections" | "kinds";
export type ResetPeriod = "never" | "yearly" | "monthly";
export type SubtaskSeparator = "." | "-" | "/";

export type TaskNumbering = {
  enabled: boolean;
  template: string;
  wrapBrackets: boolean;
  addToTitle: boolean;
  numberScope: NumberScope;
  sectionIds: string[];
  taskKinds: Array<"task" | "milestone" | "approval">;
  numberSubtasks: boolean;
  subtaskSeparator: SubtaskSeparator;
  reuseDeleted: boolean;
  fillGaps: boolean;
  resetPeriod: ResetPeriod;
  counterFieldId: string | null;
  projectCode: string;
  renumberOnMove: boolean;
  timeZone: string;
  /** The next number a new task receives. */
  nextNumber: number;
  lastNumber: number;
  /** Where Renumber all and every new reset period / per-field counter start. */
  startNumber: number;
  /** False when this database does not have the task-numbering columns yet. */
  advanced: boolean;
};

export const DEFAULT_TEMPLATE = "Req #{n}";

export function emptyNumbering(): TaskNumbering {
  return {
    enabled: false,
    template: DEFAULT_TEMPLATE,
    wrapBrackets: true,
    addToTitle: false,
    numberScope: "all_tasks",
    sectionIds: [],
    taskKinds: ["task", "milestone", "approval"],
    numberSubtasks: true,
    subtaskSeparator: ".",
    reuseDeleted: false,
    fillGaps: false,
    resetPeriod: "never",
    counterFieldId: null,
    projectCode: "",
    renumberOnMove: false,
    timeZone: "UTC",
    nextNumber: 1,
    lastNumber: 0,
    startNumber: 1,
    advanced: true,
  };
}

/** Legacy prefix + pad, for a database that only has the original columns. */
export function templateFromPrefix(prefix: string, padWidth: number): string {
  return `${prefix}${padWidth > 0 ? `{n:${padWidth}}` : "{n}"}`;
}

export type LabelSample = {
  /** Numeric path, e.g. "484" or "484.1". */
  number: string;
  /** ISO time used for {yyyy} {yy} {mm}. */
  at: string;
  field?: string;
  parent?: string;
  project?: string;
};

const SAMPLES: LabelSample[] = [
  { number: "484", at: "2026-03-14T15:00:00Z", field: "HQ", parent: "", project: "MKT" },
  { number: "484.1", at: "2026-03-14T15:00:00Z", field: "HQ", parent: "Req #484", project: "MKT" },
  { number: "485", at: "2026-11-02T15:00:00Z", field: "North", parent: "", project: "MKT" },
];

/** Three example labels for the settings preview. Mirrors render_request_template. */
export function previewRequestLabels(
  template: string,
  options: { wrapBrackets: boolean; projectCode?: string; fieldSample?: string } = { wrapBrackets: true },
): string[] {
  return SAMPLES.map((sample) => {
    const label = renderRequestTemplate(template, {
      ...sample,
      project: options.projectCode || sample.project,
      field: options.fieldSample || sample.field,
    });
    return formatRequestLabel({ text: label, wrap: options.wrapBrackets });
  });
}

export function renderRequestTemplate(template: string, sample: LabelSample): string {
  let result = template ?? "";
  result = result.replace(/\{field:[^}]+\}/g, sample.field ?? "");
  result = result.replace(/\{field\}/g, sample.field ?? "");
  result = result.replace(/\{n:(\d+)\}/g, (_, pad: string) => sample.number.padStart(Math.min(Number(pad) || 0, 12), "0"));
  const date = new Date(sample.at);
  const yyyy = Number.isNaN(date.getTime()) ? "" : String(date.getUTCFullYear());
  const yy = yyyy.slice(-2);
  const mm = Number.isNaN(date.getTime()) ? "" : String(date.getUTCMonth() + 1).padStart(2, "0");
  result = result.replaceAll("{n}", sample.number);
  result = result.replaceAll("{yyyy}", yyyy);
  result = result.replaceAll("{yy}", yy);
  result = result.replaceAll("{mm}", mm);
  result = result.replaceAll("{project}", sample.project ?? "");
  result = result.replaceAll("{parent}", sample.parent ?? "");
  return result;
}

export function templateProblem(template: string, reset: ResetPeriod): string | null {
  const text = template.trim();
  if (!text) return "Enter a format.";
  if (text.length > 200) return "The format is limited to 200 characters.";
  if (!/\{n(:\d+)?\}/.test(text)) return "The format needs the {n} counter.";
  if (reset !== "never" && !/\{yyyy\}|\{yy\}|\{mm\}/.test(text)) {
    return "A yearly or monthly reset needs {yyyy}, {yy}, or {mm} so labels stay unique.";
  }
  return null;
}

/**
 * The name as people should read it: the label (bracketed or not, per its project) in front of
 * the stored title. A title that still has the label baked in (either form) isn't prefixed
 * twice. `show: false` returns the bare name.
 */
export function displayTaskTitle(
  title: string,
  label: RequestLabel | null | undefined,
  options: { show?: boolean } = {},
): string {
  const bare = stripBakedLabel(title, label?.text);
  const shown = options.show === false ? "" : formatRequestLabel(label);
  return shown ? `${shown} ${bare}` : bare;
}

/** The task's name without its number (for screens that draw the number as a separate badge). */
export function bareTaskTitle(title: string, label: RequestLabel | null | undefined): string {
  return stripBakedLabel(title, label?.text);
}

/** Does a search box's text name this task's number? "12", "#12", "Task #12", "task 12". */
export function matchesRequestLabel(label: RequestLabel | null | undefined, query: string): boolean {
  const text = label?.text.trim().toLowerCase();
  const q = query.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!text || !q) return false;
  if (text.includes(q)) return true;
  const digits = q.replace(/^[^0-9]*#?\s*/, "");
  if (!/^[0-9][0-9.\-/]*$/.test(digits)) return false;
  const numbers = text.match(/[0-9][0-9.\-/]*/g) ?? [];
  return numbers.some((n) => n === digits || n.startsWith(`${digits}.`));
}

function stripBakedLabel(title: string, label: string | null | undefined): string {
  if (!label) return title;
  const bracketed = `[${label}] `;
  if (title.startsWith(bracketed)) return title.slice(bracketed.length);
  if (title.startsWith(`${label} `)) return title.slice(label.length + 1);
  return title;
}

/** Reads one entry of task_request_labels(): { label, wrap }. */
export function requestLabelFrom(value: unknown): RequestLabel | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as { label?: unknown; wrap?: unknown };
  if (typeof entry.label !== "string" || !entry.label.trim()) return null;
  return { text: entry.label, wrap: entry.wrap !== false };
}
