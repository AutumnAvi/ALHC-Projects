// What a list row, card, or bar already knows about a task (Oct 19 notes: opening a task must feel
// instant). The pane draws these at once, read-only, while the full detail loads; nothing here is ever
// written back. Every field is optional except the id and the name.
import { rowCompleteMode, type CompleteMode } from "@/lib/approval-complete";
import type { MyTask, ProjectTask, SubtaskItem } from "@/lib/data";
import { fieldChips, type FieldDef, type OptionColor } from "@/lib/fields";
import type { RequestLabel } from "@/lib/request-numbers";
import type { Json } from "@/lib/supabase/database.types";
import type { TaskKind } from "@/lib/task-kinds";

export type TaskSeed = {
  id: string;
  title: string;
  requestLabel?: RequestLabel | null;
  completed?: boolean;
  kind?: TaskKind;
  assignee?: { id: string; name: string } | null;
  dueOn?: string | null;
  startOn?: string | null;
  tags?: { id: string; name: string; color: OptionColor }[];
  projectName?: string | null;
  sectionName?: string | null;
  // Pinned custom field values, as their chips read (e.g. "Priority: High").
  fields?: { id: string; name: string; value: string; color?: OptionColor | null }[];
  subtaskCount?: number;
  subtaskDoneCount?: number;
  commentCount?: number;
  // A subtask: its parent's name (the breadcrumb).
  parentTitle?: string | null;
  // false: the viewer can't edit it, so the preview draws no "Mark complete" (unknown = drawn).
  canEdit?: boolean;
  // What the complete button is for the viewer (Oct 29 notes, batch 7: an approval task's is "Ready for
  // approval" for everyone but its approvers). Missing = Mark complete.
  completeMode?: CompleteMode;
};

// Lookups a view already has (people, tags, fields, sections, the project's name).
export type SeedLookups = {
  personName?: (profileId: string) => string | null;
  tag?: (tagId: string) => { id: string; name: string; color: OptionColor } | undefined;
  projectName?: string | null;
  sectionName?: (sectionId: string | null) => string | null;
  // Fields pinned as List columns / card chips, with their chip for this task's value.
  fields?: FieldDef[];
  // The viewer's edit permission in the view's project (useProjectPermissions()).
  canEdit?: boolean;
};

function fieldSeeds(fieldValues: Record<string, Json>, lookups: SeedLookups, sectionName: string | null) {
  const out: NonNullable<TaskSeed["fields"]> = [];
  for (const field of lookups.fields ?? []) {
    const chips = fieldChips(field, fieldValues[field.id], {
      personName: lookups.personName ?? (() => null),
      sectionName,
    });
    if (chips.length === 0) continue;
    out.push({
      id: field.id,
      name: field.name,
      value: chips.map((c) => c.label).join(", "),
      color: chips.length === 1 && chips[0].color !== "zinc" ? chips[0].color : null,
    });
  }
  return out.slice(0, 5);
}

function assigneeSeed(assigneeId: string | null, lookups: SeedLookups): TaskSeed["assignee"] {
  if (!assigneeId) return null;
  const name = lookups.personName?.(assigneeId);
  return name ? { id: assigneeId, name } : undefined;
}

// A List row, Board card, Calendar or Timeline bar.
export function seedFromProjectTask(task: ProjectTask, lookups: SeedLookups = {}): TaskSeed {
  const sectionName = lookups.sectionName?.(task.sectionId) ?? null;
  return {
    id: task.id,
    title: task.title,
    requestLabel: task.requestLabel ?? null,
    completed: Boolean(task.completedAt),
    kind: task.kind,
    assignee: assigneeSeed(task.assigneeId, lookups),
    dueOn: task.dueOn,
    startOn: task.startOn,
    tags: lookups.tag ? task.tagIds.flatMap((id) => lookups.tag?.(id) ?? []) : undefined,
    projectName: lookups.projectName ?? undefined,
    sectionName,
    fields: fieldSeeds(task.fieldValues, lookups, sectionName),
    subtaskCount: task.subtaskCount,
    subtaskDoneCount: task.subtaskDoneCount,
    commentCount: task.commentCount,
    canEdit: lookups.canEdit,
    completeMode: rowCompleteMode(task),
  };
}

// A row of My tasks (or Home's My tasks widget): assigned to the viewer.
export function seedFromMyTask(task: MyTask, viewer?: { id: string; name: string }): TaskSeed {
  return {
    id: task.id,
    // My tasks' titles already carry the request number (listMyTasks), so it isn't drawn twice.
    title: task.title,
    requestLabel: null,
    completed: Boolean(task.completedAt),
    kind: task.kind,
    assignee: viewer ?? undefined,
    dueOn: task.dueOn,
    projectName: task.projectName ?? (task.projectId ? undefined : "Private"),
    parentTitle: task.parentTitle,
    canEdit: task.canEdit,
    completeMode: rowCompleteMode(task),
  };
}

// A subtask in the pane (or under a List row): its parent's projects are its own.
export function seedFromSubtask(
  subtask: SubtaskItem,
  parent: { title: string; projectName?: string | null },
  lookups: SeedLookups = {},
): TaskSeed {
  return {
    id: subtask.id,
    title: subtask.title,
    requestLabel: subtask.requestLabel ?? null,
    completed: Boolean(subtask.completedAt),
    kind: subtask.kind,
    assignee: assigneeSeed(subtask.assigneeId, lookups),
    dueOn: subtask.dueOn,
    startOn: subtask.startOn,
    projectName: parent.projectName ?? undefined,
    subtaskCount: subtask.subtaskCount,
    subtaskDoneCount: subtask.subtaskDoneCount,
    parentTitle: parent.title,
    canEdit: lookups.canEdit,
    completeMode: rowCompleteMode(subtask),
  };
}

// Anything that only knows the name (Inbox cards, search results, links in activity).
export function seedFromTitle(id: string, title: string, extra: Partial<TaskSeed> = {}): TaskSeed {
  return { ...extra, id, title };
}
