"use client";

import { useMemo } from "react";
import { displayName } from "@/components/avatar";
import { useProjectPermissions } from "@/components/project/project-access";
import type { Profile, ProjectTask, Section, SubtaskItem } from "@/lib/data";
import type { FieldDef } from "@/lib/fields";
import type { Tag } from "@/lib/tags";
import { seedFromProjectTask, seedFromSubtask, type SeedLookups, type TaskSeed } from "@/lib/task-seed";

// What a project view already has, turned into a seed builder for the task pane (Oct 19 notes: the pane
// draws a clicked row at once from these). Built once per render of the view's data, not per row.
export function useProjectTaskSeeds({
  profiles,
  tags = [],
  sections = [],
  fields = [],
  projectName,
}: {
  profiles: Profile[];
  tags?: Tag[];
  sections?: Pick<Section, "id" | "name">[];
  fields?: FieldDef[];
  projectName?: string | null;
}) {
  const { canEdit } = useProjectPermissions();
  return useMemo(() => {
    const people = new Map(profiles.map((p) => [p.id, displayName(p)]));
    const tagMap = new Map(tags.map((t) => [t.id, { id: t.id, name: t.name, color: t.color }]));
    const sectionMap = new Map(sections.map((s) => [s.id, s.name]));
    const lookups: SeedLookups = {
      personName: (id) => people.get(id) ?? null,
      tag: (id) => tagMap.get(id),
      projectName: projectName ?? null,
      sectionName: (id) => (id ? (sectionMap.get(id) ?? null) : "No section"),
      fields: fields.filter((f) => f.showInViews),
      canEdit,
    };
    return {
      task: (task: ProjectTask): TaskSeed => seedFromProjectTask(task, lookups),
      subtask: (subtask: SubtaskItem, parentTitle: string): TaskSeed =>
        seedFromSubtask(subtask, { title: parentTitle, projectName }, lookups),
    };
  }, [profiles, tags, sections, fields, projectName, canEdit]);
}
