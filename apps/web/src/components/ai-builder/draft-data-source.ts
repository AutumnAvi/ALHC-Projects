"use client";

// AI builder round 2 (note 168): the in-memory data source the real List and Board draw a draft with.
// Every write the views make (rename, move, assign, dates, values, sections, add a task) becomes one of
// the draft's reducers (@alhc/core/ai-builder-draft) and answers like the Server Action it stands in for —
// an error when the edit breaks a rule — so the views' own optimistic updates and toasts work unchanged.
// Nothing here talks to the server; Create sends the draft as a proposal.
import { useLayoutEffect, useMemo, useRef } from "react";
import type { ActionResult } from "@alhc/core/api/core/result";
import {
  PLACEHOLDER_PREFIX,
  addSection,
  addTask,
  deleteSection,
  findSubtaskParent,
  moveSection,
  placeTask,
  renameSection,
  renameSubtask,
  setTaskDates,
  setTaskValue,
  updateTask,
  type AiDraft,
  type DraftEdit,
  type NewId,
  type TaskPatch,
} from "@alhc/core/ai-builder-draft";
import type { AiAssignee } from "@alhc/core/ai-builder";
import type { DraftHooks, ProjectDataSource } from "@/components/project/project-data-source";

export const DRAFT_COMPLETE_NOTE = "Starter tasks are created open";

export function newDraftId(): string {
  return crypto.randomUUID();
}

// The draft as a ref the views' async writes read and change, plus the state that draws it.
export function useDraftSource(opts: {
  draft: AiDraft;
  setDraft: (draft: AiDraft) => void;
  today: string;
  hooks: Omit<DraftHooks, "changeDates" | "moveSection">;
  newId?: NewId;
}): ProjectDataSource {
  const ref = useRef(opts.draft);
  const setRef = useRef(opts.setDraft);
  const hooksRef = useRef(opts.hooks);
  // The latest draft and callbacks, for writes made after this render (a write also moves `ref` itself, so
  // two quick edits before the next render build on each other).
  useLayoutEffect(() => {
    ref.current = opts.draft;
    setRef.current = opts.setDraft;
    hooksRef.current = opts.hooks;
  });
  const { today } = opts;
  const newId = opts.newId ?? newDraftId;

  return useMemo<ProjectDataSource>(() => {
    // Applies one edit to the latest draft; the views read the answer like a Server Action's.
    const commit = (edit: (d: AiDraft) => DraftEdit & { id?: string }): ActionResult & { id?: string } => {
      const res = edit(ref.current);
      if (!res.ok) return { error: res.error };
      ref.current = res.draft;
      setRef.current(res.draft);
      return res.id ? { id: res.id } : {};
    };
    const assigneeFor = (id: string | null): AiAssignee | undefined => {
      if (!id) return null;
      if (id.startsWith(PLACEHOLDER_PREFIX)) {
        const key = id.slice(PLACEHOLDER_PREFIX.length);
        const found = ref.current.tasks.find((t) => t.assignee && "placeholder" in t.assignee && t.assignee.placeholder.toLowerCase() === key);
        return found?.assignee ?? { placeholder: key };
      }
      return { member: id };
    };
    const isSubtask = (id: string) => !ref.current.tasks.some((t) => t.id === id) && Boolean(findSubtaskParent(ref.current, id));
    const subtaskNote = { error: "Subtasks of a draft only have a name: open the task to change them" };
    const unsupported = (what: string) => async () => ({ error: `${what} isn’t part of a draft` });

    return {
      draft: {
        openTask: (taskId) => hooksRef.current.openTask(taskId),
        addField: () => hooksRef.current.addField(),
        editField: (fieldId) => hooksRef.current.editField(fieldId),
        changeDates: async (taskId, dates) => (isSubtask(taskId) ? subtaskNote : commit((d) => setTaskDates(d, taskId, today, dates))),
        moveSection: async (sectionId, beforeId) => commit((d) => moveSection(d, sectionId, beforeId)),
      },
      createTask: async (_projectId, sectionId, title, kind = "task", atTop = false) => {
        if (kind !== "task") return { error: "A draft’s starter tasks are plain tasks" };
        const res = commit((d) => addTask(d, sectionId, title, atTop, newId));
        return res.error ? res : { taskId: res.id };
      },
      updateTask: async (taskId, patch) => {
        if (isSubtask(taskId)) {
          if (patch.title !== undefined) return commit((d) => renameSubtask(d, taskId, patch.title as string));
          return subtaskNote;
        }
        const next: TaskPatch = {};
        if (patch.title !== undefined) next.title = patch.title;
        if (patch.notes !== undefined) next.notes = patch.notes ?? "";
        if (patch.assigneeId !== undefined) {
          const assignee = assigneeFor(patch.assigneeId);
          if (assignee === undefined) return { error: "Pick a person or a placeholder" };
          next.assignee = assignee;
        }
        const res = commit((d) => updateTask(d, taskId, next));
        if (res.error || (patch.dueOn === undefined && patch.startOn === undefined)) return res;
        return commit((d) => setTaskDates(d, taskId, today, { dueOn: patch.dueOn, startOn: patch.startOn }));
      },
      setTaskCompleted: async () => ({ error: DRAFT_COMPLETE_NOTE }),
      moveTask: async (taskId, _projectId, sectionId) => commit((d) => placeTask(d, taskId, sectionId, null)),
      placeTask: async (taskId, _projectId, sectionId, beforeId) => commit((d) => placeTask(d, taskId, sectionId, beforeId)),
      updateSubtask: async (subtaskId, patch) => (patch.title !== undefined ? commit((d) => renameSubtask(d, subtaskId, patch.title as string)) : { error: DRAFT_COMPLETE_NOTE }),
      setFieldValue: async (taskId, fieldId, value) => commit((d) => setTaskValue(d, taskId, fieldId, value)),
      setFieldLocked: unsupported("Locking a field"),
      moveTaskTag: unsupported("Tags"),
      createSection: async (_projectId, name, beforeSectionId = null) => commit((d) => addSection(d, name, beforeSectionId, newId)),
      renameSection: async (sectionId, name) => commit((d) => renameSection(d, sectionId, name)),
      deleteSection: async (sectionId) => commit((d) => deleteSection(d, sectionId)),
      // A draft remembers nothing per person: column widths, collapsed groups, and open rows stay on screen.
      saveListCollapsedGroups: async () => ({}),
      saveListColumnWidths: async () => ({}),
      setTaskRowExpanded: async () => ({}),
      loadSubtaskRows: async () => ({ data: [] }),
    };
  }, [today, newId]);
}
