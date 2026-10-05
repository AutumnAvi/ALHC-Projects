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
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" data-field-value={field.name}>
      {showName ? <span className="sr-only">{field.name}: </span> : null}
      {chips.map((chip, i) => (
        <span
          key={`${chip.label}-${i}`}
          className={`max-w-full truncate rounded px-1.5 py-0.5 text-xs ${OPTION_COLOR_CLASSES[chip.color]}`}
        >
          {chip.label}
        </span>
      ))}
    </span>
  );
}
