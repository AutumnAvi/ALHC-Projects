import { displayName } from "@/components/avatar";
import type { OptionColor, FieldDef } from "@/lib/fields";
import type { Profile, ProjectTask, Section } from "@/lib/data";
import { groupOf, refFieldId, sortOf, type ViewConfig, type ViewSort } from "@/lib/views";

// A column (Board) or group (List). `target` says what moving a task into the group changes.
export type TaskGroup = {
  key: string;
  label: string;
  color?: OptionColor;
  section?: Section;
  target:
    | { kind: "section"; sectionId: string | null }
    | { kind: "assignee"; assigneeId: string | null }
    | { kind: "field"; fieldId: string; optionId: string | null }
    | { kind: "none" };
  tasks: ProjectTask[];
};

type Context = {
  sections: Section[];
  profilesById: Map<string, Profile>;
  fields: FieldDef[];
};

function compareValues(a: string | number | null, b: string | number | null) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
}

function sortValue(task: ProjectTask, sort: ViewSort, context: Context): string | number | null {
  switch (sort.key) {
    case "manual":
      return task.sortOrder;
    case "due":
      return task.dueOn;
    case "title":
      return task.title;
    case "created":
      return task.createdAt;
    case "assignee": {
      const profile = task.assigneeId ? context.profilesById.get(task.assigneeId) : undefined;
      return profile ? displayName(profile) : null;
    }
  }
  const field = context.fields.find((f) => f.id === refFieldId(sort.key));
  const value = field ? task.fieldValues[field.id] : undefined;
  if (!field || value === undefined || value === null) return null;
  if (field.fieldType === "single_select") {
    const index = field.options.findIndex((o) => o.id === value);
    return index === -1 ? null : index;
  }
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 0 : null;
  if (Array.isArray(value)) return value.length ? String(value[0]) : null;
  return null;
}

export function sortTasks(tasks: ProjectTask[], config: ViewConfig, context: Context): ProjectTask[] {
  const sorts = sortOf(config);
  return [...tasks].sort((a, b) => {
    for (const sort of sorts) {
      // Empty values sort last in both directions.
      const va = sortValue(a, sort, context);
      const vb = sortValue(b, sort, context);
      if (va === null || vb === null) {
        const diff = compareValues(va, vb);
        if (diff) return diff;
        continue;
      }
      const diff = compareValues(va, vb);
      if (diff) return sort.dir === "asc" ? diff : -diff;
    }
    return a.sortOrder - b.sortOrder;
  });
}

// Groups already-filtered tasks. `sectionFilter` hides sections excluded by the view's filter so a
// "Section is A" view doesn't render empty B/C groups.
export function groupTasks(
  tasks: ProjectTask[],
  config: ViewConfig,
  context: Context,
): TaskGroup[] {
  const sorted = sortTasks(tasks, config, context);
  const groupBy = groupOf(config);
  const sectionFilter = config.filters?.sections;

  if (groupBy === "none") {
    return [{ key: "all", label: "All tasks", target: { kind: "none" }, tasks: sorted }];
  }

  if (groupBy === "assignee") {
    const byAssignee = new Map<string | null, ProjectTask[]>();
    for (const task of sorted) {
      const list = byAssignee.get(task.assigneeId) ?? [];
      list.push(task);
      byAssignee.set(task.assigneeId, list);
    }
    const people = [...byAssignee.keys()]
      .filter((k): k is string => k !== null)
      .map((assigneeId) => ({ assigneeId, profile: context.profilesById.get(assigneeId) }))
      .sort((a, b) =>
        (a.profile ? displayName(a.profile) : "").localeCompare(b.profile ? displayName(b.profile) : ""),
      );
    return [
      ...people.map(({ assigneeId, profile }) => ({
        key: `assignee-${assigneeId}`,
        label: profile ? displayName(profile) : "Former member",
        target: { kind: "assignee" as const, assigneeId },
        tasks: byAssignee.get(assigneeId) ?? [],
      })),
      {
        key: "assignee-none",
        label: "Unassigned",
        target: { kind: "assignee" as const, assigneeId: null },
        tasks: byAssignee.get(null) ?? [],
      },
    ];
  }

  const field = groupBy.startsWith("field:")
    ? context.fields.find((f) => f.id === refFieldId(groupBy) && f.fieldType === "single_select")
    : undefined;
  if (field && !field.boundToSections) {
    const byOption = new Map<string | null, ProjectTask[]>();
    for (const task of sorted) {
      const value = task.fieldValues[field.id];
      const optionId = typeof value === "string" && field.options.some((o) => o.id === value) ? value : null;
      const list = byOption.get(optionId) ?? [];
      list.push(task);
      byOption.set(optionId, list);
    }
    return [
      ...field.options.map((option) => ({
        key: `option-${option.id}`,
        label: option.name,
        color: option.color,
        target: { kind: "field" as const, fieldId: field.id, optionId: option.id },
        tasks: byOption.get(option.id) ?? [],
      })),
      {
        key: "option-none",
        label: `No ${field.name}`,
        target: { kind: "field" as const, fieldId: field.id, optionId: null },
        tasks: byOption.get(null) ?? [],
      },
    ];
  }

  const bySection = new Map<string | null, ProjectTask[]>();
  for (const task of sorted) {
    const list = bySection.get(task.sectionId) ?? [];
    list.push(task);
    bySection.set(task.sectionId, list);
  }
  const visible = (sectionId: string | null) => !sectionFilter || sectionFilter.includes(sectionId);
  const unsectioned = bySection.get(null) ?? [];
  return [
    ...(visible(null) && (unsectioned.length > 0 || context.sections.length === 0 || sectionFilter?.includes(null))
      ? [
          {
            key: "section-none",
            label: "No section",
            target: { kind: "section" as const, sectionId: null },
            tasks: unsectioned,
          },
        ]
      : []),
    ...context.sections
      .filter((s) => visible(s.id))
      .map((section) => ({
        key: `section-${section.id}`,
        label: section.name,
        section,
        target: { kind: "section" as const, sectionId: section.id },
        tasks: bySection.get(section.id) ?? [],
      })),
  ];
}
