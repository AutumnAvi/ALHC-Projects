import { displayName } from "@/components/avatar";
import { OPTION_COLOR_CLASSES, fieldChips, type FieldDef } from "@/lib/fields";
import type { Profile, ProjectTask } from "@/lib/data";

export type FieldContext = {
  profilesById: Map<string, Profile>;
  sectionNames: Map<string, string>;
};

export function FieldValueChips({
  field,
  task,
  context,
  showName = false,
}: {
  field: FieldDef;
  task: ProjectTask;
  context: FieldContext;
  showName?: boolean;
}) {
  const chips = fieldChips(field, task.fieldValues[field.id], {
    personName: (id) => {
      const p = context.profilesById.get(id);
      return p ? displayName(p) : null;
    },
    sectionName: task.sectionId ? context.sectionNames.get(task.sectionId) : null,
  });
  if (chips.length === 0) return null;
  // Asana: choice values are colored pastel pills; text, numbers, dates, and people read as plain text.
  if (!isChoiceField(field)) {
    return (
      <span className="min-w-0 truncate text-xs text-zinc-700" data-field-value={field.name}>
        {showName ? <span className="sr-only">{field.name}: </span> : null}
        {chips.map((chip) => chip.label).join(", ")}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" data-field-value={field.name}>
      {showName ? <span className="sr-only">{field.name}: </span> : null}
      {chips.map((chip, i) => (
        <span key={`${chip.label}-${i}`} className={`${PILL} ${OPTION_COLOR_CLASSES[chip.color]}`}>
          {chip.label}
        </span>
      ))}
    </span>
  );
}

// A colored value pill (select options, the section-bound Status, a ticked checkbox).
export const PILL = "inline-block max-w-full truncate rounded-full px-2 py-px text-xs font-medium";

export function isChoiceField(field: Pick<FieldDef, "fieldType" | "boundToSections">) {
  return (
    field.boundToSections ||
    field.fieldType === "single_select" ||
    field.fieldType === "multi_select" ||
    field.fieldType === "boolean"
  );
}
