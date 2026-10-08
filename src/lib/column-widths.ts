// List column widths per person per project (list_column_widths, set_list_column_widths). Mirrors
// validate_list_column_widths() in 20261008020000_asana_feel_1.sql: keys task | assignee | due | start |
// section | tags | field:<uuid>, whole pixels 48..800, at most 60 keys.
import type { ColumnKey } from "@/lib/views";

export type ColumnWidthKey = "task" | ColumnKey;
export type ColumnWidths = Partial<Record<ColumnWidthKey, number>>;

export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 800;
export const MAX_COLUMN_WIDTH_KEYS = 60;
// The Task column needs room for the checkbox, toggle, and a readable title.
export const MIN_TASK_COLUMN_WIDTH = 200;

const KEY = /^(task|assignee|due|start|section|tags|field:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const DEFAULT_COLUMN_WIDTHS: Record<"task" | "assignee" | "due" | "start" | "section" | "tags" | "field", number> = {
  task: 360,
  assignee: 160,
  due: 112,
  start: 112,
  section: 144,
  tags: 176,
  field: 144,
};

export function isColumnWidthKey(value: string): value is ColumnWidthKey {
  return KEY.test(value);
}

export function clampColumnWidth(key: ColumnWidthKey, width: number) {
  const min = key === "task" ? MIN_TASK_COLUMN_WIDTH : MIN_COLUMN_WIDTH;
  return Math.round(Math.min(Math.max(width, min), MAX_COLUMN_WIDTH));
}

export function defaultColumnWidth(key: ColumnWidthKey) {
  return key.startsWith("field:") ? DEFAULT_COLUMN_WIDTHS.field : DEFAULT_COLUMN_WIDTHS[key as Exclude<ColumnWidthKey, `field:${string}`>];
}

export function columnWidth(widths: ColumnWidths, key: ColumnWidthKey) {
  return widths[key] ?? defaultColumnWidth(key);
}

// Drops anything the database would refuse (stale keys, bad numbers); keeps at most 60 keys.
export function parseColumnWidths(value: unknown): ColumnWidths {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ColumnWidths = {};
  for (const [key, width] of Object.entries(value).slice(0, MAX_COLUMN_WIDTH_KEYS)) {
    if (!isColumnWidthKey(key) || typeof width !== "number" || !Number.isFinite(width)) continue;
    out[key] = clampColumnWidth(key, width);
  }
  return out;
}
