// Oct 29 notes, batch 7, item 54 (the app's side; the database's is the T2 part of suite zz36): one
// palette of twenty colors for field options, portfolio field options, and tags; the first nine keep
// their names and order; tags keep the picked color in palette_color and the nearest of the nine in
// color; the picker is a grid of swatches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ColorGrid, ColorPicker, colorGridStep } from "@/components/color-picker";
import {
  BASE_OPTION_COLORS,
  OPTION_BASE_COLOR,
  OPTION_COLORS,
  OPTION_COLOR_CLASSES,
  OPTION_COLOR_GRID,
  OPTION_COLOR_GRID_COLUMNS,
  OPTION_COLOR_LABELS,
  OPTION_SWATCH_CLASSES,
  isBaseOptionColor,
  isOptionColor,
  parseOptions,
} from "@/lib/fields";
import { tagColorColumns, tagColorOf, toTag } from "@/lib/tags";

// The batch's one migration.
const migration = readFileSync(join(process.cwd(), "supabase/migrations", "20261029010000_oct29_batch7_a.sql"), "utf8");

// The text of one SQL function's body (between `as $$` and `$$;`).
function sqlBody(name: string) {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} in the migration`);
  const open = migration.indexOf("as $$", start);
  return migration.slice(open, migration.indexOf("$$;", open + 5));
}

test("the palette: twenty colors, the original nine first in their order", () => {
  assert.equal(OPTION_COLORS.length, 20);
  assert.equal(new Set(OPTION_COLORS).size, 20, "no repeats");
  assert.deepEqual(
    [...OPTION_COLORS.slice(0, 9)],
    ["zinc", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"],
  );
  assert.deepEqual([...BASE_OPTION_COLORS], [...OPTION_COLORS.slice(0, 9)]);
  for (const color of ["lime", "emerald", "cyan", "sky", "indigo", "purple", "fuchsia", "rose", "slate", "stone", "yellow"]) {
    assert.ok(isOptionColor(color), `${color} is in the palette`);
    assert.ok(!isBaseOptionColor(color), `${color} isn't one of the first nine`);
  }
  assert.ok(!isOptionColor("neon"));
});

test("every color has a chip, a label, a swatch, and a base", () => {
  for (const color of OPTION_COLORS) {
    const chip = OPTION_COLOR_CLASSES[color];
    // A light background and dark text of the color's own hue: readable (100 / 200 with 700–900).
    const match = /^bg-([a-z]+)-(100|200) text-([a-z]+)-(700|800|900)$/.exec(chip);
    assert.ok(match, `${color}: ${chip}`);
    assert.equal(match[1], color, `${color}'s chip background is its own hue`);
    assert.equal(match[3], color, `${color}'s chip text is its own hue`);
    if (match[2] === "200") assert.notEqual(match[4], "700", `${color}: a 200 background needs 800 / 900 text`);
    assert.match(OPTION_SWATCH_CLASSES[color], new RegExp(`^bg-${color}-(300|400|500|600)$`));
    assert.ok(OPTION_COLOR_LABELS[color].length > 0);
    assert.ok(isBaseOptionColor(OPTION_BASE_COLOR[color]), `${color} maps to one of the first nine`);
  }
  for (const color of BASE_OPTION_COLORS) assert.equal(OPTION_BASE_COLOR[color], color, `${color} is its own base`);
  assert.equal(OPTION_COLOR_LABELS.zinc, "Gray", "American spelling");
  // Every chip is distinct from every other.
  assert.equal(new Set(Object.values(OPTION_COLOR_CLASSES)).size, 20);
  assert.equal(new Set(Object.values(OPTION_SWATCH_CLASSES)).size, 20);
});

test("the SQL palette and nearest-base mapping mirror the app", () => {
  const sqlColors = [...sqlBody("option_colors").matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(sqlColors, [...OPTION_COLORS], "option_colors() = OPTION_COLORS, same order");
  const check = /tags_palette_color_check check \(([\s\S]+?)\]::text\[\]\)\s*\);/.exec(migration);
  assert.ok(check, "the palette_color CHECK");
  assert.deepEqual([...check[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]), [...OPTION_COLORS], "the CHECK lists the palette");
  const mapping = Object.fromEntries(
    [...sqlBody("option_color_base").matchAll(/when '([a-z]+)' then '([a-z]+)'/g)].map((m) => [m[1], m[2]]),
  );
  for (const color of OPTION_COLORS) {
    assert.equal(mapping[color] ?? color, OPTION_BASE_COLOR[color], `option_color_base('${color}')`);
  }
});

test("the picker grid holds every color once, five columns in hue order", () => {
  assert.equal(OPTION_COLOR_GRID_COLUMNS, 5);
  assert.deepEqual([...OPTION_COLOR_GRID].sort(), [...OPTION_COLORS].sort());
  assert.deepEqual(OPTION_COLOR_GRID.slice(0, 3), ["zinc", "slate", "stone"], "grays first");
});

test("arrow keys move through the grid", () => {
  assert.equal(colorGridStep(0, "ArrowRight"), 1);
  assert.equal(colorGridStep(19, "ArrowRight"), 0, "right wraps");
  assert.equal(colorGridStep(0, "ArrowLeft"), 19, "left wraps");
  assert.equal(colorGridStep(2, "ArrowDown"), 7);
  assert.equal(colorGridStep(17, "ArrowDown"), 17, "down stops at the last row");
  assert.equal(colorGridStep(7, "ArrowUp"), 2);
  assert.equal(colorGridStep(3, "ArrowUp"), 3, "up stops at the first row");
  assert.equal(colorGridStep(9, "Home"), 0);
  assert.equal(colorGridStep(9, "End"), 19);
  assert.equal(colorGridStep(9, "Enter"), null, "Enter is the button's own");
});

test("the grid: one option per color, the picked one selected and focusable", () => {
  const html = renderToStaticMarkup(<ColorGrid value="rose" label="Tag color" onPick={() => {}} />);
  assert.match(html, /role="listbox" aria-label="Tag color"/);
  const options = [...html.matchAll(/<button[^>]*role="option"[^>]*>/g)].map((m) => m[0]);
  assert.equal(options.length, 20);
  const selected = options.filter((tag) => tag.includes('aria-selected="true"'));
  assert.equal(selected.length, 1);
  assert.match(selected[0], /aria-label="Rose"/);
  assert.match(selected[0], /data-tooltip="Rose"/);
  assert.match(selected[0], /tabindex="0"/i);
  assert.equal(options.filter((tag) => /tabindex="0"/i.test(tag)).length, 1, "one tab stop");
  // In grid order.
  assert.deepEqual(
    options.map((tag) => /data-color="([a-z]+)"/.exec(tag)?.[1]),
    [...OPTION_COLOR_GRID],
  );
  // The caption names the picked color.
  assert.match(html, />Rose<\/p>/);
});

test("the picker button: the swatch and its name; read-only when disabled", () => {
  const full = renderToStaticMarkup(<ColorPicker value="emerald" onChange={() => {}} label="Tag color" />);
  assert.match(full, /aria-label="Tag color: Emerald"/);
  assert.match(full, /bg-emerald-600/);
  assert.match(full, />Emerald</);
  const compact = renderToStaticMarkup(<ColorPicker compact value="sky" onChange={() => {}} label="Color of High" />);
  assert.match(compact, /aria-label="Color of High: Sky"/);
  assert.match(compact, /data-tooltip="Color: Sky"/);
  const disabled = renderToStaticMarkup(<ColorPicker disabled value="stone" onChange={() => {}} label="Color of High" />);
  assert.doesNotMatch(disabled, /<button/);
  assert.match(disabled, /Stone/);
});

test("field options keep palette colors; unknown ones read as Gray", () => {
  assert.deepEqual(
    parseOptions([
      { id: "a", name: "A", color: "fuchsia" },
      { id: "b", name: "B", color: "neon" },
      { id: "c", name: "C", color: "blue" },
    ]),
    [
      { id: "a", name: "A", color: "fuchsia" },
      { id: "b", name: "B", color: "zinc" },
      { id: "c", name: "C", color: "blue" },
    ],
  );
});

test("tags: coalesce(palette_color, color), and what a write stores", () => {
  assert.equal(tagColorOf({ color: "red", palette_color: "rose" }), "rose");
  assert.equal(tagColorOf({ color: "blue", palette_color: null }), "blue");
  assert.equal(tagColorOf({ color: "blue" }), "blue", "a database without palette_color");
  assert.equal(tagColorOf({ color: "neon", palette_color: null }), "zinc");
  assert.equal(tagColorOf({ color: "teal", palette_color: "neon" }), "teal");
  assert.deepEqual(tagColorColumns("rose"), { color: "red", palette_color: "rose" });
  assert.deepEqual(tagColorColumns("blue"), { color: "blue", palette_color: "blue" });
  assert.deepEqual(tagColorColumns("slate"), { color: "zinc", palette_color: "slate" });
  const tag = toTag({ id: "t", name: "Print", color: "teal", palette_color: "cyan", archived_at: null, created_by: null });
  assert.equal(tag.color, "cyan");
});
