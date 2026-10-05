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
};

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
