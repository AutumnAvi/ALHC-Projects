// Automations V2, batch 1 — the searchable picker: search ranking, grouping, the keyboard model, and
// the closed button's ARIA.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SmartPicker } from "@/components/smart-picker";
import {
  filterOptions,
  flatOptions,
  initialActive,
  isPrintableKey,
  pickerKey,
  typeAhead,
  type PickerOption,
  type PickerState,
} from "@/lib/smart-picker";
import { ACTIONS, CONDITIONS, TRIGGERS } from "@/lib/rules";

const options: PickerOption[] = [
  { value: "a", label: "Apple", group: "Fruit" },
  { value: "b", label: "Banana", group: "Fruit", disabled: true, disabledReason: "Out of stock" },
  { value: "c", label: "Cherry", group: "Fruit" },
  { value: "d", label: "Carrot", group: "Vegetables", keywords: ["orange"] },
  { value: "e", label: "Celery", group: "Vegetables", description: "Crunchy and green" },
];

const open = (active: number, query = ""): PickerState => ({ open: true, active, query });

test("arrows skip disabled options and wrap around", () => {
  assert.equal(pickerKey(open(0), "ArrowDown", options).state.active, 2); // Banana is disabled
  assert.equal(pickerKey(open(2), "ArrowUp", options).state.active, 0);
  assert.equal(pickerKey(open(4), "ArrowDown", options).state.active, 0); // wraps
  assert.equal(pickerKey(open(0), "ArrowUp", options).state.active, 4);
  assert.equal(pickerKey(open(-1), "ArrowDown", options).state.active, 0);
  assert.equal(pickerKey(open(-1), "ArrowUp", options).state.active, 4);
});

test("Home and End jump to the first and last enabled options", () => {
  const disabledEnds: PickerOption[] = [{ value: "x", label: "X", disabled: true }, ...options, { value: "z", label: "Z", disabled: true }];
  assert.equal(pickerKey(open(3), "Home", disabledEnds).state.active, 1);
  assert.equal(pickerKey(open(1), "End", disabledEnds).state.active, 5);
});

test("Enter chooses the highlighted option, never a disabled one", () => {
  assert.deepEqual(pickerKey(open(2), "Enter", options).effect, { kind: "select", value: "c" });
  assert.deepEqual(pickerKey(open(1), "Enter", options).effect, { kind: "none" });
  assert.deepEqual(pickerKey(open(-1), "Enter", options).effect, { kind: "none" });
});

test("Escape clears the search first, then closes; every handled key is consumed", () => {
  const first = pickerKey(open(0, "car"), "Escape", options);
  assert.equal(first.state.query, "");
  assert.equal(first.state.open, true);
  assert.equal(first.handled, true);
  const second = pickerKey(first.state, "Escape", options);
  assert.equal(second.state.open, false);
  assert.deepEqual(second.effect, { kind: "close" });
});

test("Tab closes and lets focus move on (not consumed)", () => {
  const result = pickerKey(open(0), "Tab", options);
  assert.equal(result.handled, false);
  assert.equal(result.state.open, false);
  assert.deepEqual(result.effect, { kind: "blur" });
});

test("letters aren't handled by the list keys (they go to the search box)", () => {
  assert.equal(pickerKey(open(0), "a", options).handled, false);
  assert.equal(isPrintableKey("a"), true);
  assert.equal(isPrintableKey(" "), false);
  assert.equal(isPrintableKey("ArrowDown"), false);
  assert.equal(isPrintableKey("k", { meta: true }), false);
});

test("type-ahead jumps to the next match and cycles on a repeated letter", () => {
  assert.equal(typeAhead(options, "c", 0), 2); // Cherry
  assert.equal(typeAhead(options, "cc", 2), 3); // Carrot
  assert.equal(typeAhead(options, "ccc", 3), 4); // Celery
  assert.equal(typeAhead(options, "cccc", 4), 2); // wraps to Cherry
  assert.equal(typeAhead(options, "cel", 0), 4);
  assert.equal(typeAhead(options, "b", 0), 0); // only Banana starts with b, and it's disabled
  assert.equal(typeAhead(options, "zz", 2), 2);
});

test("the initial highlight is the chosen value when visible, else the first enabled option", () => {
  assert.equal(initialActive(options, ["d"]), 3);
  assert.equal(initialActive(options, ["b"]), 0);
  assert.equal(initialActive(options, []), 0);
  assert.equal(initialActive([], []), -1);
});

test("search keeps groups, ranks label matches first, and matches keywords and descriptions", () => {
  const groups = filterOptions(options, "c");
  assert.deepEqual(
    groups.map((g) => g.name),
    ["Fruit", "Vegetables"],
  );
  assert.deepEqual(flatOptions(filterOptions(options, "orange")).map((o) => o.value), ["d"]);
  assert.deepEqual(flatOptions(filterOptions(options, "crunchy")).map((o) => o.value), ["e"]);
  assert.deepEqual(flatOptions(filterOptions(options, "")).map((o) => o.value), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(flatOptions(filterOptions(options, "zzz")), []);
});

test("typing “assign” finds Set assignee, Assignee changes and Has an assignee", () => {
  const all = [...TRIGGERS, ...CONDITIONS, ...ACTIONS].map((x) => ({ ...x, value: `${x.value}:${x.label}` }));
  const labels: string[] = flatOptions(filterOptions(all, "assign")).map((o) => o.label);
  for (const wanted of ["Set assignee", "Assignee changes", "Has an assignee"]) assert.ok(labels.includes(wanted), wanted);
});

test("the closed picker is an ARIA combobox that names its value", () => {
  const html = renderToStaticMarkup(
    <SmartPicker label="Section" value="c" options={options} onChange={() => {}} />,
  );
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Section"/);
  assert.match(html, />Cherry</);
  assert.doesNotMatch(html, /<select/);
});

test("an empty chip shows its placeholder; a template slot that still needs a value is highlighted", () => {
  const html = renderToStaticMarkup(
    <SmartPicker label="Section" value={null} options={options} onChange={() => {}} variant="chip" placeholder="choose section" highlight />,
  );
  assert.match(html, /choose section/);
  assert.match(html, /data-picker-empty="true"/);
  assert.match(html, /bg-amber-50/);
});
