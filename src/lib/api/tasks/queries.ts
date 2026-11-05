// Big move 1: the tasks area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getViewer } from "@/lib/api/auth/queries";
import { type ApiContext, type Db, read } from "@/lib/api/core/context";
import { readInChunks, rows, rpcMissing } from "@/lib/api/core/db";
import { ApiError } from "@/lib/api/core/errors";
import { softRead } from "@/lib/api/core/soft-read";
import { id } from "@/lib/api/core/validate";
import {
  firstVisibleNumbers,
  numbersWithTheirProjects,
  visibleRequestLabelsIn,
  visibleTaskNumbers,
} from "@/lib/api/numbers/queries";
import { listMyProjectRoles, listReadableProjects } from "@/lib/api/projects/queries";
import { listTaskTagIds } from "@/lib/api/tags/queries";
import {
  accessFromRows,
  approvalRowState,
  type ApprovalRowState,
  type ParentCandidate,
  type ProjectDependency,
  type ProjectTask,
  type ProjectTaskGroupPage,
  projectTasksFromCards,
  SUBTASK_COLUMNS,
  type SubtaskItem,
  taskGroupPagesFrom,
  toSubtaskItems,
  type TrashedTask,
  withPageLabels,
} from "@/lib/api/tasks/model";
import type { CriticalPath } from "@/lib/critical-path";
import { parseDependencyKind } from "@/lib/dependencies";
import { bareTaskTitle, displayTaskTitle, type RequestLabel, type TaskNumber } from "@/lib/request-numbers";
import type { Json } from "@/lib/supabase/database.types";
import { parseApprovalTaskStatus, parseTaskKind } from "@/lib/task-kinds";
import { toJson, type ViewFilters, type ViewSort } from "@/lib/views";

// Calendar and Timeline tasks for one date window (project_schedule_cards). Null when that
// function is not there yet: the caller keeps the full project_task_cards list.
export const listProjectSchedule = read(
  async (
    ctx: ApiContext, projectId: string,
    filters: ViewFilters,
    timeZone: string,
    range: { start: string; end: string } | null,
    schedule: "calendar" | "timeline",
  ): Promise<ProjectTask[] | null> => {
    const supabase = ctx.db;
    const result = await supabase.rpc("project_schedule_cards", {
      target_project: projectId,
      filters: toJson(filters),
      tz: timeZone,
      range_start: range?.start ?? null,
      range_end: range?.end ?? null,
      schedule,
    });
    if (rpcMissing(result.error)) return null;
    if (result.error) throw new Error(`Failed to load tasks: ${result.error.message}`);
    return withRequestLabels(ctx, projectTasksFromCards(result.data), projectId);
  },
);

// One read for the cards a project view draws (project_task_cards). A database without that
// function falls back to the row queries.
export const listProjectTasks = read(async (ctx: ApiContext, projectId: string): Promise<ProjectTask[]> => {
  const supabase = ctx.db;
  const cards = await supabase.rpc("project_task_cards", { target_project: projectId });
  if (!cards.error) return withRequestLabels(ctx, projectTasksFromCards(cards.data), projectId);
  if (rpcMissing(cards.error)) return listProjectTasksFromRows(ctx, projectId);
  throw new Error(`Failed to load tasks: ${cards.error.message}`);
});

export const listProjectTaskPage = read(
  async (
    ctx: ApiContext, projectId: string,
    filters: ViewFilters,
    timeZone: string,
    groupBy: string,
    sorts: ViewSort[],
    pageSize: number,
    limits: Record<string, number>,
  ): Promise<ProjectTaskGroupPage[] | null> => {
    const supabase = ctx.db;
    const result = await supabase.rpc("project_task_card_page", {
      target_project: projectId,
      filters: toJson(filters),
      tz: timeZone,
      group_by: groupBy,
      sorts: sorts as Json,
      page_size: pageSize,
      limits: limits as Json,
    });
    if (rpcMissing(result.error)) return null;
    if (result.error) throw new Error(`Failed to load tasks: ${result.error.message}`);
    const pages = taskGroupPagesFrom(result.data);
    const labels = await visibleRequestLabelsIn(ctx, projectId, pages.flatMap((page) => page.tasks.map((task) => task.id)));
    return withPageLabels(pages, labels);
  },
);

// Active tasks per section, including ones the current view hides (delete-section checks).
// Null when the function is not there yet; the page then counts the tasks it already loaded.
export const listSectionTaskCounts = read(async (ctx: ApiContext, projectId: string): Promise<Record<string, number> | null> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("project_section_task_counts", { target_project: projectId });
  if (rpcMissing(result.error)) return null;
  if (result.error) throw new Error(`Failed to load section counts: ${result.error.message}`);
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) return {};
  const counts: Record<string, number> = {};
  for (const [sectionId, count] of Object.entries(result.data)) {
    if (typeof count === "number") counts[sectionId] = count;
  }
  return counts;
});

async function listProjectTasksFromRows(ctx: ApiContext, projectId: string): Promise<ProjectTask[]> {
  const supabase = ctx.db;
  const memberships = rows(
    await supabase
      .from("task_projects")
      .select(
        "section_id, sort_order, task:tasks!inner(id, title, completed_at, start_on, due_on, assignee_id, home_project_id, created_at, recurrence, kind)",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .is("task.deleted_at", null)
      .order("sort_order"),
    "tasks",
  );

  const taskIds = memberships.map((m) => m.task.id);
  if (taskIds.length === 0) return [];

  const approvalTaskIds = memberships.filter((m) => m.task.kind === "approval").map((m) => m.task.id);
  const [subtasks, otherMemberships, values, blockers, approvalRequests, tagIds, commentCounts] = await Promise.all([
    supabase
      .from("tasks")
      .select("parent_task_id, completed_at")
      .in("parent_task_id", taskIds)
      .is("deleted_at", null),
    supabase
      .from("task_projects")
      .select("task_id, project:projects!inner(id)")
      .in("task_id", taskIds)
      .is("deleted_at", null)
      .is("project.deleted_at", null),
    supabase
      .from("task_field_values")
      .select("task_id, field_id, value, field:custom_fields!inner(project_id)")
      .in("task_id", taskIds)
      .eq("field.project_id", projectId)
      .is("field.deleted_at", null)
      .not("value", "is", null),
    supabase
      .from("task_dependencies")
      .select("successor_id, predecessor:tasks!task_dependencies_predecessor_id_fkey!inner(id)")
      .in("successor_id", taskIds)
      // Links that hold up completing the task while the predecessor is open (start → start never does;
      // start → finish only until the predecessor starts, which the pane's count and the database check).
      .in("kind", ["finish_to_start", "finish_to_finish"])
      .is("deleted_at", null)
      .is("predecessor.deleted_at", null)
      .is("predecessor.completed_at", null),
    approvalTaskIds.length
      ? supabase
          .from("approval_requests")
          .select("task_id, subtask_id, approver_id, status, created_at")
          .in("task_id", approvalTaskIds)
          .is("subtask_id", null)
          .is("deleted_at", null)
          .neq("status", "cancelled")
      : Promise.resolve({ data: [], error: null }),
    listTaskTagIds(ctx, taskIds),
    listCommentCounts(ctx, taskIds),
  ]);

  const approvalsByTask = new Map<string, { subtaskId: string | null; approverId: string; status: string; createdAt: string }[]>();
  for (const a of rows(approvalRequests, "approvals")) {
    const list = approvalsByTask.get(a.task_id) ?? [];
    list.push({ subtaskId: a.subtask_id, approverId: a.approver_id, status: a.status, createdAt: a.created_at });
    approvalsByTask.set(a.task_id, list);
  }

  const blockedBy = new Map<string, number>();
  for (const d of rows(blockers, "dependencies")) {
    blockedBy.set(d.successor_id, (blockedBy.get(d.successor_id) ?? 0) + 1);
  }

  const fieldValues = new Map<string, Record<string, Json>>();
  for (const v of rows(values, "field values")) {
    const record = fieldValues.get(v.task_id) ?? {};
    record[v.field_id] = v.value;
    fieldValues.set(v.task_id, record);
  }

  const subtaskStats = new Map<string, { total: number; done: number }>();
  for (const s of rows(subtasks, "subtasks")) {
    if (!s.parent_task_id) continue;
    const stat = subtaskStats.get(s.parent_task_id) ?? { total: 0, done: 0 };
    stat.total += 1;
    if (s.completed_at) stat.done += 1;
    subtaskStats.set(s.parent_task_id, stat);
  }

  const projectCounts = new Map<string, number>();
  for (const m of rows(otherMemberships, "task projects")) {
    projectCounts.set(m.task_id, (projectCounts.get(m.task_id) ?? 0) + 1);
  }

  return withRequestLabels(ctx, memberships.map((m) => ({
    id: m.task.id,
    title: m.task.title,
    completedAt: m.task.completed_at,
    startOn: m.task.start_on,
    dueOn: m.task.due_on,
    assigneeId: m.task.assignee_id,
    homeProjectId: m.task.home_project_id ?? projectId,
    createdAt: m.task.created_at,
    sectionId: m.section_id,
    sortOrder: m.sort_order,
    subtaskCount: subtaskStats.get(m.task.id)?.total ?? 0,
    subtaskDoneCount: subtaskStats.get(m.task.id)?.done ?? 0,
    projectCount: projectCounts.get(m.task.id) ?? 1,
    fieldValues: fieldValues.get(m.task.id) ?? {},
    recurring: m.task.recurrence !== null,
    blockedBy: blockedBy.get(m.task.id) ?? 0,
    kind: parseTaskKind(m.task.kind),
    approvalStatus:
      parseTaskKind(m.task.kind) === "approval"
        ? (parseApprovalTaskStatus(
            [...(approvalsByTask.get(m.task.id) ?? [])].sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0]?.status,
          ) ?? "not_sent")
        : null,
    tagIds: tagIds.get(m.task.id) ?? [],
    commentCount: commentCounts.get(m.task.id) ?? 0,
  })));
}

// projectId: the labels shown inside that project (its own numbers; Oct 27 notes, batch 6). Without one,
// each task's first number the viewer can read (Oct 29 notes, 55b: the stable order, no home project).
export async function withRequestLabels<T extends { id: string }>(
  ctx: ApiContext, tasks: T[],
  projectId?: string,
): Promise<Array<T & { requestLabel: RequestLabel | null }>> {
  const ids = tasks.map((task) => task.id);
  const labels = projectId ? await visibleRequestLabelsIn(ctx, projectId, ids) : await firstVisibleNumbers(ctx, ids);
  return tasks.map((task) => ({ ...task, requestLabel: labels.get(task.id) ?? null }));
}

// Comments per task the viewer can read, not deleted: one grouped count in SQL (task_comment_counts,
// invoker, so comments RLS decides). A preview deployed before 20261011020000_asana_parity_2.sql shows no
// counts rather than failing the page.
async function listCommentCounts(ctx: ApiContext, taskIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (taskIds.length === 0) return counts;
  const supabase = ctx.db;
  const result = await supabase.rpc("task_comment_counts", { task_ids: taskIds });
  if (result.error) {
    console.error(`[comments] couldn't count comments: ${result.error.message}`);
    return counts;
  }
  for (const row of result.data ?? []) counts.set(row.task_id, Number(row.comment_count));
  return counts;
}

// Every active subtask (all levels) under the given top-level tasks, for List's “Show subtasks” and
// expanded rows. projectId: numbered as that project numbers them (Oct 27 notes, batch 6).
export const listSubtaskTrees = read(async (ctx: ApiContext, rootIds: string[], projectId?: string): Promise<SubtaskItem[]> => {
  if (rootIds.length === 0) return [];
  const supabase = ctx.db;
  const list = rows(
    await supabase.from("tasks").select(SUBTASK_COLUMNS).in("root_task_id", rootIds).is("deleted_at", null),
    "subtasks",
  );
  const blocked = await openBlockerCounts(supabase, list.filter((t) => !t.completed_at).map((t) => t.id));
  const items = toSubtaskItems(list, list).map((item) => ({ ...item, blockedBy: blocked.get(item.id) ?? 0 }));
  return withRequestLabels(ctx, await withSubtaskApprovals(supabase, items), projectId);
});

// Critical path and slack over the project's readable tasks (read-only; see project_critical_path()).
export const projectCriticalPath = read(async (ctx: ApiContext, projectId: string): Promise<CriticalPath> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("project_critical_path", { target_project: projectId });
  const tasks: CriticalPath["tasks"] = {};
  let skipped = 0;
  for (const r of rows(result, "critical path")) {
    if (r.skipped || r.slack_days === null) skipped += 1;
    else tasks[r.task_id] = { slackDays: r.slack_days, critical: r.critical };
  }
  return { tasks, skipped };
});

// Active dependencies between two active tasks of a project (Timeline arrows), wherever they were made.
export const listProjectDependencies = read(async (ctx: ApiContext, projectId: string): Promise<ProjectDependency[]> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("project_dependencies", { target_project: projectId });
  return rows(result, "dependencies").map((d) => ({
    id: d.id,
    predecessorId: d.predecessor_id,
    successorId: d.successor_id,
    kind: parseDependencyKind(d.kind),
    lagDays: d.lag_days,
  }));
});

// Titles of the given tasks the viewer can read (parent labels for subtasks).
export async function taskTitles(ctx: ApiContext, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (unique.length === 0) return new Map();
  const supabase = ctx.db;
  const result = await supabase.from("tasks").select("id, title").in("id", unique);
  return new Map(rows(result, "parent tasks").map((t) => [t.id, t.title] as const));
}

export async function taskAccessSets(ctx: ApiContext, taskIds: string[]): Promise<{ editable: Set<string>; commentable: Set<string> }> {
  const editable = new Set<string>();
  const commentable = new Set<string>();
  const access = { editable, commentable };
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return access;
  const { user } = await getViewer(ctx);
  if (!user) return access;
  const supabase = ctx.db;
  type Row = { id: string; root_task_id: string | null; home_project_id: string | null; created_by: string | null; assignee_id: string | null };
  const read = (want: string[]) =>
    readInChunks(want, 200, async (chunk) =>
      rows(
        await supabase.from("tasks").select("id, root_task_id, home_project_id, created_by, assignee_id").in("id", chunk),
        "task access",
      ) as Row[],
    );
  const tasks = await read(ids);
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const rootOf = (t: Row) => t.root_task_id ?? t.id;
  const missingRoots = [...new Set(tasks.map(rootOf))].filter((id) => !byId.has(id));
  const roots = await read(missingRoots);
  const rootIds = [...new Set(tasks.map(rootOf))];
  const [roles, memberships] = await Promise.all([
    listMyProjectRoles(ctx),
    readInChunks(rootIds, 200, async (chunk) =>
      rows(await supabase.from("task_projects").select("task_id, project_id").in("task_id", chunk).is("deleted_at", null), "task projects"),
    ),
  ]);
  return accessFromRows(ids, [...tasks, ...roots], memberships, roles, user.id);
}

export const searchTasks = read(async (ctx: ApiContext, query: string) => {
  const supabase = ctx.db;
  const result = await supabase.rpc("search_tasks", { query, max_results: 50 });
  const found = rows(result, "search results");
  // search_tasks names each task's first project the viewer can read (its home_project_* columns; Oct 29
  // notes, 55b: there's no home project, the names are the database's); the numbers come from the same
  // projects, first one in front.
  // Nov 3 notes (batch 19, 142): the numbers are decoration; a slow read shows the results without them.
  const numbers = await softRead("search numbers", visibleTaskNumbers(ctx, found.map((task) => task.id)), new Map<string, TaskNumber[]>());
  return found.map((task) => {
    const taskNumbers = numbers.get(task.id) ?? [];
    const label = taskNumbers[0]?.label ?? null;
    return {
      ...task,
      title: displayTaskTitle(task.title, label),
      // The name and the number apart, for screens that draw the number as a badge (Oct 26 notes, batch 4).
      bareTitle: bareTaskTitle(task.title, label),
      requestLabel: label,
      taskNumbers,
    };
  });
});

const TRASH_LIMIT = 200;

// The one read in this module that asks for deleted rows on purpose: tasks with an active membership in
// the project whose task row is soft-deleted, newest first.
export const listTrashedTasks = read(async (ctx: ApiContext, projectId: string): Promise<TrashedTask[]> => {
  const supabase = ctx.db;
  const trashed = rows(
    await supabase
      .from("tasks")
      .select("id, title, deleted_at, completed_at, task_projects!inner(project_id)")
      .eq("task_projects.project_id", projectId)
      .is("task_projects.deleted_at", null)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(TRASH_LIMIT),
    "trash",
  );
  // Subtasks have no memberships: list the ones trashed on their own (their parent is active, so
  // restoring works) whose root task is in this project. Ones trashed with their parent come back
  // with it.
  const trashedSubtasks = rows(
    await supabase
      .from("tasks")
      .select(
        "id, title, deleted_at, completed_at, root_task_id, parent_task_id",
      )
      .not("root_task_id", "is", null)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(TRASH_LIMIT),
    "trashed subtasks",
  );
  const rootIds = [...new Set(trashedSubtasks.map((t) => t.root_task_id!))];
  const parentIds = [...new Set(trashedSubtasks.map((t) => t.parent_task_id!))];
  const [rootsHere, activeParents] = await Promise.all([
    rootIds.length
      ? supabase
          .from("task_projects")
          .select("task_id")
          .eq("project_id", projectId)
          .in("task_id", rootIds)
          .is("deleted_at", null)
          .then((result) => new Set(rows(result, "task projects").map((m) => m.task_id)))
      : new Set<string>(),
    parentIds.length
      ? supabase
          .from("tasks")
          .select("id, title")
          .in("id", parentIds)
          .is("deleted_at", null)
          .then((result) => new Map(rows(result, "parent tasks").map((t) => [t.id, t.title] as const)))
      : new Map<string, string>(),
  ]);
  const all = [
    ...trashed.map((t) => ({ ...t, parentTitle: null as string | null })),
    ...trashedSubtasks
      .filter((t) => rootsHere.has(t.root_task_id!) && activeParents.has(t.parent_task_id!))
      .map((t) => ({ ...t, parentTitle: activeParents.get(t.parent_task_id!) ?? null })),
  ]
    .sort((a, b) => b.deleted_at!.localeCompare(a.deleted_at!))
    .slice(0, TRASH_LIMIT);
  if (all.length === 0) return [];

  const topLevelIds = all.filter((t) => !t.parentTitle).map((t) => t.id);
  const [stories, projects, otherMemberships] = await Promise.all([
    supabase
      .from("task_stories")
      .select("task_id, actor_id, created_at")
      .in(
        "task_id",
        all.map((t) => t.id),
      )
      .eq("kind", "deleted")
      .order("created_at", { ascending: false }),
    listReadableProjects(ctx),
    // Their other active projects (RLS shows the memberships of projects the viewer can read).
    topLevelIds.length
      ? supabase
          .from("task_projects")
          .select("task_id, project_id, created_at")
          .in("task_id", topLevelIds)
          .neq("project_id", projectId)
          .is("deleted_at", null)
          .order("created_at")
          .order("project_id")
      : Promise.resolve({ data: [] as { task_id: string; project_id: string; created_at: string }[], error: null }),
  ]);
  const deletedBy = new Map<string, string | null>();
  for (const story of rows(stories, "deletions")) {
    if (!deletedBy.has(story.task_id)) deletedBy.set(story.task_id, story.actor_id);
  }
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));
  const others = new Map<string, string[]>();
  for (const m of otherMemberships.error ? [] : (otherMemberships.data ?? [])) {
    const name = projectName.get(m.project_id);
    if (name) others.set(m.task_id, [...(others.get(m.task_id) ?? []), name]);
  }
  return all.map((t) => ({
    id: t.id,
    title: t.title,
    deletedAt: t.deleted_at!,
    deletedBy: deletedBy.get(t.id) ?? null,
    otherProjectNames: others.get(t.id) ?? [],
    completedAt: t.completed_at,
    parentTitle: t.parentTitle,
  }));
});

export async function approvalRowStates(supabase: Db, taskIds: string[]): Promise<Map<string, ApprovalRowState>> {
  const states = new Map<string, ApprovalRowState>();
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return states;
  for (let i = 0; i < ids.length; i += 500) {
    const result = await supabase.rpc("task_approval_states", { task_ids: ids.slice(i, i + 500) });
    if (rpcMissing(result.error)) {
      const each = await Promise.all(
        ids.slice(0, 200).map((taskId) =>
          supabase.rpc("task_approval_state", { target_task: taskId }).then((r) => [taskId, r.data] as const),
        ),
      );
      for (const [taskId, value] of each) states.set(taskId, approvalRowState(value ?? undefined));
      return states;
    }
    if (result.error || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) return states;
    for (const [taskId, value] of Object.entries(result.data)) states.set(taskId, approvalRowState(value));
  }
  return states;
}

// Approval subtasks get their row state (other kinds are returned as they are).
export async function withSubtaskApprovals(supabase: Db, items: SubtaskItem[]): Promise<SubtaskItem[]> {
  const approvalIds = items.filter((item) => item.kind === "approval" && !item.completedAt).map((item) => item.id);
  if (approvalIds.length === 0) return items;
  const states = await approvalRowStates(supabase, approvalIds);
  return items.map((item) => (states.has(item.id) ? { ...item, ...states.get(item.id) } : item));
}

// Open-blocker counts (open_blocker_counts: the completion check's count, hidden blockers included as a
// number). Empty on a database without the function.
export async function openBlockerCounts(supabase: Db, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 2000) {
    const result = await supabase.rpc("open_blocker_counts", { task_ids: ids.slice(i, i + 2000) });
    if (result.error || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) return counts;
    for (const [taskId, count] of Object.entries(result.data)) {
      if (typeof count === "number" && count > 0) counts.set(taskId, count);
    }
  }
  return counts;
}

export async function listSubtaskParents(ctx: ApiContext, taskId: string, query: string): Promise<{ error?: string; data?: ParentCandidate[] }> {
  const supabase = ctx.db;
  const result = await supabase.rpc("subtask_parent_candidates", {
    target_task: taskId,
    query: query.slice(0, 200),
    max_results: 30,
  });
  if (result.error) return { error: result.error.message };
  const found = result.data ?? [];
  const named = await numbersWithTheirProjects(
    ctx,
    found.map((c) => ({ id: c.id, projectId: c.home_project_id })),
  );
  return {
    data: found.map((c) => ({
      id: c.id,
      title: c.title,
      label: named.get(c.id)?.label ?? null,
      projectName: named.get(c.id)?.projectName ?? null,
      isSubtask: c.parent_task_id !== null,
      completed: c.completed_at !== null,
    })),
  };
}

// 42. "Make a subtask of…": tasks the viewer edits that this task can go under (searchable). Since Nov 2
// notes (batch 16, 124) the picker reads GET /api/task-pane/<id>/parents (a route, so searches never queue
// behind other actions); this stays for callers that want it (a Server Action).
export async function searchSubtaskParents(ctx: ApiContext, taskId: string, query: string): Promise<ParentCandidate[] | undefined> {
  const result = await listSubtaskParents(ctx, id(taskId, "task"), typeof query === "string" ? query : "");
  if (result.error) throw new ApiError("failed", result.error);
  return result.data;
}

// Labels of tasks as one project shows them (rows added on the client, e.g. expanded subtasks).
export async function loadProjectLabels(ctx: ApiContext, projectId: string, taskIds: string[]): Promise<Record<string, RequestLabel>> {
  const labels = await visibleRequestLabelsIn(ctx, id(projectId, "project"), (taskIds ?? []).slice(0, 2000).map((t) => id(t, "task")));
  return Object.fromEntries(labels);
}
