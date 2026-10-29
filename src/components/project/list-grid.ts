// The List's one grid (Oct 29 notes, batch 7, item 53). The column header and every row (tasks and
// subtasks) are CSS grids over the same tracks, and the Name column is pinned the same way in all of them,
// so header and rows can't drift apart. Server-safe (no "use client"): plain strings and arithmetic.
//
// Why this exists: the Name header used to be `relative` and `sticky`, `z-[1]` and `z-[2]` at once, and
// every other header cell's resize handle had `z-[3]` and hung 4px into the next column. Those handles
// sat in the header row's stacking context above the pinned Name header (z 2), so a column that had
// scrolled behind the Name column drew its divider (and grabbed the pointer) inside the Name header —
// e.g. Assignee's edge ~70px before the Name column ends, with "Due date" half hidden ("ate"). Row Name
// cells could also spill wide content (badges, tags) over the next column.
//
// The rules now:
// - Tracks: `listGridTemplate()` — Name, the view's columns (fixed px, dragged to size), then a filler.
//   The Name track never takes the whole view (listNameTrack), so no column is stuck behind it.
// - The pinned Name cell (header and rows): LIST_PINNED_CELL — `sticky left-0`, the only z-index in a
//   header or task row (`z-[1]`), a divider on its last pixel, and its content clipped to its track.
// - Other header cells: `relative` (for the handle), no z-index. Row cells: LIST_CELL.
// - Resize handles (LIST_RESIZE_HANDLE): inside their own cell at its right edge, no z-index, their
//   line on the cell's last pixel (where the pinned cell's divider is). So nothing in another column can
//   paint over the pinned Name column, and nothing in the Name column reaches past its track.
import type { CSSProperties } from "react";
import { MIN_TASK_COLUMN_WIDTH, columnWidth, type ColumnWidths } from "@/lib/column-widths";
import type { ColumnKey } from "@/lib/views";

// After the last column: fills the page, so rows reach the right edge when the columns are narrower.
export const LIST_FILLER_TRACK = "minmax(2.5rem,1fr)";

// The List's visible width (its scroller's), set on the List by a ResizeObserver; the window's width
// until then. A pinned Name column wider than the view would hide every other column behind it at every
// scroll position, so it is drawn at most this wide less NAME_COLUMN_ROOM (never under the 200px
// minimum). The saved width is kept; a wider page shows it again.
export const LIST_VIEW_WIDTH_VAR = "--list-view-w";
export const NAME_COLUMN_ROOM = "10rem";

export function listNameTrack(width: number, hasColumns = true): string {
  if (!hasColumns) return `${width}px`;
  return `min(${width}px,max(${MIN_TASK_COLUMN_WIDTH}px,calc(var(${LIST_VIEW_WIDTH_VAR},100vw) - ${NAME_COLUMN_ROOM})))`;
}

// Name (the "task" width), each column in the view's order, then the filler.
export function listGridTemplate(widths: ColumnWidths, columns: readonly ColumnKey[]): string {
  return [
    listNameTrack(columnWidth(widths, "task"), columns.length > 0),
    ...columns.map((column) => `${columnWidth(widths, column)}px`),
    LIST_FILLER_TRACK,
  ].join(" ");
}

export function listGridStyle(widths: ColumnWidths, columns: readonly ColumnKey[]): CSSProperties {
  return { gridTemplateColumns: listGridTemplate(widths, columns) };
}

export const LIST_GRID = "grid items-stretch";
// The column header sticks under the toolbar while rows scroll (the List's scroller scrolls both ways);
// z-20 keeps it above the rows passing under it.
export const LIST_HEADER_ROW = `${LIST_GRID} sticky top-0 z-20 border-b border-zinc-200 bg-white text-xs font-medium text-zinc-500`;
export const LIST_CELL = "flex min-w-0 items-center px-2";
// The pinned Name cell, header and rows alike (each adds its own opaque background). Its divider is a 1px
// line on its last pixel (a pseudo-element, not a border: a border would push the resize handle's
// `right-0` 1px in and draw a second line next to it in the header).
export const LIST_PINNED_DIVIDER = "after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-zinc-200";
export const LIST_PINNED_CELL = `${LIST_CELL} sticky left-0 z-[1] overflow-hidden ${LIST_PINNED_DIVIDER}`;
// What every header cell adds (height, room for the menu chevron before the resize handle, hover).
const HEADER_CELL = "group/header h-8 gap-1 pr-2.5 hover:bg-zinc-50";

export function listHeaderCellClass(pinned: boolean): string {
  return pinned ? `${LIST_PINNED_CELL} ${HEADER_CELL} bg-white` : `${LIST_CELL} relative ${HEADER_CELL}`;
}

// A column's resize handle (8px wide, inside its cell) and its 1px line on the cell's last pixel.
export const LIST_RESIZE_HANDLE =
  "absolute inset-y-1 right-0 w-2 cursor-col-resize touch-none rounded after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-zinc-200 hover:after:w-0.5 hover:after:bg-accent-400 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500";

// ---------------------------------------------------------------------------------------------
// The Name cell's leading controls
// ---------------------------------------------------------------------------------------------

export type ListWho = "editor" | "viewer";
type NameControl = "handle" | "checkbox" | "expand" | "complete";

// A task row's Name cell starts with its controls, left to right, `gap-2` (0.5rem) apart after the
// cell's left padding (rem): Editors: drag handle (w-4) · checkbox (size-3.5) · expand arrow (w-4) ·
// completion (18px); Viewers: expand arrow · completion. Then the name.
export const NAME_GAP_REM = 0.5;
export const NAME_GUTTER: Record<ListWho, { padding: number; controls: [NameControl, number][] }> = {
  editor: { padding: 0.375, controls: [["handle", 1], ["checkbox", 0.875], ["expand", 1], ["complete", 1.125]] },
  viewer: { padding: 0.75, controls: [["expand", 1], ["complete", 1.125]] },
};

// Where a control (or the name, "title") starts inside the Name cell, in rem.
export function nameOffsetRem(who: ListWho, at: "expand" | "complete" | "title"): number {
  let x = NAME_GUTTER[who].padding;
  for (const [control, width] of NAME_GUTTER[who].controls) {
    if (control === at) return x;
    x += width + NAME_GAP_REM;
  }
  return x;
}

// The same offsets as Tailwind classes (Tailwind only sees literal class names; a unit test checks each
// against nameOffsetRem). row = the cell's own left padding; header = the "Name" label, over the
// completion circles; title = the names (the "Add task…" row, Show more, empty notes).
export const NAME_INDENT = {
  editor: { row: "pl-1.5", header: "pl-[4.75rem]", title: "pl-[6.375rem]" },
  viewer: { row: "pl-3", header: "pl-[2.25rem]", title: "pl-[3.875rem]" },
} as const satisfies Record<ListWho, { row: string; header: string; title: string }>;

// A subtask row's expand arrow sits under its parent's completion circle: one expand arrow and a gap
// further in per level, starting from where a task row's arrow is.
export const SUBTASK_STEP_REM = 1 + NAME_GAP_REM;

export function subtaskIndentRem(who: ListWho, depth: number): number {
  return nameOffsetRem(who, "expand") + depth * SUBTASK_STEP_REM;
}
