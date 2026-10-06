import { isUuid } from "@/lib/ids";
import type { FieldDef } from "@/lib/fields";
import type { Json } from "@/lib/supabase/database.types";

// Shared view config schema for List, Board, Calendar, Timeline, and dashboard widgets. The
// database validates the same shape (validate_view_config) and evaluates filters in
// filter_project_tasks(). See the schema comment at the top of
// supabase/migrations/20261005030000_views_insights.sql (plus the `start` key from 20261005040000_timeline.sql
// and filters.tags / group_by "tag" from 20261006100000_tags_collaboration.sql).

export const VIEW_LAYOUTS = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
  { value: "calendar", label: "Calendar" },
  { value: "timeline", label: "Timeline" },
] as const;

export type ViewLayout = (typeof VIEW_LAYOUTS)[number]["value"];

export function isViewLayout(value: unknown): value is ViewLayout {
  return VIEW_LAYOUTS.some((l) => l.value === value);
}

export type Completion = "incomplete" | "completed" | "all";

export type DueKind = "overdue" | "today" | "upcoming" | "no_date" | "range";
export type DueFilter = { kind: DueKind; days?: number; from?: string; to?: string };

export type FieldOp = "in" | "equals" | "empty" | "not_empty";
export type FieldFilter = {
  field_id: string;
  op: FieldOp;
  values?: string[];
  value?: string | number | boolean;
};

export type ViewFilters = {
  completion?: Completion;
  completed_within_days?: number;
  sections?: (string | null)[];
  assignees?: (string | null)[];
  due?: DueFilter;
  fields?: FieldFilter[];
  text?: string;
  // Tags (any-of; null = tasks with no tags). Since Tags and collaboration extras.
  tags?: (string | null)[];
};

export type FieldRef = `field:${string}`;
export type SortKey = "manual" | "due" | "start" | "title" | "created" | "assignee" | FieldRef;
export type ViewSort = { key: SortKey; dir: "asc" | "desc" };
export type GroupBy = "section" | "assignee" | "tag" | "none" | FieldRef;
export type ColumnKey = "assignee" | "due" | "start" | "section" | FieldRef;

export type ViewConfig = {
  filters?: ViewFilters;
  sort?: ViewSort[];
  group_by?: GroupBy;
  columns?: ColumnKey[];
};

export type ProjectView = {
  id: string;
  projectId: string;
  name: string;
  layout: ViewLayout;
  config: ViewConfig;
  sortOrder: number;
};

export const WIDGET_KINDS = [
  { value: "count", label: "Number" },
  { value: "by_section", label: "Chart by section" },
  { value: "by_assignee", label: "Chart by assignee" },
] as const;

export type WidgetKind = (typeof WIDGET_KINDS)[number]["value"];

export function isWidgetKind(value: unknown): value is WidgetKind {
  return WIDGET_KINDS.some((k) => k.value === value);
}

export type DashboardWidget = {
  id: string;
  projectId: string;
  kind: WidgetKind;
  title: string;
  filters: ViewFilters;
  sortOrder: number;
};

export const DUE_KINDS: { value: DueKind; label: string }[] = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "upcoming", label: "Upcoming" },
  { value: "no_date", label: "No due date" },
  { value: "range", label: "Date range" },
];

const SORT_BASE: { value: SortKey; label: string }[] = [
  { value: "manual", label: "Manual order" },
  { value: "due", label: "Due date" },
  { value: "start", label: "Start date" },
  { value: "title", label: "Name" },
  { value: "created", label: "Created" },
  { value: "assignee", label: "Assignee" },
];

export function sortOptions(fields: FieldDef[]) {
  return [
    ...SORT_BASE,
    ...fields
      .filter((f) => !f.boundToSections)
      .map((f) => ({ value: fieldRef(f.id), label: f.name })),
  ];
}

export function groupOptions(fields: FieldDef[]): { value: GroupBy; label: string }[] {
  return [
    { value: "section", label: "Section" },
    { value: "assignee", label: "Assignee" },
    { value: "tag", label: "Tag" },
    ...fields
      .filter((f) => f.fieldType === "single_select" && !f.boundToSections)
      .map((f) => ({ value: fieldRef(f.id), label: f.name })),
    { value: "none", label: "No grouping" },
  ];
}

export const fieldRef = (fieldId: string): FieldRef => `field:${fieldId}`;

export function refFieldId(ref: string): string | null {
  const id = ref.startsWith("field:") ? ref.slice(6) : null;
  return id && isUuid(id) ? id : null;
}

// ---------------------------------------------------------------------------------------------
// Parsing: anything that isn't valid is dropped, so a bad URL or stale config never breaks a page.
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const time = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === v;
}
const wholeIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function idList(value: unknown, extra: string[] = []): (string | null)[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: (string | null)[] = [];
  for (const item of value.slice(0, 100)) {
    if (item === null || (typeof item === "string" && (isUuid(item) || extra.includes(item)))) {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out.length ? out : undefined;
}

function parseFieldFilter(value: unknown): FieldFilter | null {
  if (!isObj(value) || !isUuid(value.field_id)) return null;
  switch (value.op) {
    case "empty":
    case "not_empty":
      return { field_id: value.field_id, op: value.op };
    case "in": {
      const values = Array.isArray(value.values)
        ? [...new Set(value.values.filter((v): v is string => typeof v === "string" && v.length <= 64))].slice(0, 100)
        : [];
      return values.length ? { field_id: value.field_id, op: "in", values } : null;
    }
    case "equals": {
      const v = value.value;
      if (typeof v === "string" && v.length <= 500) return { field_id: value.field_id, op: "equals", value: v };
      if (typeof v === "number" && Number.isFinite(v)) return { field_id: value.field_id, op: "equals", value: v };
      if (typeof v === "boolean") return { field_id: value.field_id, op: "equals", value: v };
      return null;
    }
    default:
      return null;
  }
}

export function parseFilters(value: unknown): ViewFilters {
  if (!isObj(value)) return {};
  const out: ViewFilters = {};
  if (value.completion === "completed" || value.completion === "all") out.completion = value.completion;
  if (out.completion === "completed" && wholeIn(value.completed_within_days, 1, 3650)) {
    out.completed_within_days = value.completed_within_days;
  }
  const sections = idList(value.sections);
  if (sections) out.sections = sections;
  const assignees = idList(value.assignees, ["me"]);
  if (assignees) out.assignees = assignees;
  const tags = idList(value.tags);
  if (tags) out.tags = tags;
  const due = value.due;
  if (isObj(due) && DUE_KINDS.some((k) => k.value === due.kind)) {
    const kind = due.kind as DueKind;
    if (kind === "upcoming") {
      out.due = wholeIn(due.days, 1, 365) ? { kind, days: due.days } : { kind };
    } else if (kind === "range") {
      const range: DueFilter = { kind };
      if (isIsoDate(due.from)) range.from = due.from;
      if (isIsoDate(due.to)) range.to = due.to;
      if (range.from || range.to) out.due = range;
    } else {
      out.due = { kind };
    }
  }
  if (Array.isArray(value.fields)) {
    const fields = value.fields.slice(0, 20).map(parseFieldFilter).filter((f): f is FieldFilter => f !== null);
    if (fields.length) out.fields = fields;
  }
  if (typeof value.text === "string" && value.text.trim()) out.text = value.text.trim().slice(0, 200);
  return out;
}

const isFieldRef = (v: unknown): v is FieldRef => typeof v === "string" && refFieldId(v) !== null;

export function parseViewConfig(value: unknown): ViewConfig {
  if (!isObj(value)) return {};
  const out: ViewConfig = {};
  const filters = parseFilters(value.filters);
  if (Object.keys(filters).length) out.filters = filters;
  if (Array.isArray(value.sort)) {
    const sort = value.sort
      .filter(
        (s): s is ViewSort =>
          isObj(s) &&
          (s.dir === "asc" || s.dir === "desc") &&
          (SORT_BASE.some((b) => b.value === s.key) || isFieldRef(s.key)),
      )
      .map((s) => ({ key: s.key, dir: s.dir }))
      .slice(0, 3);
    if (sort.length && !(sort.length === 1 && sort[0].key === "manual" && sort[0].dir === "asc")) out.sort = sort;
  }
  if (value.group_by === "assignee" || value.group_by === "tag" || value.group_by === "none" || isFieldRef(value.group_by)) {
    out.group_by = value.group_by;
  }
  if (Array.isArray(value.columns)) {
    const columns = [
      ...new Set(
        value.columns.filter(
          (c): c is ColumnKey =>
            c === "assignee" || c === "due" || c === "start" || c === "section" || isFieldRef(c),
        ),
      ),
    ].slice(0, 30);
    out.columns = columns;
  }
  return out;
}

// tagIds: the workspace's tags (omit to keep tag filters as they are).
export type PruneContext = { sectionIds: Set<string>; fields: FieldDef[]; profileIds: Set<string>; tagIds?: Set<string> };

// Removes references to sections/fields/people/tags that no longer exist (or can't be used that way).
export function pruneConfig(
  config: ViewConfig,
  context: PruneContext,
): ViewConfig {
  const fieldsById = new Map(context.fields.map((f) => [f.id, f]));
  const fieldOk = (ref: string) => {
    const id = refFieldId(ref);
    return id !== null && fieldsById.has(id);
  };
  const out: ViewConfig = { ...config };
  if (config.filters) out.filters = pruneFilters(config.filters, context);
  if (config.sort) {
    const sort = config.sort.filter((s) => !s.key.startsWith("field:") || fieldOk(s.key));
    if (sort.length) out.sort = sort;
    else delete out.sort;
  }
  if (config.group_by?.startsWith("field:")) {
    const field = fieldsById.get(refFieldId(config.group_by) ?? "");
    if (!field || field.fieldType !== "single_select") delete out.group_by;
    else if (field.boundToSections) out.group_by = "section";
  }
  if (config.columns) out.columns = config.columns.filter((c) => !c.startsWith("field:") || fieldOk(c));
  return out;
}

export function pruneFilters(
  filters: ViewFilters,
  context: PruneContext,
): ViewFilters {
  const fieldIds = new Set(context.fields.map((f) => f.id));
  const out: ViewFilters = { ...filters };
  const sections = filters.sections?.filter((s) => s === null || context.sectionIds.has(s));
  if (sections?.length) out.sections = sections;
  else delete out.sections;
  const assignees = filters.assignees?.filter((a) => a === null || a === "me" || context.profileIds.has(a));
  if (assignees?.length) out.assignees = assignees;
  else delete out.assignees;
  const fields = filters.fields?.filter((f) => fieldIds.has(f.field_id));
  if (fields?.length) out.fields = fields;
  else delete out.fields;
  if (context.tagIds) {
    const tagIds = context.tagIds;
    const tags = filters.tags?.filter((t) => t === null || tagIds.has(t));
    if (tags?.length) out.tags = tags;
    else delete out.tags;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Canonical form + URL drafts (?f=<json>): an edited, unsaved config lives in the URL so reloads
// and shared links keep it until it's saved to the view or reset.
// ---------------------------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObj(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, canonical(value[k])]),
    );
  }
  return value;
}

export function configKey(config: ViewConfig): string {
  return JSON.stringify(canonical(parseViewConfig(config)));
}

export function sameConfig(a: ViewConfig, b: ViewConfig) {
  return configKey(a) === configKey(b);
}

export function encodeConfig(config: ViewConfig): string {
  return JSON.stringify(canonical(parseViewConfig(config)));
}

export function decodeConfig(param: string | string[] | undefined): ViewConfig | null {
  if (typeof param !== "string" || !param || param.length > 8000) return null;
  try {
    return parseViewConfig(JSON.parse(param));
  } catch {
    return null;
  }
}

export function toJson(config: ViewConfig | ViewFilters): Json {
  return canonical(config) as Json;
}

// ---------------------------------------------------------------------------------------------
// Effective settings
// ---------------------------------------------------------------------------------------------

export const completionOf = (filters: ViewFilters | undefined): Completion => filters?.completion ?? "incomplete";
export const groupOf = (config: ViewConfig): GroupBy => config.group_by ?? "section";
export const sortOf = (config: ViewConfig): ViewSort[] => config.sort ?? [{ key: "manual", dir: "asc" }];

export function columnsOf(config: ViewConfig, fields: FieldDef[]): ColumnKey[] {
  return config.columns ?? ["assignee", "due", ...fields.filter((f) => f.showInViews).map((f) => fieldRef(f.id))];
}

export function hasActiveFilters(filters: ViewFilters | undefined) {
  return Boolean(filters && Object.keys(filters).length > 0);
}

export function withFilters(config: ViewConfig, filters: ViewFilters): ViewConfig {
  const next: ViewConfig = { ...config, filters };
  if (!Object.keys(filters).length) delete next.filters;
  return next;
}
