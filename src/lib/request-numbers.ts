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
// Only a query with a number in it matches (so "s" or "task" never lists every numbered task), and the
// number must be the task's whole number or a parent of it ("484" finds 484 and 484.1, not 4840); any
// words in front must be the label's own ("Task #12", not "Bug #12").
export function matchesRequestLabel(label: RequestLabel | null | undefined, query: string): boolean {
  const text = label?.text.trim().toLowerCase();
  const q = query.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!text || !q || !/[0-9]/.test(q)) return false;
  const match = q.match(/^(.*?)#?\s*([0-9][0-9.\-/]*)$/);
  if (!match) return false;
  const [, words, digits] = match;
  const prefix = words.trim().replace(/#$/, "").trim();
  if (prefix && !text.startsWith(prefix)) return false;
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

// ---------------------------------------------------------------------------------------------
// Oct 29 notes (batch 7, 55b): no home project. A task is in one or more projects; it has a number in
// each one that numbers it. Lists show them in the stable order — the order the task was added to its
// projects (task_projects.created_at, then project id) — and only projects the viewer can read
// (task_project_labels, invoker). Links and defaults use the first one.
// ---------------------------------------------------------------------------------------------

/** One project of a task the viewer can read, with the number it gives the task (null = none). */
export type TaskPlace = { projectId: string; projectName: string; label: RequestLabel | null };

/** A task's number in one project (the "Req #1 · Design #14" chips). */
export type TaskNumber = { projectId: string | null; projectName: string | null; label: RequestLabel };

/** Reads one task's list from task_project_labels(): [{ project_id, project_name, label, wrap }]. */
export function taskPlacesFrom(value: unknown): TaskPlace[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TaskPlace[] => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as { project_id?: unknown; project_name?: unknown };
    if (typeof e.project_id !== "string" || !e.project_id) return [];
    return [
      {
        projectId: e.project_id,
        projectName: typeof e.project_name === "string" ? e.project_name : "",
        label: requestLabelFrom(entry),
      },
    ];
  });
}

/** The numbers in a task's places, in the same (stable) order. */
export function numbersOf(places: TaskPlace[]): TaskNumber[] {
  return places.flatMap((p) => (p.label ? [{ projectId: p.projectId, projectName: p.projectName, label: p.label }] : []));
}

/**
 * A number and the project a badge names next to it ("A-4 · Website"), picked together so the name is
 * always the project that issued the number (Oct 29 notes, 55b). `shown`: the project the row already
 * stands for (a picker's group, a calendar bar's project), if any. Its own number when it numbers the
 * task; else the first number the viewer can read, with that number's own project; else no number, and
 * the shown project's name (without one: the first project's). Null projectId/name: nothing to name.
 */
export type PairedNumber = { label: RequestLabel | null; projectId: string | null; projectName: string | null };

export function numberWithItsProject(
  places: TaskPlace[] | null | undefined,
  shown: { projectId: string; projectName: string } | null = null,
): PairedNumber {
  const list = places ?? [];
  if (shown) {
    const here = list.find((p) => p.projectId === shown.projectId && p.label);
    if (here?.label) return { label: here.label, projectId: shown.projectId, projectName: shown.projectName };
  }
  const numbered = list.find((p) => p.label);
  if (numbered?.label) return { label: numbered.label, projectId: numbered.projectId, projectName: numbered.projectName || null };
  if (shown) return { label: null, projectId: shown.projectId, projectName: shown.projectName };
  const first = list[0];
  return first ? { label: null, projectId: first.projectId, projectName: first.projectName || null } : { label: null, projectId: null, projectName: null };
}

/**
 * A task's numbers with one project's own number first (the rest keep the stable order), for a row that
 * names that project: its badge shows that number and "+N" the others. Unchanged when that project doesn't
 * number the task.
 */
export function numbersLedBy(numbers: TaskNumber[] | null | undefined, projectId: string | null): TaskNumber[] {
  const list = numbers ?? [];
  const own = projectId ? list.find((n) => n.projectId === projectId) : undefined;
  return own ? [own, ...list.filter((n) => n !== own)] : list;
}

/**
 * What a tight spot shows (My tasks, Home, search, the Inbox, the team Calendar, emails): the first
 * number and how many more there are ("Req #1 +2"), plus every number for the hover / focus list
 * ("Req #1 (Launch)", "Design #14 (Website)").
 */
export type TaskNumberSummary = { first: RequestLabel | null; more: number; all: { text: string; projectName: string | null }[] };

export function summarizeTaskNumbers(numbers: TaskNumber[] | null | undefined): TaskNumberSummary {
  const list = (numbers ?? []).filter((n) => n.label.text.trim());
  return {
    first: list[0]?.label ?? null,
    more: Math.max(0, list.length - 1),
    all: list.map((n) => ({ text: formatRequestLabel(n.label), projectName: n.projectName })),
  };
}

/** "[Req #1] +2" / "Req #1 +2" — the first number and the count of the others; "" without numbers. */
export function shortTaskNumbers(numbers: TaskNumber[] | null | undefined): string {
  const { first, more } = summarizeTaskNumbers(numbers);
  const text = formatRequestLabel(first);
  return text && more > 0 ? `${text} +${more}` : text;
}

/** Every number, in order, for a tooltip or a screen reader: "Req #1 (Launch) · Design #14 (Website)". */
export function taskNumbersText(numbers: TaskNumber[] | null | undefined): string {
  return summarizeTaskNumbers(numbers)
    .all.map((n) => (n.projectName ? `${n.text} (${n.projectName})` : n.text))
    .join(" · ");
}

/**
 * The "+N" after a task's first number (the number chips' tight form): its text, the hover / tap list (every
 * number on its own line with its project, first one included), the others inline ("Design #14 · WEB-3",
 * shown when the row has keyboard focus), and the others as a screen reader hears them ("Design #14 in
 * Design, WEB-3 in Website"). Null when the task has one number or none.
 */
export type MoreNumbers = { count: number; text: string; list: string; others: string; spoken: string };

export function moreTaskNumbers(numbers: TaskNumber[] | null | undefined): MoreNumbers | null {
  const list = (numbers ?? []).filter((n) => n.label.text.trim());
  if (list.length < 2) return null;
  const rest = list.slice(1);
  const shown = (n: TaskNumber) => formatRequestLabel(n.label);
  return {
    count: rest.length,
    text: `+${rest.length}`,
    list: list.map((n) => (n.projectName ? `${shown(n)} · ${n.projectName}` : shown(n))).join("\n"),
    others: rest.map(shown).join(" · "),
    spoken: rest.map((n) => (n.projectName ? `${shown(n)} in ${n.projectName}` : shown(n))).join(", "),
  };
}

/** One of the pane's number chips: the number, its project, and whether it's the project on screen. */
export type NumberChip = { key: string; text: string; projectId: string | null; projectName: string | null; current: boolean; spoken: string };

/**
 * The pane's chips ("Req #1 · Design #14"): every number the viewer can read, in the stable order; the
 * project on screen (inside a project's own views) is marked current, nothing moves.
 */
export function numberChips(numbers: TaskNumber[] | null | undefined, currentProjectId: string | null = null): NumberChip[] {
  return (numbers ?? [])
    .filter((n) => n.label.text.trim())
    .map((n, i) => {
      const text = formatRequestLabel(n.label);
      return {
        key: n.projectId ?? `number-${i}`,
        text,
        projectId: n.projectId,
        projectName: n.projectName,
        current: Boolean(currentProjectId && n.projectId === currentProjectId),
        spoken: n.projectName ? `${text} in ${n.projectName}` : text,
      };
    });
}

/**
 * The pane's numbers: task_project_labels' list when the database has it; else each listed project's own
 * number (task_request_labels_in, Oct 27 notes), else the one label the task has.
 */
export function paneTaskNumbers(task: {
  taskNumbers?: TaskNumber[] | null;
  memberships: { projectId: string; projectName: string }[];
  projectNumbers?: Record<string, RequestLabel> | null;
  requestLabel: RequestLabel | null;
}): TaskNumber[] {
  if (task.taskNumbers?.length) return task.taskNumbers;
  const own = task.memberships.flatMap((m): TaskNumber[] => {
    const label = task.projectNumbers?.[m.projectId];
    return label?.text.trim() ? [{ projectId: m.projectId, projectName: m.projectName, label }] : [];
  });
  if (own.length) return own;
  return task.requestLabel?.text.trim() ? [{ projectId: null, projectName: null, label: task.requestLabel }] : [];
}
