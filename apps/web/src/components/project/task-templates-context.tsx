"use client";

import { createContext, useContext, type ReactNode } from "react";

// Task templates of the current project, for quick-add ("Add task" → Template). Loaded once by the
// project layout so List and Board don't each fetch them.
export type QuickAddTemplate = { id: string; name: string; title: string };

const TaskTemplatesContext = createContext<QuickAddTemplate[]>([]);

export function TaskTemplatesProvider({ templates, children }: { templates: QuickAddTemplate[]; children: ReactNode }) {
  return <TaskTemplatesContext.Provider value={templates}>{children}</TaskTemplatesContext.Provider>;
}

export function useTaskTemplates() {
  return useContext(TaskTemplatesContext);
}
