// My Tasks sections vocabulary (browser + server), mirrored by my_task_sections in
// 20261006040000_my_tasks_workload.sql.

export const MY_TASK_SECTION_KINDS = ["recently_assigned", "do_today", "do_next_week", "do_later", "custom"] as const;
export type MyTaskSectionKind = (typeof MY_TASK_SECTION_KINDS)[number];

export const isMyTaskSectionKind = (value: unknown): value is MyTaskSectionKind =>
  MY_TASK_SECTION_KINDS.includes(value as MyTaskSectionKind);

export type MyTaskSection = { id: string; kind: MyTaskSectionKind; name: string; sortOrder: number };
// Where an open task sits in the viewer's My Tasks.
export type MyTaskPlacement = { sectionId: string; sortOrder: number };

// "sections" (default, Asana style) or "due" (the fixed due-date buckets). Remembered in a cookie.
export type MyTasksLayout = "sections" | "due";
export const MY_TASKS_LAYOUT_COOKIE = "my_tasks_layout";
export const isMyTasksLayout = (value: unknown): value is MyTasksLayout => value === "sections" || value === "due";
