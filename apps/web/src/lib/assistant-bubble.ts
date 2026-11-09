// AI builder round 4 (experimental, note 176): where the AI assistant's floating bubble sits and where its
// panel opens. Pure (no DOM): the bubble component measures the window and calls these.
//
// The bubble always rests on a screen edge (snapped after a drag), stored as the edge plus its distance
// along it, so a resize keeps it on the same edge and only clamps it back on screen. It starts on the
// right edge, above the bottom-right corner (clear of the bulk bar, the toasts at the bottom left, and
// the task pane's comment box and Send buttons at the bottom right). Remembered per person in this
// browser (localStorage), never on the server.

export const BUBBLE_SIZE = 48;
export const BUBBLE_MARGIN = 16;
// Below the top bar (2.75rem) so it never covers search or the avatar menu.
export const BUBBLE_TOP_MIN = 56;
// The default distance from the bubble's bottom to the window's bottom.
export const BUBBLE_DEFAULT_BOTTOM = 160;
// A pointer has to move this far before a press becomes a drag (a click still opens it).
export const DRAG_THRESHOLD = 6;
export const KEY_STEP = 24;
export const KEY_STEP_LARGE = 96;
export const PANEL_GAP = 10;
export const PANEL_WIDTH = 432;
export const PANEL_MIN_HEIGHT = 320;

export type BubbleEdge = "left" | "right" | "top" | "bottom";
// offset = the distance along the edge: from the window's top on the left / right edges, from its left
// on the top / bottom edges.
export type BubblePos = { edge: BubbleEdge; offset: number };
export type Viewport = { width: number; height: number };
export type Point = { x: number; y: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const vertical = (edge: BubbleEdge) => edge === "left" || edge === "right";

export const storageKey = (memberId: string | null) => `alhc.ai-bubble.${memberId ?? "anon"}`;

export function defaultBubblePos(v: Viewport): BubblePos {
  return clampBubble({ edge: "right", offset: v.height - BUBBLE_SIZE - BUBBLE_DEFAULT_BOTTOM }, v);
}

// Back on screen (after a resize, or a stored position from a bigger window).
export function clampBubble(pos: BubblePos, v: Viewport): BubblePos {
  const offset = vertical(pos.edge)
    ? clamp(pos.offset, BUBBLE_TOP_MIN, v.height - BUBBLE_SIZE - BUBBLE_MARGIN)
    : clamp(pos.offset, BUBBLE_MARGIN, v.width - BUBBLE_SIZE - BUBBLE_MARGIN);
  return { edge: pos.edge, offset: Math.round(offset) };
}

// The bubble's top-left corner on screen.
export function bubbleXY(pos: BubblePos, v: Viewport): Point {
  const p = clampBubble(pos, v);
  switch (p.edge) {
    case "left":
      return { x: BUBBLE_MARGIN, y: p.offset };
    case "right":
      return { x: Math.max(BUBBLE_MARGIN, v.width - BUBBLE_SIZE - BUBBLE_MARGIN), y: p.offset };
    case "top":
      return { x: p.offset, y: BUBBLE_TOP_MIN };
    case "bottom":
      return { x: p.offset, y: Math.max(BUBBLE_TOP_MIN, v.height - BUBBLE_SIZE - BUBBLE_MARGIN) };
  }
}

// Where a drag dropped it (its top-left corner) → the nearest edge.
export function snapBubble(at: Point, v: Viewport): BubblePos {
  const distances: [BubbleEdge, number][] = [
    ["left", at.x],
    ["right", v.width - (at.x + BUBBLE_SIZE)],
    ["top", at.y - BUBBLE_TOP_MIN],
    ["bottom", v.height - (at.y + BUBBLE_SIZE)],
  ];
  const [edge] = distances.reduce((best, d) => (d[1] < best[1] ? d : best));
  return clampBubble({ edge, offset: vertical(edge) ? at.y : at.x }, v);
}

// Where it is while being dragged: follows the pointer, never off screen.
export function dragPoint(pointer: Point, grab: Point, v: Viewport): Point {
  return {
    x: clamp(pointer.x - grab.x, 0, v.width - BUBBLE_SIZE),
    y: clamp(pointer.y - grab.y, BUBBLE_TOP_MIN - BUBBLE_MARGIN, v.height - BUBBLE_SIZE),
  };
}

export function isDrag(start: Point, now: Point, threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) >= threshold;
}

// Keyboard moves (the bubble focused): the arrows along its edge move it along; an arrow across moves it to
// that edge; Shift moves farther; Home puts it back where it started. Null = not a move key (Enter and
// Space still open it; ⌘ / Ctrl / Alt combinations are never taken).
export function keyMove(pos: BubblePos, e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, v: Viewport): BubblePos | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  const xy = bubbleXY(pos, v);
  const along = (delta: number) => clampBubble({ edge: pos.edge, offset: pos.offset + delta }, v);
  switch (e.key) {
    case "Home":
      return defaultBubblePos(v);
    case "ArrowUp":
      return vertical(pos.edge) ? along(-step) : clampBubble({ edge: "top", offset: xy.x }, v);
    case "ArrowDown":
      return vertical(pos.edge) ? along(step) : clampBubble({ edge: "bottom", offset: xy.x }, v);
    case "ArrowLeft":
      return vertical(pos.edge) ? clampBubble({ edge: "left", offset: xy.y }, v) : along(-step);
    case "ArrowRight":
      return vertical(pos.edge) ? clampBubble({ edge: "right", offset: xy.y }, v) : along(step);
    default:
      return null;
  }
}

export function describeBubble(pos: BubblePos): string {
  return `AI assistant button moved to the ${pos.edge} edge`;
}

export function parseBubblePos(raw: string | null): BubblePos | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<BubblePos>;
    if ((v.edge === "left" || v.edge === "right" || v.edge === "top" || v.edge === "bottom") && typeof v.offset === "number" && Number.isFinite(v.offset)) {
      return { edge: v.edge, offset: Math.round(v.offset) };
    }
  } catch {
    // Not ours, or damaged: the default position.
  }
  return null;
}

export const serializeBubblePos = (pos: BubblePos) => JSON.stringify({ edge: pos.edge, offset: Math.round(pos.offset) });

export type PanelPlacement = { left: number; width: number; maxHeight: number } & ({ top: number } | { bottom: number });

// The panel opens next to the bubble — beside it on the left / right edges (bottoms aligned; from the
// bubble's top down when there's too little room above), above / below it on the bottom / top edges —
// flipped and clamped so it stays on screen.
export function panelPlacement(pos: BubblePos, v: Viewport): PanelPlacement {
  const width = Math.max(0, Math.min(PANEL_WIDTH, v.width - 2 * BUBBLE_MARGIN));
  const xy = bubbleXY(pos, v);
  const cap = (h: number) => Math.max(200, Math.min(h, v.height - 80));
  const leftWithin = (x: number) => clamp(x, BUBBLE_MARGIN, v.width - width - BUBBLE_MARGIN);
  if (vertical(pos.edge)) {
    const left = leftWithin(pos.edge === "right" ? xy.x - PANEL_GAP - width : xy.x + BUBBLE_SIZE + PANEL_GAP);
    const bottom = v.height - (xy.y + BUBBLE_SIZE);
    const above = v.height - bottom - BUBBLE_TOP_MIN;
    if (above >= PANEL_MIN_HEIGHT) return { left, width, bottom, maxHeight: cap(above) };
    return { left, width, top: xy.y, maxHeight: cap(v.height - xy.y - BUBBLE_MARGIN) };
  }
  const left = leftWithin(xy.x + BUBBLE_SIZE / 2 - width / 2);
  if (pos.edge === "bottom") {
    const bottom = v.height - xy.y + PANEL_GAP;
    return { left, width, bottom, maxHeight: cap(v.height - bottom - BUBBLE_TOP_MIN) };
  }
  const top = xy.y + BUBBLE_SIZE + PANEL_GAP;
  return { left, width, top, maxHeight: cap(v.height - top - BUBBLE_MARGIN) };
}
