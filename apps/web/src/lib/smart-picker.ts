// The searchable picker's logic (Automations V2): search ranking, grouping, and the keyboard model.
// Kept free of React and the DOM so it can be unit-tested; components/smart-picker.tsx draws it.

export type PickerOption = {
  value: string;
  label: string;
  // A one-line, gray explanation under the label ("Fires when a task enters a section you pick").
  description?: string;
  // Options with the same group are listed under one heading, in the order groups first appear.
  group?: string;
  // Extra words search matches ("assign" finds "Set assignee", "Has an assignee", …).
  keywords?: readonly string[];
  disabled?: boolean;
  // Shown instead of the description for a disabled option ("Add a form to this project first").
  disabledReason?: string;
};

export type PickerGroup<T extends PickerOption = PickerOption> = { name: string | null; options: T[] };

function norm(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”"’']/g, "")
    .trim();
}

// Characters of `needle` in order inside `hay` (loose "fuzzy" match).
function subsequence(needle: string, hay: string) {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i += 1;
  return i === needle.length;
}

// How well an option matches a query: higher is better, 0 = no match. Every word of the query must
// match somewhere (label, keywords, description, group).
export function matchScore(option: PickerOption, query: string): number {
  const q = norm(query);
  if (!q) return 1;
  const label = norm(option.label);
  const words = q.split(/\s+/).filter(Boolean);
  const haystack = [label, ...(option.keywords ?? []).map(norm), norm(option.description ?? ""), norm(option.group ?? "")].join(" ");
  if (!words.every((w) => haystack.includes(w))) {
    // A typo-tolerant last resort for a single word against the label ("asgn" → "assign").
    return words.length === 1 && q.length >= 3 && subsequence(q, label) ? 5 : 0;
  }
  if (label === q) return 100;
  if (label.startsWith(q)) return 90;
  if (label.split(/[\s/(),-]+/).some((w) => w.startsWith(words[0]))) return 70;
  if (label.includes(q)) return 60;
  if ((option.keywords ?? []).some((k) => norm(k).startsWith(words[0]))) return 40;
  return 20;
}

// The options a query shows, grouped. Without a query the original order (and group order) is kept;
// with one, each group keeps only its matches, best first, and groups are ordered by their best match.
export function filterOptions<T extends PickerOption>(options: readonly T[], query: string): PickerGroup<T>[] {
  const scored = options.map((option, index) => ({ option, index, score: matchScore(option, query) })).filter((s) => s.score > 0);
  const groups = new Map<string | null, { best: number; first: number; items: typeof scored }>();
  for (const s of scored) {
    const key = s.option.group ?? null;
    const g = groups.get(key) ?? { best: 0, first: s.index, items: [] };
    g.best = Math.max(g.best, s.score);
    g.items.push(s);
    groups.set(key, g);
  }
  const searching = norm(query) !== "";
  return [...groups.entries()]
    .sort(([, a], [, b]) => (searching ? b.best - a.best || a.first - b.first : a.first - b.first))
    .map(([name, g]) => ({
      name,
      options: (searching ? [...g.items].sort((a, b) => b.score - a.score || a.index - b.index) : g.items).map((s) => s.option),
    }));
}

// The visible options in the order the keyboard walks them.
export function flatOptions<T extends PickerOption>(groups: PickerGroup<T>[]): T[] {
  return groups.flatMap((g) => g.options);
}

export type PickerState = {
  open: boolean;
  // Index into the visible (flat) options; -1 = nothing highlighted.
  active: number;
  query: string;
};

export type PickerEffect =
  | { kind: "none" }
  | { kind: "select"; value: string }
  | { kind: "close" }
  // Tab: close and let focus move on.
  | { kind: "blur" };

function step(options: readonly PickerOption[], from: number, delta: 1 | -1): number {
  if (options.length === 0) return -1;
  let i = from;
  for (let n = 0; n < options.length; n += 1) {
    i = (i + delta + options.length) % options.length;
    if (!options[i].disabled) return i;
  }
  return -1;
}

function edge(options: readonly PickerOption[], which: "first" | "last"): number {
  const indexes = options.map((_, i) => i);
  const ordered = which === "first" ? indexes : indexes.reverse();
  return ordered.find((i) => !options[i].disabled) ?? -1;
}

// The highlight when the list opens or its matches change: the selected value if it is visible,
// else the first enabled option.
export function initialActive(options: readonly PickerOption[], selected: readonly string[]): number {
  const index = options.findIndex((o) => !o.disabled && selected.includes(o.value));
  return index >= 0 ? index : edge(options, "first");
}

// One key press while the list is open (focus in its search box). `options` are the visible ones.
// Printable characters go to the search box itself, so they aren't handled here.
export function pickerKey(
  state: PickerState,
  key: string,
  options: readonly PickerOption[],
): { state: PickerState; effect: PickerEffect; handled: boolean } {
  const same = (patch: Partial<PickerState>, effect: PickerEffect = { kind: "none" }) => ({
    state: { ...state, ...patch },
    effect,
    handled: true,
  });
  switch (key) {
    case "ArrowDown":
      return same({ active: state.active < 0 ? edge(options, "first") : step(options, state.active, 1) });
    case "ArrowUp":
      return same({ active: state.active < 0 ? edge(options, "last") : step(options, state.active, -1) });
    case "Home":
      return same({ active: edge(options, "first") });
    case "End":
      return same({ active: edge(options, "last") });
    case "PageDown": {
      let i = state.active;
      for (let n = 0; n < 8; n += 1) {
        const next = step(options, i, 1);
        if (next <= i) break;
        i = next;
      }
      return same({ active: i });
    }
    case "PageUp": {
      let i = state.active;
      for (let n = 0; n < 8; n += 1) {
        const next = step(options, i, -1);
        if (next < 0 || next >= i) break;
        i = next;
      }
      return same({ active: i });
    }
    case "Enter": {
      const option = options[state.active];
      if (!option || option.disabled) return same({});
      return same({}, { kind: "select", value: option.value });
    }
    case "Escape":
      // A first Escape clears a typed search; the next one closes.
      return state.query ? same({ query: "" }) : same({ open: false, query: "" }, { kind: "close" });
    case "Tab":
      return { state: { ...state, open: false, query: "" }, effect: { kind: "blur" }, handled: false };
    default:
      return { state, effect: { kind: "none" }, handled: false };
  }
}

// Type-ahead on the closed button: the next enabled option (after `from`) whose label starts with what
// was typed in the last second; a buffer of one repeated letter cycles through options with that letter.
export function typeAhead(options: readonly PickerOption[], buffer: string, from: number): number {
  const b = norm(buffer);
  if (!b) return from;
  const cycling = b.length > 1 && [...b].every((ch) => ch === b[0]);
  const prefix = cycling ? b[0] : b;
  const start = cycling || b.length === 1 ? from + 1 : Math.max(from, 0);
  for (let n = 0; n < options.length; n += 1) {
    const i = (start + n) % options.length;
    if (!options[i].disabled && norm(options[i].label).startsWith(prefix)) return i;
  }
  return from;
}

// Whether a key press is a printable character (starts a search or type-ahead).
export function isPrintableKey(key: string, modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}) {
  return key.length === 1 && !modifiers.ctrl && !modifiers.meta && !modifiers.alt && key !== " ";
}
