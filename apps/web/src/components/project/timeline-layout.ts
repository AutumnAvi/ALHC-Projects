// Nov 12 (batch 39, item 4): the Timeline's layout math, kept out of the component so scrolling only does
// cheap work. Row positions are worked out once per data / zoom change; the scroll position is turned into
// a "band" (whole steps of BAND_PX), so the chart re-renders only when the band — and with it the rows it
// draws — changes, and at most once per animation frame. Pure, so the rules are unit-tested.

// Scrolling within one band draws the same rows (the overscan below covers the band's whole height).
export const BAND_ROWS = 6;

export type Band = { top: number; bottom: number };

export type TimelineSlot<G, T> = { key: string; top: number; height: number; group?: G; task?: T };

export type RowGeometry = { header: number; group: number; row: number };

// Every group heading and task row with its top, in content coordinates (below the sticky header), plus
// each task row's vertical centre (arrows use it even when the row itself isn't drawn).
export function layoutSlots<T extends { id: string }, G extends { key: string; tasks: T[] }>(
  groups: readonly G[],
  showGroups: boolean,
  geometry: RowGeometry,
): { slots: TimelineSlot<G, T>[]; rowCenter: Map<string, number>; contentHeight: number } {
  const rowCenter = new Map<string, number>();
  const slots: TimelineSlot<G, T>[] = [];
  let contentHeight = geometry.header;
  for (const group of groups) {
    if (showGroups) {
      slots.push({ key: `group-${group.key}`, top: contentHeight, height: geometry.group, group });
      contentHeight += geometry.group;
    }
    for (const task of group.tasks) {
      rowCenter.set(task.id, contentHeight + geometry.row / 2);
      slots.push({ key: task.id, top: contentHeight, height: geometry.row, task });
      contentHeight += geometry.row;
    }
  }
  return { slots, rowCenter, contentHeight };
}

// The band the scrolled viewport sits in: its top rounded down and its bottom rounded up to whole steps,
// so it always contains the viewport and stays the same while scrolling inside it.
export function viewportBand(scrollTop: number, height: number, step: number): Band {
  const top = Math.max(0, Math.floor(scrollTop / step) * step);
  const bottom = Math.ceil((scrollTop + Math.max(height, 0)) / step) * step;
  return { top, bottom: Math.max(bottom, top + step) };
}

export function sameBand(a: Band, b: Band): boolean {
  return a.top === b.top && a.bottom === b.bottom;
}

// The rows to draw: those touching [top, bottom] (slots are sorted by top), plus the pinned ones (the bar
// being dragged, the open task) wherever they are.
export function visibleSlots<G, T extends { id: string }>(
  slots: readonly TimelineSlot<G, T>[],
  top: number,
  bottom: number,
  pinned: ReadonlySet<string> = new Set(),
): TimelineSlot<G, T>[] {
  // First slot whose bottom reaches `top` (binary search: bottoms are increasing too).
  let lo = 0;
  let hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].top + slots[mid].height >= top) hi = mid;
    else lo = mid + 1;
  }
  const out: TimelineSlot<G, T>[] = [];
  for (let i = 0; i < lo; i++) if (slots[i].task && pinned.has(slots[i].task!.id)) out.push(slots[i]);
  let i = lo;
  for (; i < slots.length && slots[i].top <= bottom; i++) out.push(slots[i]);
  for (; i < slots.length; i++) if (slots[i].task && pinned.has(slots[i].task!.id)) out.push(slots[i]);
  return out;
}

// An arrow is drawn when any part of its vertical run is within [top, bottom]: either end on screen, or a
// line passing through it (one end above, the other below) — the same lines as when every one was drawn.
export function arrowInView(y1: number, y2: number, top: number, bottom: number): boolean {
  return Math.min(y1, y2) <= bottom && Math.max(y1, y2) >= top;
}

type FrameApi = {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
};

// Runs `fn` at most once per animation frame however many times `schedule` is called in it.
export function frameThrottle(fn: () => void, api: FrameApi): { schedule: () => void; cancel: () => void } {
  let handle: number | null = null;
  return {
    schedule() {
      if (handle !== null) return;
      handle = api.request(() => {
        handle = null;
        fn();
      });
    },
    cancel() {
      if (handle !== null) api.cancel(handle);
      handle = null;
    },
  };
}
