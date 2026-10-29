import type { Json } from "@/lib/supabase/database.types";

export const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Checkbox" },
  { value: "single_select", label: "Single-select" },
  { value: "multi_select", label: "Multi-select" },
  { value: "people", label: "People" },
] as const;

export type FieldType = (typeof FIELD_TYPES)[number]["value"];

// Oct 29 notes, item 54: one palette for every color people pick — project field options, portfolio
// field options, and tags (ColorPicker). The first nine are the original colors in their original order
// (new options cycle through OPTION_COLORS, so existing fields keep coloring the same way); the rest were
// added in batch 7. Mirrored by public.option_colors(); `tags.color` only accepts the first nine (its
// CHECK predates batch 7), so a tag keeps the picked color in `tags.palette_color` and the nearest of the
// nine in `color` (OPTION_BASE_COLOR, mirrored by public.option_color_base()). A stored color the app
// doesn't know reads as Gray.
export const BASE_OPTION_COLORS = [
  "zinc",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;

export const OPTION_COLORS = [
  ...BASE_OPTION_COLORS,
  "lime",
  "emerald",
  "cyan",
  "sky",
  "indigo",
  "purple",
  "fuchsia",
  "rose",
  "yellow",
  "slate",
  "stone",
] as const;

export type OptionColor = (typeof OPTION_COLORS)[number];
export type BaseOptionColor = (typeof BASE_OPTION_COLORS)[number];

// The color picker's grid: five columns in hue order, grays first.
export const OPTION_COLOR_GRID: readonly OptionColor[] = [
  "zinc",
  "slate",
  "stone",
  "red",
  "rose",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
];
export const OPTION_COLOR_GRID_COLUMNS = 5;

// Literal class names so Tailwind can see them. Chips are a light background with dark text of the same
// hue (100 + 800, or 200 + 900 where the 100 would look like a neighbor's: rose next to red, emerald
// next to green, indigo / purple next to blue / violet, yellow next to amber, sky next to blue, and the
// two extra grays next to Gray) — all well above 4.5:1.
export const OPTION_COLOR_CLASSES: Record<OptionColor, string> = {
  zinc: "bg-zinc-100 text-zinc-700",
  red: "bg-red-100 text-red-800",
  orange: "bg-orange-100 text-orange-800",
  amber: "bg-amber-100 text-amber-800",
  green: "bg-green-100 text-green-800",
  teal: "bg-teal-100 text-teal-800",
  blue: "bg-blue-100 text-blue-800",
  violet: "bg-violet-100 text-violet-800",
  pink: "bg-pink-100 text-pink-800",
  lime: "bg-lime-100 text-lime-800",
  emerald: "bg-emerald-200 text-emerald-900",
  cyan: "bg-cyan-100 text-cyan-800",
  sky: "bg-sky-200 text-sky-900",
  indigo: "bg-indigo-200 text-indigo-900",
  purple: "bg-purple-200 text-purple-900",
  fuchsia: "bg-fuchsia-100 text-fuchsia-800",
  rose: "bg-rose-200 text-rose-900",
  yellow: "bg-yellow-200 text-yellow-900",
  slate: "bg-slate-200 text-slate-800",
  stone: "bg-stone-200 text-stone-800",
};

// Names and solid swatches for color pickers (American spelling in the UI: "Color", "Gray").
export const OPTION_COLOR_LABELS: Record<OptionColor, string> = {
  zinc: "Gray",
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
  lime: "Lime",
  emerald: "Emerald",
  cyan: "Cyan",
  sky: "Sky",
  indigo: "Indigo",
  purple: "Purple",
  fuchsia: "Fuchsia",
  rose: "Rose",
  yellow: "Yellow",
  slate: "Slate",
  stone: "Stone",
};

// Swatch shades are picked so neighbors in the grid stay apart (rose lighter than red, yellow lighter
// than amber, emerald / indigo / purple deeper than green / blue / violet).
export const OPTION_SWATCH_CLASSES: Record<OptionColor, string> = {
  zinc: "bg-zinc-400",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-400",
  green: "bg-green-500",
  teal: "bg-teal-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
  lime: "bg-lime-500",
  emerald: "bg-emerald-600",
  cyan: "bg-cyan-400",
  sky: "bg-sky-500",
  indigo: "bg-indigo-600",
  purple: "bg-purple-600",
  fuchsia: "bg-fuchsia-500",
  rose: "bg-rose-400",
  yellow: "bg-yellow-300",
  slate: "bg-slate-500",
  stone: "bg-stone-500",
};

// The nearest of the first nine colors (closest in OKLab at the 500 shades), stored in `tags.color` for
// readers that don't know `tags.palette_color`. Mirrors public.option_color_base().
export const OPTION_BASE_COLOR: Record<OptionColor, BaseOptionColor> = {
  zinc: "zinc",
  red: "red",
  orange: "orange",
  amber: "amber",
  green: "green",
  teal: "teal",
  blue: "blue",
  violet: "violet",
  pink: "pink",
  lime: "green",
  emerald: "teal",
  cyan: "teal",
  sky: "blue",
  indigo: "violet",
  purple: "violet",
  fuchsia: "pink",
  rose: "red",
  yellow: "amber",
  slate: "zinc",
  stone: "zinc",
};

export type FieldOption = { id: string; name: string; color: OptionColor };

export type FieldDef = {
  id: string;
  projectId: string;
  name: string;
  fieldType: FieldType;
  options: FieldOption[];
  boundToSections: boolean;
  showInViews: boolean;
  sortOrder: number;
  // Asana parity, batch 4 (empty / false on a database without 20261011040000_asana_parity_4.sql).
  description: string | null;
  // Followers get an Inbox notification when a value changes.
  notifyOnChange: boolean;
  // Listed in the workspace field library (name, type, description, and options only).
  inLibrary: boolean;
  // Oct 29 notes, item 49: a number field's symbol ("$", "€", "#"), shown before its values; null /
  // absent = none (and on a database without 20261029010000_oct29_batch7_a.sql).
  numberPrefix?: string | null;
  // Oct 29 notes, batch 7: set on this project's placement of a shared library field (the published
  // source field's id); null on the source and on project-only fields. Placements of one library field
  // share its definition and one value per task (see fieldGroupId).
  libraryFieldId?: string | null;
  // Oct 29 notes, batch 7 (51): locked — its values, definition, and removal are for the project's
  // Owners and Admins (fieldValueEditable; a shared field's value: of every project of the task that uses
  // it, lockedValueEditableAcross). Shared across a library group like the rest of the definition. Who
  // locked it and when (absent on a database without the update).
  locked?: boolean;
  lockedBy?: string | null;
  lockedAt?: string | null;
};

// 51. Field lock. Everyone who can't change a locked field sees this (the lock icon's tooltip, the
// database's refusal, bulk Field's skip reason).
export const LOCKED_FIELD_NOTE = "Locked — only project Owners and Admins can change this field";

// What the viewer may do in the field's project (permissionsFor(role)).
type FieldPerms = { canEdit: boolean; canManage: boolean };

// Whether the viewer may change this field's values in its project: Editors+, and only Owners and Admins
// while it's locked (task_field_values_02_field_lock decides).
export function fieldValueEditable(field: Pick<FieldDef, "locked">, perms: FieldPerms): boolean {
  return perms.canEdit && (!field.locked || perms.canManage);
}

// A locked field the viewer can't change: drawn read-only with the lock and LOCKED_FIELD_NOTE.
export function fieldLockedFor(field: Pick<FieldDef, "locked">, perms: Pick<FieldPerms, "canManage">): boolean {
  return Boolean(field.locked) && !perms.canManage;
}

// A locked shared library field holds one value in every project of the task that uses it, so only
// someone who is an Owner or Admin of each of those projects changes it (the database decides:
// locked_field_value_writable). Said by the database's refusal, bulk Field's skip reason, and the pane.
export const LOCKED_SHARED_VALUE_NOTE =
  "Locked — only Owners and Admins of every project this task is in can change this shared field";

// The task pane's rule for a locked field's value on one task (it knows the task's projects and the
// viewer's role in each): Owner / Admin of the field's project and — for a shared library field — of every
// other project of the task that has the same field (taskFields: the fields of the task's projects).
// Projects the viewer can't open aren't in taskFields; the database refuses those writes with
// LOCKED_SHARED_VALUE_NOTE.
export function lockedValueEditableAcross(
  field: Pick<FieldDef, "id" | "projectId" | "libraryFieldId" | "locked">,
  taskFields: Pick<FieldDef, "id" | "projectId" | "libraryFieldId">[],
  canManageIn: (projectId: string) => boolean,
): boolean {
  if (!field.locked) return true;
  if (!canManageIn(field.projectId)) return false;
  const group = fieldGroupId(field);
  return taskFields.every((other) => fieldGroupId(other) !== group || canManageIn(other.projectId));
}

// Edit field's note on a locked field whose definition the viewer can't change: a shared field's
// definition and lock belong to the project that published it (this project's Owners and Admins still
// change its values here), else to this project's Owners and Admins.
export function lockedFieldNote(field: Pick<FieldDef, "libraryFieldId">): string {
  return field.libraryFieldId
    ? "Locked — only Owners and Admins of the project that published this shared field can change its name, description, and options"
    : LOCKED_FIELD_NOTE;
}

// Whether the viewer may lock or unlock the field: Owners / Admins of the project whose Editors change
// its definition (a shared field's publishing project — project_field_sharing.definitionManageable —
// else this one). The section-bound Status is never locked.
export function fieldLockManageable(
  field: Pick<FieldDef, "boundToSections">,
  sharing: FieldSharing | null | undefined,
  perms: Pick<FieldPerms, "canManage">,
): boolean {
  if (field.boundToSections) return false;
  return sharing ? sharing.definitionManageable : perms.canManage;
}

// Edit field → "Lock field": the switch's one line, and why it's greyed out for everyone else.
export const LOCK_FIELD_HINT =
  "Only project Owners and Admins can change its values, name, and options, or remove it. Rules change it only when their owner is an Owner or Admin.";
export function lockFieldUnavailable(field: Pick<FieldDef, "libraryFieldId">): string {
  return field.libraryFieldId
    ? "Only Owners and Admins of the project that published this shared field can lock or unlock it."
    : "Only project Owners and Admins can lock or unlock a field.";
}

// Where a locked field is set without a person: a rule's Set field step, and a form's "Fills in".
export const RULE_LOCKED_FIELD_NOTE =
  "This field is locked. The step runs only while the rule’s owner is an Owner or Admin of this project (for a shared library field, also of the task’s other projects that use it); otherwise it’s skipped (and the run log says so).";
export const FORM_LOCKED_FIELD_NOTE =
  "This field is locked. Form answers still fill it in; only project Owners and Admins change it afterwards.";

// The library group a field belongs to: placements of a shared library field have their source's id,
// every other field its own. Two fields of one group are the same field in different projects.
export function fieldGroupId(field: Pick<FieldDef, "id" | "libraryFieldId">): string {
  return field.libraryFieldId ?? field.id;
}

// Whether a project already uses a library field (as its source or a placement of it).
export function projectHasLibraryField(fields: Pick<FieldDef, "id" | "libraryFieldId">[], libraryFieldId: string): boolean {
  return fields.some((f) => fieldGroupId(f) === libraryFieldId);
}

// project_field_sharing (Oct 29 notes, batch 7): which of a project's fields are shared with other
// projects and whether the viewer may change the shared definition. Booleans and counts only — never
// another project's name.
export type FieldSharing = {
  fieldId: string;
  // The source field's id on a placement; null on the source and on project-only fields.
  libraryFieldId: string | null;
  // Published from this project (in the library, or used by other projects).
  isSource: boolean;
  // Linked to other projects (a placement, or a source other projects use).
  isShared: boolean;
  // Live fields of the group in live projects (1 = only this one).
  placementCount: number;
  // Name, description, type, options, notify: Editor+ of the project that published it (else this one).
  definitionEditable: boolean;
  // Owner / Admin of that project.
  definitionManageable: boolean;
};

export const SHARED_FIELD_READ_ONLY =
  "Shared from the field library. Only editors of the project that published it can change its name, description, and options.";

export const SHARED_FIELD_EDITABLE =
  "Shared through the field library. Changes to its name, description, and options apply in every project that uses it.";

// How a field reads in this project's field settings (the Fields list, Customize → Fields, Edit field).
export type SharedFieldView = {
  // Linked to other projects: a placement, or a source other projects use (the "Shared" marker).
  shared: boolean;
  // This project's placement of another project's library field (never listed in the library itself).
  placement: boolean;
  // Name, description, options, and notifications can't be changed from here (SHARED_FIELD_READ_ONLY);
  // the per-project settings (Show in List and Board) still can.
  definitionReadOnly: boolean;
  // Other projects using it; null when unknown (no sharing data yet).
  otherProjects: number | null;
};

export function sharedFieldView(
  field: Pick<FieldDef, "id" | "libraryFieldId">,
  sharing: FieldSharing | null | undefined,
): SharedFieldView {
  const placement = Boolean(field.libraryFieldId ?? sharing?.libraryFieldId);
  const shared = sharing ? sharing.isShared || placement : placement;
  return {
    shared,
    placement,
    // Without sharing data the database still decides (its refusal says SHARED_FIELD_READ_ONLY).
    definitionReadOnly: Boolean(sharing && shared && !sharing.definitionEditable),
    otherProjects: sharing && shared ? Math.max(sharing.placementCount - 1, 0) : null,
  };
}

// The "Shared" marker's tooltip. Counts only — never another project's name.
export function sharedFieldTooltip(view: SharedFieldView): string | null {
  if (!view.shared) return null;
  const n = view.otherProjects;
  return n ? `Shared through the field library with ${n} other project${n === 1 ? "" : "s"}` : "Shared through the field library";
}

// The note at the top of Edit field for a shared field.
export function sharedFieldNote(view: SharedFieldView): string | null {
  if (!view.shared) return null;
  return view.definitionReadOnly ? SHARED_FIELD_READ_ONLY : SHARED_FIELD_EDITABLE;
}

// Edit field → delete. A shared field's other projects keep it, so it only leaves this project.
export function removeFieldWording(name: string, view: SharedFieldView) {
  return view.shared
    ? {
        button: "Remove from this project",
        title: `Remove “${name}” from this project?`,
        message:
          "This only removes the field from this project. Other projects that use this shared field keep it and their values. Values here are kept in the database.",
        confirmLabel: "Remove",
      }
    : {
        button: "Delete field",
        title: `Delete the “${name}” field?`,
        message: "Existing values are kept in the database.",
        confirmLabel: "Delete",
      };
}

// A field from the workspace library (list_field_library): a definition other projects can copy.
export type LibraryField = {
  fieldId: string;
  name: string;
  fieldType: FieldType;
  description: string | null;
  options: FieldOption[];
};

// Add field → Choose from library: the library fields this project doesn't use yet (by group, so a
// field it already has — as the source or a placement — isn't offered again), then a search by name or
// description.
export function libraryChoices(
  library: LibraryField[],
  projectFields: Pick<FieldDef, "id" | "libraryFieldId">[],
): LibraryField[] {
  return library.filter((f) => !projectHasLibraryField(projectFields, f.fieldId));
}

export function searchLibrary(choices: LibraryField[], query: string): LibraryField[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return choices;
  return choices.filter(
    (f) => f.name.toLowerCase().includes(needle) || (f.description ?? "").toLowerCase().includes(needle),
  );
}

// The task pane lists each of the task's projects' fields. A shared library field in several of them
// is one field with one value, so it shows once (in its first project) — unless its values there
// differ (two copies linked by the batch 7 migration that disagreed: both are kept, so both show).
// `prefer` (lower first) picks which placement stays when several hold the same value — e.g. one in a
// project where the viewer may change it (51: a locked field only by the project's Owners and Admins).
export function repeatedSharedFieldIds<F extends Pick<FieldDef, "id" | "libraryFieldId">>(
  fields: F[],
  values: Record<string, Json | undefined>,
  prefer?: (field: F) => number,
): Set<string> {
  const shown = new Map<string, string[]>();
  const repeated = new Set<string>();
  // A stable sort: without a preference (or on a tie), the first project's field stays.
  const ordered = prefer ? [...fields].sort((a, b) => prefer(a) - prefer(b)) : fields;
  for (const field of ordered) {
    const group = fieldGroupId(field);
    const value = JSON.stringify(values[field.id] ?? null);
    const seen = shown.get(group);
    if (seen?.includes(value)) repeated.add(field.id);
    else shown.set(group, [...(seen ?? []), value]);
  }
  return repeated;
}

export const MAX_FIELD_DESCRIPTION = 2000;

// Oct 29 notes, item 49: a number field's symbol (custom_fields.number_prefix, portfolio_fields'
// too). Mirrors the CHECKs and public.normalize_number_prefix(): number fields only, surrounding spaces
// trimmed (empty = none), 1–4 characters counted as code points, no line breaks, control characters, or
// invisible formatting characters, and no digits or plus / minus signs (a symbol must never read as part
// of the number: "1" before 250 would read "1250", "-" before 40 would read "-40").
export const MAX_NUMBER_PREFIX = 4;
export const NUMBER_PREFIX_EXAMPLES = ["$", "€", "£", "#", "₪"] as const;

// The character sets, written once as code point ranges. The migration's regular expressions
// (normalize_number_prefix() and the number_prefix CHECKs) are these same lists written by
// codeRangeClass(…, "sql"); the unit test checks that both sides stay identical.
export type CodeRange = readonly [number, number];
// What surrounds a symbol and is trimmed: exactly what JavaScript's String.prototype.trim() removes
// (tab, line feed, vertical tab, form feed, carriage return, the Unicode spaces, the line and paragraph
// separators, and the byte order mark).
export const NUMBER_PREFIX_SPACE: readonly CodeRange[] = [
  [0x0009, 0x000d],
  [0x0020, 0x0020],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
// Never inside a symbol: control characters (C0, DEL, C1), the line and paragraph separators, and every
// Unicode format character (category Cf: bidi overrides and isolates, zero-width spaces and joiners, the
// soft hyphen, the byte order mark, …), which reorder or hide what's around them (a right-to-left
// override before 1,250 makes it read "052,1").
export const NUMBER_PREFIX_INVISIBLE: readonly CodeRange[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x0600, 0x0605],
  [0x061c, 0x061c],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
];
// Never inside a symbol: digits (ASCII, Arabic-Indic, extended Arabic-Indic, full-width) and plus /
// minus signs and dashes, which would read as part of the number. The hyphen-minus comes first: Postgres
// reads it as a range's "-" anywhere else in a bracket expression, even written as an escape.
export const NUMBER_PREFIX_NUMERIC: readonly CodeRange[] = [
  [0x002d, 0x002d],
  [0x002b, 0x002b],
  [0x0030, 0x0039],
  [0x00b1, 0x00b1],
  [0x0660, 0x0669],
  [0x06f0, 0x06f9],
  [0x2010, 0x2015],
  [0x207a, 0x207b],
  [0x208a, 0x208b],
  [0x2212, 0x2213],
  [0xfe62, 0xfe63],
  [0xff0b, 0xff0b],
  [0xff0d, 0xff0d],
  [0xff10, 0xff19],
];

// A bracket expression's inside for the ranges ("\u0009-\u000d\u0020…"). JavaScript (with the u flag)
// writes a code point above U+FFFF as \u{…}, Postgres's regular expressions as \U followed by 8 digits.
export function codeRangeClass(ranges: readonly CodeRange[], flavor: "js" | "sql"): string {
  if (ranges.some(([from, to], index) => index > 0 && (from === 0x2d || to === 0x2d))) {
    throw new Error("A hyphen-minus can only start a bracket expression");
  }
  const one = (cp: number) =>
    cp <= 0xffff
      ? `\\u${cp.toString(16).padStart(4, "0")}`
      : flavor === "js"
        ? `\\u{${cp.toString(16)}}`
        : `\\U${cp.toString(16).padStart(8, "0")}`;
  return ranges.map(([from, to]) => (from === to ? one(from) : `${one(from)}-${one(to)}`)).join("");
}

const PREFIX_SPACE_CLASS = codeRangeClass(NUMBER_PREFIX_SPACE, "js");
const PREFIX_EDGE_SPACE = new RegExp(`^[${PREFIX_SPACE_CLASS}]+|[${PREFIX_SPACE_CLASS}]+$`, "gu");
const PREFIX_INVISIBLE = new RegExp(`[${codeRangeClass(NUMBER_PREFIX_INVISIBLE, "js")}]`, "u");
const PREFIX_NUMERIC = new RegExp(`[${codeRangeClass(NUMBER_PREFIX_NUMERIC, "js")}]`, "u");

export const NUMBER_PREFIX_INVISIBLE_PROBLEM = "A symbol can’t contain line breaks, control characters, or invisible characters";
export const NUMBER_PREFIX_NUMERIC_PROBLEM = "A symbol can’t contain digits or + / − signs (they’d read as part of the number)";

// The symbol as it will be stored: trimmed, or null when there is none.
export function normalizeNumberPrefix(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").replace(PREFIX_EDGE_SPACE, "");
  return trimmed === "" ? null : trimmed;
}

// Why a typed symbol can't be saved, or null.
export function numberPrefixProblem(raw: string | null | undefined): string | null {
  const prefix = normalizeNumberPrefix(raw);
  if (prefix === null) return null;
  if (PREFIX_INVISIBLE.test(prefix)) return NUMBER_PREFIX_INVISIBLE_PROBLEM;
  if (PREFIX_NUMERIC.test(prefix)) return NUMBER_PREFIX_NUMERIC_PROBLEM;
  if ([...prefix].length > MAX_NUMBER_PREFIX) return `A symbol is ${MAX_NUMBER_PREFIX} characters at most`;
  return null;
}

// "1,250" with its symbol: "$1,250", "-$40" (the sign first), "USD 1,000" and "Rs. 1,000" (a space after
// a symbol that ends in a letter, a period, or a comma, so a symbol ending in "." never makes 250 read as
// a decimal). Mirrors public.format_number_value()'s placement of the symbol.
export function prefixNumberText(text: string, prefix: string | null | undefined): string {
  const symbol = normalizeNumberPrefix(prefix);
  if (!symbol) return text;
  const spaced = /[A-Za-z.,]$/.test(symbol) ? `${symbol} ` : symbol;
  return text.startsWith("-") ? `-${spaced}${text.slice(1)}` : `${spaced}${text}`;
}

// What a number box holds when it loses focus: an <input type="number"> reports "" both when it was
// emptied and when its text isn't a number (validity.badInput: "1-2", or "$100" typed or pasted where the
// browser takes any text). Only an emptied box clears the value; text that isn't a number keeps the saved
// value (the box puts it back and says why: notANumberNote).
export type NumberBoxEntry = { kind: "keep" } | { kind: "clear" } | { kind: "set"; value: number };
export function readNumberBox(raw: string, badInput: boolean): NumberBoxEntry {
  if (badInput) return { kind: "keep" };
  const text = raw.trim();
  if (text === "") return { kind: "clear" };
  const value = Number(text);
  return Number.isFinite(value) ? { kind: "set", value } : { kind: "keep" };
}

// Said when a number box's text wasn't a number and the saved value was kept.
export function notANumberNote(fieldName: string, symbol?: string | null): string {
  const sign = normalizeNumberPrefix(symbol);
  return `${fieldName} wasn’t changed: type a number${sign ? ` (the ${sign} is added for you)` : ""}.`;
}

// The one way a number value reads in the app: grouped with commas, at most three decimals, and the
// field's symbol before it ("$1,250.5"). Mirrors public.format_number_value() (task_field_text, rule
// logs, the Inbox, emails). A value that rounds to zero has no sign.
export function formatNumberValue(value: number, prefix?: string | null): string {
  const digits = Math.abs(value).toLocaleString("en-US");
  return prefixNumberText(value < 0 && /[1-9]/.test(digits) ? `-${digits}` : digits, prefix);
}

// A field's symbol when it has one (number fields only; the section-bound Status never does).
export function numberPrefixOf(field: { fieldType: string; boundToSections?: boolean; numberPrefix?: string | null }) {
  return field.fieldType === "number" && !field.boundToSections ? normalizeNumberPrefix(field.numberPrefix) : null;
}

// A column / measure name with the symbol: "Budget ($)" (CSV headers keep the numbers raw so
// spreadsheets can add them up; the workload measure picker).
export function fieldNameWithSymbol(field: { name: string; fieldType: string; boundToSections?: boolean; numberPrefix?: string | null }) {
  const symbol = numberPrefixOf(field);
  return symbol ? `${field.name} (${symbol})` : field.name;
}

// Field types with options (the section-bound Status's options are the sections, not stored here).
export function hasOptions(field: Pick<FieldDef, "fieldType" | "boundToSections">) {
  return !field.boundToSections && (field.fieldType === "single_select" || field.fieldType === "multi_select");
}

// Oct 29 notes, item 47: a single- or multi-select field (not the section-bound Status) needs at
// least one option — the editors and the actions refuse creating or saving one without; the database
// (`guard_select_field_options`) refuses emptying one (creating is checked there once the release
// before this one, whose Add field can create one, is gone).
export const SELECT_NEEDS_OPTION = "Add at least one option";

// Why a select field can't be saved as drafted, or null. `optionCount` = the options in the list,
// `pendingOption` = a name typed in the "Add an option" box but not added yet (it's added on save, so it
// counts). `previousCount` = how many options the saved field has (null / absent while creating): a
// field that never had any (older data, the Creative Requests template) can still be renamed — it just
// can't be emptied, mirroring the database guard. Portfolio fields pass no `boundToSections`.
export function selectOptionsProblem(input: {
  fieldType: string;
  boundToSections?: boolean;
  optionCount: number;
  pendingOption?: string;
  previousCount?: number | null;
}): string | null {
  const select = input.fieldType === "single_select" || input.fieldType === "multi_select";
  if (!select || input.boundToSections) return null;
  if (input.optionCount > 0 || (input.pendingOption ?? "").trim()) return null;
  if (input.previousCount === 0) return null;
  return SELECT_NEEDS_OPTION;
}

export function isFieldType(value: unknown): value is FieldType {
  return FIELD_TYPES.some((t) => t.value === value);
}

export function isOptionColor(value: unknown): value is OptionColor {
  return OPTION_COLORS.includes(value as OptionColor);
}

export function isBaseOptionColor(value: unknown): value is BaseOptionColor {
  return BASE_OPTION_COLORS.includes(value as BaseOptionColor);
}

export function fieldTypeLabel(field: Pick<FieldDef, "fieldType" | "boundToSections">) {
  if (field.boundToSections) return "Section-bound";
  return FIELD_TYPES.find((t) => t.value === field.fieldType)?.label ?? field.fieldType;
}

export function parseOptions(value: Json): FieldOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const { id, name, color } = item as Record<string, Json | undefined>;
    if (typeof id !== "string" || typeof name !== "string") return [];
    return [{ id, name, color: isOptionColor(color) ? color : "zinc" }];
  });
}

export type FieldChip = { label: string; color: OptionColor };

// Read-only rendering shared by list columns, board chips, and activity stories.
export function fieldChips(
  field: FieldDef,
  value: Json | undefined,
  context: { personName: (id: string) => string | null; sectionName?: string | null },
): FieldChip[] {
  if (field.boundToSections) {
    return context.sectionName ? [{ label: context.sectionName, color: "zinc" }] : [];
  }
  if (value === null || value === undefined) return [];
  switch (field.fieldType) {
    case "text":
      return typeof value === "string" && value ? [{ label: value, color: "zinc" }] : [];
    case "number":
      return typeof value === "number" ? [{ label: formatNumberValue(value, field.numberPrefix), color: "zinc" }] : [];
    case "date":
      return typeof value === "string" ? [{ label: value, color: "zinc" }] : [];
    case "boolean":
      return value === true ? [{ label: "Yes", color: "green" }] : [];
    case "single_select": {
      const option = field.options.find((o) => o.id === value);
      return option ? [{ label: option.name, color: option.color }] : [];
    }
    case "multi_select":
      return Array.isArray(value)
        ? field.options
            .filter((o) => value.includes(o.id))
            .map((o) => ({ label: o.name, color: o.color }))
        : [];
    case "people":
      return Array.isArray(value)
        ? value.flatMap((id) => {
            const name = typeof id === "string" ? context.personName(id) : null;
            return name ? [{ label: name, color: "zinc" as const }] : [];
          })
        : [];
  }
}
