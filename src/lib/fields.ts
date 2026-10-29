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
};

// A field from the workspace library (list_field_library): a definition other projects can copy.
export type LibraryField = {
  fieldId: string;
  name: string;
  fieldType: FieldType;
  description: string | null;
  options: FieldOption[];
};

export const MAX_FIELD_DESCRIPTION = 2000;

// Field types with options (the section-bound Status's options are the sections, not stored here).
export function hasOptions(field: Pick<FieldDef, "fieldType" | "boundToSections">) {
  return !field.boundToSections && (field.fieldType === "single_select" || field.fieldType === "multi_select");
}

// Oct 29 notes, item 47: a single- or multi-select field (not the section-bound Status) needs at
// least one option — the editors, the actions, and the database (`guard_select_field_options`) agree.
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
      return typeof value === "number" ? [{ label: value.toLocaleString("en-US"), color: "zinc" }] : [];
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
