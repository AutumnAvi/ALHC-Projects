// Batch 39 (speed and feel): the short motion added to panels, dialogs, toasts, popovers, the phone drawer,
// buttons, and dragged rows; the reduced-motion rule that switches all of it off; and "Show more" on List
// and Board saying "Loading…" while the next page is on its way.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ShowMoreRows } from "@/components/show-more";
import { leaveGhost } from "@/lib/exit-ghost";

const css = readFileSync("src/app/globals.css", "utf8");

function reducedMotionBlock(): string {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(start >= 0, "a reduced-motion rule exists");
  // The block runs to the next top-level rule (a blank line followed by a non-indented line).
  const rest = css.slice(start);
  const end = rest.search(/\n}\n/);
  return rest.slice(0, end + 2);
}

test("every new animation class is switched off under reduced motion", () => {
  const block = reducedMotionBlock();
  const animated = [...new Set([...css.matchAll(/\.(ui-anim-[a-z-]+)\s*\{[^}]*animation:/g)].map((m) => m[1]))];
  assert.ok(animated.length >= 8, `found the animation classes (${animated.join(", ")})`);
  for (const name of animated) assert.ok(block.includes(`.${name}`), `${name} is in the reduced-motion rule`);
  assert.match(block, /animation: none !important/);
  assert.match(block, /transition: none !important/);
  // The pane width ease, the exit copies, and the button press too.
  assert.ok(block.includes(".app-main"), "the pane width ease");
  assert.ok(block.includes("[data-exit-ghost]"), "the exit copies");
  assert.match(block, /\.btn-primary:active \{\s*transform: none !important;/);
});

test("motion stays short and uses opacity / transform (the pane width is the one layout ease)", () => {
  for (const match of css.matchAll(/(?:animation|transition):[^;]*?(\d+)ms/g)) {
    assert.ok(Number(match[1]) <= 200, `${match[0]} is under 200 ms`);
  }
  for (const frames of css.matchAll(/@keyframes ui-[a-z-]+ \{([\s\S]*?)\n\}/g)) {
    const props = [...frames[1].matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
    for (const prop of props) assert.ok(prop === "opacity" || prop === "transform", `keyframes animate ${prop}`);
  }
  assert.match(css, /\.app-main \{\s*transition: padding-right 180ms/);
  assert.match(css, /&:active:not\(:disabled\) \{\s*transform: scale\(0\.98\);/);
});

test("the overlays carry their entrance classes", () => {
  const dialog = readFileSync("src/components/dialog.tsx", "utf8");
  assert.match(dialog, /ui-anim-fade-in fixed inset-0 z-50/);
  assert.match(dialog, /ui-anim-rise-in max-h-\[90vh\]/);
  assert.match(dialog, /leaveGhost\(overlay, "ui-anim-fade-out"\)/);
  const popover = readFileSync("src/components/popover.tsx", "utf8");
  // Only once measured and placed, so the flip logic never measures a scaled box.
  assert.match(popover, /position\.placed \? "ui-anim-pop-in " : ""/);
  const toast = readFileSync("src/components/toast.tsx", "utf8");
  assert.match(toast, /ui-anim-toast-out/);
  assert.match(toast, /aria-hidden=\{toast\.leaving \? true : undefined\}/);
  const shell = readFileSync("src/components/shell/app-shell.tsx", "utf8");
  assert.match(shell, /ui-anim-drawer-in absolute inset-y-0 left-0/);
  assert.match(shell, /leaveGhost\(root, "ui-anim-drawer-out"/);
  const list = readFileSync("src/components/project/list-view.tsx", "utf8");
  assert.match(list, /dragging \? "ui-dragging opacity-40" : ""/);
  // A dragged row only gets a shadow: no z-index (list-grid.ts keeps the pinned column's stacking).
  const dragging = css.match(/\.ui-dragging \{([^}]*)\}/)?.[1] ?? "";
  assert.match(dragging, /box-shadow/);
  assert.doesNotMatch(dragging, /z-index|position/);
});

test("Show more reads Loading… and can't be clicked again while the next page loads", () => {
  const idle = renderToStaticMarkup(<ShowMoreRows hidden={200} onClick={() => {}} />);
  assert.match(idle, />Show 80 more</);
  assert.doesNotMatch(idle, /aria-disabled/);
  const loading = renderToStaticMarkup(<ShowMoreRows hidden={200} onClick={() => {}} loading />);
  assert.match(loading, />Loading…</);
  assert.match(loading, /aria-disabled="true"/);
  assert.match(loading, /aria-busy="true"/);
  // Not the disabled attribute: a keyboard user's focus stays on the button.
  assert.doesNotMatch(loading, / disabled=""/);
  for (const file of ["src/components/project/list-view.tsx", "src/components/project/board-view.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /const \[showMorePage, loadingPage\] = usePagedShowMore\(\);/, file);
    assert.match(source, /loading=\{group\.total != null && loadingPage === group\.key\}/, file);
  }
});

test("the exit copy does nothing without a page (server render, tests)", () => {
  assert.doesNotThrow(() => leaveGhost(null, "ui-anim-fade-out"));
});
