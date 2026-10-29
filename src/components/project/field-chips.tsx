import { displayName } from "@/components/avatar";
import { OPTION_COLOR_CLASSES, fieldChips, type FieldDef } from "@/lib/fields";
import type { Profile, ProjectTask } from "@/lib/data";
import { TEXT_TOOLTIP_LENGTH, textPreview } from "@/lib/long-text";

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
  // Asana: choice values are colored pastel pills; text, numbers, dates, and people read as plain text,
  // on one line — the whole value shows on hover when it's cut off (item 48: long text).
  if (!isChoiceField(field)) {
    const text = chips.map((chip) => chip.label).join(", ");
    return (
      <span
        className="min-w-0 truncate text-xs text-zinc-700"
        data-field-value={field.name}
        data-tooltip={textPreview(text, TEXT_TOOLTIP_LENGTH)}
        data-tooltip-truncated=""
      >
        {showName ? <span className="sr-only">{field.name}: </span> : null}
        {text}
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
