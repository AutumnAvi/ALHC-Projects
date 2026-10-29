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
  // Oct 29 notes, batch 7 (51): locked — its values, definition, and removal are for the project's
  // Owners and Admins (fieldValueEditable). Shared across a library group like the rest of the
  // definition. Who locked it and when (absent on a database without the update).
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
  "This field is locked. The step runs only while the rule’s owner is an Owner or Admin of this project; otherwise it’s skipped (and the run log says so).";
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
