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

export const OPTION_COLORS = [
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

export type OptionColor = (typeof OPTION_COLORS)[number];

// Literal class names so Tailwind can see them.
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
};

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
  // Oct 29 notes, batch 7: set on this project's placement of a shared library field (the published
  // source field's id); null on the source and on project-only fields. Placements of one library field
  // share its definition and one value per task (see fieldGroupId).
  libraryFieldId?: string | null;
};

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

export function isFieldType(value: unknown): value is FieldType {
  return FIELD_TYPES.some((t) => t.value === value);
}

export function isOptionColor(value: unknown): value is OptionColor {
  return OPTION_COLORS.includes(value as OptionColor);
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
