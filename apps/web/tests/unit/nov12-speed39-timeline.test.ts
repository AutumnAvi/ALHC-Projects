// Nov 12 (batch 39, item 4): Timeline scrolls without rebuilding the chart, draws only the lines near the
// screen, and works out the critical path up front only while its switch is on.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  BAND_ROWS,
  arrowInView,
  frameThrottle,
  layoutSlots,
  sameBand,
  viewportBand,
  visibleSlots,
  type Band,
} from "@/components/project/timeline-layout";

const ROW = 36;
const STEP = BAND_ROWS * ROW;
const geometry = { header: 49, group: 32, row: ROW };

function bigGroups(groupCount: number, perGroup: number) {
  return Array.from({ length: groupCount }, (_, g) => ({
    key: `g${g}`,
    tasks: Array.from({ length: perGroup }, (_, t) => ({ id: `g${g}-t${t}` })),
  }));
}

test("row positions match the old loop (headings, rows, centres, content height)", () => {
  const groups = bigGroups(3, 4);
  const { slots, rowCenter, contentHeight } = layoutSlots(groups, true, geometry);
  assert.equal(slots.length, 3 + 12);
  assert.equal(slots[0].top, 49);
  assert.equal(slots[1].top, 49 + 32);
  assert.equal(rowCenter.get("g0-t0"), 49 + 32 + 18);
  assert.equal(contentHeight, 49 + 3 * 32 + 12 * ROW);
  const flat = layoutSlots(groups, false, geometry);
  assert.equal(flat.slots.length, 12);
  assert.equal(flat.contentHeight, 49 + 12 * ROW);
});

test("visibleSlots keeps the same rows as the old filter, plus pinned rows anywhere", () => {
  const { slots } = layoutSlots(bigGroups(10, 50), true, geometry);
  for (const [top, bottom] of [
    [-400, 600],
    [5000, 6200],
    [17000, 19000],
    [0, 0],
  ] as const) {
    const old = slots.filter((s) => s.top + s.height >= top && s.top <= bottom).map((s) => s.key);
    assert.deepEqual(
      visibleSlots(slots, top, bottom).map((s) => s.key),
      old,
    );
  }
  const pinned = new Set(["g0-t0", "g9-t49"]);
  const keys = visibleSlots(slots, 5000, 6200, pinned).map((s) => s.key);
  assert.ok(keys.includes("g0-t0") && keys.includes("g9-t49"));
});

test("the band always contains the viewport and only changes every few rows", () => {
  for (let scrollTop = 0; scrollTop < 5000; scrollTop += 7) {
    const band = viewportBand(scrollTop, 720, STEP);
    assert.ok(band.top <= scrollTop && band.bottom >= scrollTop + 720);
  }
  assert.ok(sameBand(viewportBand(10, 720, STEP), viewportBand(100, 720, STEP)));
  assert.ok(!sameBand(viewportBand(10, 720, STEP), viewportBand(STEP + 10, 720, STEP)));
});

// Before: every scroll event set the raw scroll position, so the chart re-rendered — and rebuilt every
// row position and arrow — once per event. After: once per frame at most, and only when the band moves.
test("renders on scroll: once per band change, at most once per frame", () => {
  const frames: Array<() => void> = [];
  let renders = 0;
  let band: Band = viewportBand(0, 720, STEP);
  let scrollTop = 0;
  const frame = frameThrottle(
    () => {
      const next = viewportBand(scrollTop, 720, STEP);
      if (!sameBand(band, next)) {
        band = next;
        renders += 1;
      }
    },
    { request: (cb) => frames.push(cb), cancel: () => undefined },
  );
  // 360 scroll events, 10px each, three per frame.
  let events = 0;
  for (let i = 1; i <= 360; i++) {
    scrollTop = i * 10;
    frame.schedule();
    events += 1;
    if (i % 3 === 0) frames.splice(0).forEach((cb) => cb());
  }
  assert.equal(events, 360);
  assert.ok(renders <= 120, "at most once per frame");
  // The band's top and bottom edges each step every STEP pixels.
  assert.ok(renders <= 2 * Math.ceil(3600 / STEP) + 2, `once per band change (${renders})`);
  assert.ok(renders >= 1);
});

test("frameThrottle coalesces calls in one frame and can be cancelled", () => {
  const frames: Array<() => void> = [];
  let ran = 0;
  const frame = frameThrottle(() => (ran += 1), { request: (cb) => frames.push(cb), cancel: () => frames.splice(0) });
  frame.schedule();
  frame.schedule();
  frame.schedule();
  assert.equal(frames.length, 1);
  frames.splice(0).forEach((cb) => cb());
  assert.equal(ran, 1);
  frame.schedule();
  frame.cancel();
  assert.equal(frames.length, 0);
});

test("a line is drawn when either end is in the band, or it passes through it", () => {
  assert.ok(arrowInView(100, 5000, 0, 800)); // top end on screen
  assert.ok(arrowInView(5000, 100, 0, 800)); // other order
  assert.ok(arrowInView(-500, 5000, 0, 800)); // passes through
  assert.ok(!arrowInView(2000, 5000, 0, 800)); // both below
  assert.ok(!arrowInView(-900, -100, 0, 800)); // both above
});

const view = fs.readFileSync(new URL("../../src/components/project/timeline-view.tsx", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../../src/components/project/project-view-page.tsx", import.meta.url), "utf8");

test("the critical path is worked out on the server only while its switch is on", () => {
  assert.match(page, /layout === "timeline" && searchParams\.cp === "1" \? projectCriticalPath\(projectId\) : Promise\.resolve\(null\)/);
  // Dependencies still load with the chart.
  assert.match(page, /layout === "timeline" \? listProjectDependencies\(projectId\)/);
  // Otherwise the chart asks for it after it paints (same numbers for the slack tooltips and the switch).
  assert.match(view, /if \(criticalPathProp\) return;/);
  assert.match(view, /loadProjectCriticalPath\(projectId\)/);
});

test("scrolling goes through the band and one frame; layout and arrows are memoized", () => {
  assert.match(view, /frameThrottle\(update/);
  assert.match(view, /sameBand\(current, next\) \? current : next/);
  assert.match(view, /const layout = useMemo\(/);
  assert.match(view, /const restingArrows = useMemo\(/);
  assert.match(view, /arrowInView\(arrow\.y1, arrow\.y2, viewTop, viewBottom\)/);
  assert.doesNotMatch(view, /setViewport\(\{ top: el\.scrollTop/);
});
