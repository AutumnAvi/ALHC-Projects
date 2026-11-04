// Big move 1: the my-tasks area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getViewer } from "@/lib/api/auth/queries";
import { type ApiContext, read } from "@/lib/api/core/context";
import { readInChunks, rows, rpcMissing } from "@/lib/api/core/db";
import {
  assembleMyTasks,
  type AwaitingApproval,
  awaitingFrom,
  type MyTask,
  myTaskExtrasFrom,
  myTasksFromCards,
} from "@/lib/api/my-tasks/model";
import { visibleTaskNumbers, visibleTaskPlaces } from "@/lib/api/numbers/queries";
import { listReadableProjects } from "@/lib/api/projects/queries";
import { approvalRowStates, openBlockerCounts, taskAccessSets, taskTitles } from "@/lib/api/tasks/queries";
import { isMyTaskSectionKind, type MyTaskPlacement, type MyTaskSection } from "@/lib/my-tasks";
import { parseTaskKind } from "@/lib/task-kinds";

async function labelMyTasks(ctx: ApiContext, page: { open: MyTask[]; completed: MyTask[] }) {
  const ids = [...page.open, ...page.completed].map((task) => task.id);
  const [numbers, access, extras] = await Promise.all([visibleTaskNumbers(ctx, ids), taskAccessSets(ctx, ids), myTaskExtras(ctx, page.open)]);
  return assembleMyTasks(page, numbers, access, extras);
}

// Tasks come back only when the viewer can read them (membership in one of their projects, or a
// private task they created or are assigned). Each is labelled with the first project it was added to
// that the viewer can see (Oct 29 notes, 55b: the stable rule); private tasks (and their subtasks) have
// no project.
// my_task_cards does that in one read. A database without the function uses the row queries.
export const listMyTasks = read(async (ctx: ApiContext, profileId: string) => {
  const { user } = await getViewer(ctx);
  if (user?.id === profileId) {
    const supabase = ctx.db;
    const cards = await supabase.rpc("my_task_cards");
    if (!cards.error) return labelMyTasks(ctx, myTasksFromCards(cards.data));
    if (!rpcMissing(cards.error)) throw new Error(`Failed to load my tasks: ${cards.error.message}`);
  }
  return listMyTasksFromRows(ctx, profileId);
});

async function listMyTasksFromRows(ctx: ApiContext, profileId: string) {
  const supabase = ctx.db;
  const select =
    "id, title, completed_at, due_on, start_on, recurrence, assigned_at, home_project_id, kind, root_task_id, parent_task_id";
  const [open, done, projects] = await Promise.all([
    supabase
      .from("tasks")
      .select(select)
      .eq("assignee_id", profileId)
      .is("deleted_at", null)
      .is("completed_at", null)
      .order("due_on", { nullsFirst: false })
      .order("created_at"),
    supabase
      .from("tasks")
      .select(select)
      .eq("assignee_id", profileId)
      .is("deleted_at", null)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(30),
    listReadableProjects(ctx),
  ]);
  const openRows = rows(open, "my tasks");
  const doneRows = rows(done, "completed tasks");
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));
  // A subtask is labelled with a project of its root task (it has no memberships of its own).
  const scopeId = (t: { id: string; root_task_id: string | null }) => t.root_task_id ?? t.id;
  const taskIds = [...new Set([...openRows, ...doneRows].map(scopeId))];
  const [memberships, parentTitle] = await Promise.all([
    taskIds.length
      ? supabase
          .from("task_projects")
          .select("task_id, project_id")
          .in("task_id", taskIds)
          .is("deleted_at", null)
          .order("created_at")
          .order("project_id")
          .then((result) => rows(result, "task projects"))
      : [],
    taskTitles(ctx, [...openRows, ...doneRows].map((t) => t.parent_task_id)),
  ]);

  const toMyTask = (t: (typeof openRows)[number]): MyTask | null => {
    const isPrivate = t.home_project_id === null;
    const projectId = memberships.find((m) => m.task_id === scopeId(t) && projectName.has(m.project_id))?.project_id;
    if (!projectId && !isPrivate) return null;
    return {
      id: t.id,
      title: t.title,
      completedAt: t.completed_at,
      dueOn: t.due_on,
      projectId: projectId ?? null,
      projectName: projectId ? projectName.get(projectId)! : null,
      kind: parseTaskKind(t.kind),
      parentTitle: t.parent_task_id ? (parentTitle.get(t.parent_task_id) ?? null) : null,
      canEdit: true,
      startOn: t.start_on,
      recurring: t.recurrence !== null,
      assignedAt: t.assigned_at,
      datePrompt: false,
    };
  };
  const present = (t: MyTask | null): t is MyTask => t !== null;
  return labelMyTasks(ctx, {
    open: openRows.map(toMyTask).filter(present),
    completed: doneRows.map(toMyTask).filter(present),
  });
}

// The viewer's My Tasks sections and where each open task assigned to them sits. my_tasks_layout()
// seeds the sections on first use and puts newly assigned tasks at the top of Recently assigned.
export const listMyTaskLayout = read(
  async (ctx: ApiContext): Promise<{ sections: MyTaskSection[]; placements: Record<string, MyTaskPlacement> }> => {
    const supabase = ctx.db;
    const layout = rows(await supabase.rpc("my_tasks_layout"), "my tasks layout");
    const result = await supabase
      .from("my_task_sections")
      .select("id, kind, name, sort_order")
      .is("deleted_at", null)
      .order("sort_order")
      .order("created_at");
    const sections = rows(result, "my tasks sections").flatMap((s) =>
      isMyTaskSectionKind(s.kind) ? [{ id: s.id, kind: s.kind, name: s.name, sortOrder: s.sort_order }] : [],
    );
    const placements: Record<string, MyTaskPlacement> = {};
    for (const row of layout) placements[row.task_id] = { sectionId: row.section_id, sortOrder: row.sort_order };
    return { sections, placements };
  },
);

// My tasks rows: open blockers, direct subtask counts, approval status (one read each).
async function myTaskExtras(ctx: ApiContext, tasks: MyTask[]): Promise<Map<string, Partial<MyTask>>> {
  const extras = new Map<string, Partial<MyTask>>();
  const ids = tasks.map((t) => t.id);
  if (ids.length === 0) return extras;
  const supabase = ctx.db;
  const approvalIds = tasks.filter((t) => t.kind === "approval").map((t) => t.id);
  // .in() lists go in the URL: chunks of 200 ids, read at once (Nov 3 notes, batch 18, 135; a list of
  // 1,700 ids made a ~60 KB URL some proxies refuse).
  const [blocked, children, states, roots] = await Promise.all([
    openBlockerCounts(supabase, ids),
    readInChunks(ids, 200, async (chunk) =>
      (await supabase.from("tasks").select("parent_task_id, completed_at").in("parent_task_id", chunk).is("deleted_at", null)).data ?? [],
    ),
    approvalRowStates(supabase, approvalIds),
    readInChunks(ids, 200, async (chunk) =>
      (await supabase.from("tasks").select("id, root_task_id").in("id", chunk).not("root_task_id", "is", null)).data ?? [],
    ),
  ]);
  return myTaskExtrasFrom(blocked, children, states, roots);
}

export const listAwaitingMyApproval = read(async (ctx: ApiContext): Promise<AwaitingApproval[]> => {
  const { user } = await getViewer(ctx);
  if (!user) return [];
  const supabase = ctx.db;
  const requests = await supabase
    .from("approval_requests")
    .select("id, task_id, round_id, created_at")
    .eq("approver_id", user.id)
    .eq("status", "pending")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (requests.error || !requests.data?.length) return [];
  const taskIds = [...new Set(requests.data.map((r) => r.task_id))];
  const roundIds = [...new Set(requests.data.map((r) => r.round_id).filter((r): r is string => Boolean(r)))];
  const [tasks, rounds, places, access] = await Promise.all([
    supabase.from("tasks").select("id, title, kind, due_on, completed_at").in("id", taskIds).is("deleted_at", null),
    roundIds.length
      ? supabase.from("approval_rounds").select("id, status, due_on, round_number").in("id", roundIds)
      : Promise.resolve({ data: [] as { id: string; status: string; due_on: string | null; round_number: number }[], error: null }),
    visibleTaskPlaces(ctx, taskIds),
    // decide_approval needs Commenter+: an approver lowered to Viewer isn't waited on (Oct 29 notes, batch 7).
    taskAccessSets(ctx, taskIds),
  ]);
  return awaitingFrom(requests.data, tasks.data ?? [], rounds.data ?? [], places, access);
});
