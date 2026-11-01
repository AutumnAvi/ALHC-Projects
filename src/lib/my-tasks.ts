// My Tasks sections vocabulary (browser + server), mirrored by my_task_sections in
// 20261006040000_my_tasks_workload.sql.

export const MY_TASK_SECTION_KINDS = ["recently_assigned", "do_today", "do_next_week", "do_later", "custom"] as const;
export type MyTaskSectionKind = (typeof MY_TASK_SECTION_KINDS)[number];

export const isMyTaskSectionKind = (value: unknown): value is MyTaskSectionKind =>
  MY_TASK_SECTION_KINDS.includes(value as MyTaskSectionKind);

export type MyTaskSection = { id: string; kind: MyTaskSectionKind; name: string; sortOrder: number };
// Where an open task sits in the viewer's My Tasks.
export type MyTaskPlacement = { sectionId: string; sortOrder: number };

// "checklist" (the default since Nov 1 notes, batch 9b: one list in automatic date groups), or the
// classic views: "sections" (your own My Tasks sections) and "due" (the fixed due-date buckets).
// Remembered in a cookie — a new one (the old my_tasks_layout cookie is ignored), so everyone opens the
// new checklist once and can go back to a classic view from its options menu.
export type MyTasksLayout = "checklist" | "sections" | "due";
export const DEFAULT_MY_TASKS_LAYOUT: MyTasksLayout = "checklist";
export const MY_TASKS_LAYOUT_COOKIE = "my_tasks_view";
export const isMyTasksLayout = (value: unknown): value is MyTasksLayout =>
  value === "checklist" || value === "sections" || value === "due";
// The cookie as the page reads it: anything unknown (or no cookie) opens the checklist.
export const myTasksLayoutOf = (value: unknown): MyTasksLayout => (isMyTasksLayout(value) ? value : DEFAULT_MY_TASKS_LAYOUT);
export function saveMyTasksLayout(layout: MyTasksLayout) {
  document.cookie = `${MY_TASKS_LAYOUT_COOKIE}=${layout}; path=/; max-age=31536000; samesite=lax`;
}
