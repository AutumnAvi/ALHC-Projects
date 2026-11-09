"use client";

// Where the project views' writes go (AI builder round 2, note 168). The List and the Board call these
// instead of importing the Server Actions themselves; the default is exactly those Server Actions, so a
// normal project behaves as before. The AI builder's preview provides an in-memory source instead: the
// same components draw a draft that exists only in the browser, every edit changes the draft, and nothing
// is written until Create (components/ai-builder/draft-data-source.tsx).
import { createContext, useContext, type ReactNode } from "react";
import type { ActionResult } from "@alhc/core/api/core/result";
import { setFieldLocked, setFieldValue } from "@/lib/actions/fields";
import { loadSubtaskRows, setTaskRowExpanded } from "@/lib/actions/my-tasks";
import { createSection, deleteSection, renameSection } from "@/lib/actions/projects";
import { moveTaskTag } from "@/lib/actions/tags";
import { createTask, moveTask, placeTask, setTaskCompleted, updateSubtask, updateTask } from "@/lib/actions/tasks";
import { saveListCollapsedGroups, saveListColumnWidths } from "@/lib/actions/views";

const SERVER_ACTIONS = {
  createTask,
  updateTask,
  setTaskCompleted,
  moveTask,
  placeTask,
  updateSubtask,
  setFieldValue,
  setFieldLocked,
  moveTaskTag,
  createSection,
  renameSection,
  deleteSection,
  saveListCollapsedGroups,
  saveListColumnWidths,
  setTaskRowExpanded,
  loadSubtaskRows,
};

export type ProjectActions = typeof SERVER_ACTIONS;

// What a draft does instead of the app's own panes and dialogs.
export type DraftHooks = {
  // A row or card opens the draft's task editor (there's no task pane for a draft).
  openTask(taskId: string): void;
  // Dates change in place (a draft has no dependencies to shift).
  changeDates(taskId: string, dates: { startOn: string | null; dueOn: string | null }): Promise<ActionResult>;
  // Sections move in the draft itself (a project's sections move in the view's own order instead).
  moveSection(sectionId: string, beforeId: string | null): Promise<ActionResult>;
  addField(): void;
  editField(fieldId: string): void;
};

export type ProjectDataSource = ProjectActions & { draft: DraftHooks | null };

const SERVER: ProjectDataSource = { ...SERVER_ACTIONS, draft: null };

const DataSourceContext = createContext<ProjectDataSource>(SERVER);

export function ProjectDataSourceProvider({ value, children }: { value: ProjectDataSource; children: ReactNode }) {
  return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>;
}

export function useProjectData(): ProjectDataSource {
  return useContext(DataSourceContext);
}
