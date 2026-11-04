import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { listReadableProjects, listStarredProjectIds } from "@/lib/data";
import { MAX_RECENTS, parseRecentRefs, type QuickProject, type QuickTask, type RecentRef } from "@/lib/shell";
import { quickSearch, resolveRecents } from "@/lib/shell-actions";
import { createClient } from "@/lib/supabase/server";

const MAX_TASKS = 6;
const MAX_PROJECTS = 4;

// Nov 3 notes (batch 18, 133): the "#" link picker in comments and descriptions. A GET route rather
// than a Server Action (actions run one at a time per tab, so each keystroke's search queued behind the
// last one). Tasks by name, notes, or number (search_tasks) and projects by name, read with the person's
// own client — the search palette's own search, so RLS decides and nothing they can't open comes back.
//   GET /api/link-search?q=<text>   { tasks: QuickTask[], projects: QuickProject[] }
// Nov 4 notes (batch 25, 158): "#" alone (no q) suggests before anything is typed, like "@" does for
// people: the tasks and projects this browser opened recently (`recent=task:<id>,project:<id>`, ids only,
// resolved through RLS like the palette's recents), then the person's open tasks they were assigned most
// recently and their starred, then other active, projects.
export async function GET(request: NextRequest) {
  const { user, allowlisted } = await getViewer();
  if (!user) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  if (!allowlisted) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 200);
  const headers = { "Cache-Control": "private, no-store" };
  if (!q) {
    const recent = parseRecentRefs(request.nextUrl.searchParams.get("recent"));
    return NextResponse.json(await suggestions(user.id, recent), { headers });
  }
  const [tasks, projects] = await Promise.all([quickSearch(q, "tasks"), quickSearch(q, "projects")]);
  return NextResponse.json(
    { tasks: tasks.tasks.slice(0, MAX_TASKS), projects: projects.projects.slice(0, MAX_PROJECTS) },
    { headers },
  );
}

async function suggestions(userId: string, recent: RecentRef[]): Promise<{ tasks: QuickTask[]; projects: QuickProject[] }> {
  const supabase = await createClient();
  const [assigned, projects, starred] = await Promise.all([
    supabase
      .from("tasks")
      .select("id")
      .eq("assignee_id", userId)
      .is("completed_at", null)
      .is("deleted_at", null)
      .order("assigned_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .limit(MAX_TASKS),
    listReadableProjects(),
    listStarredProjectIds().catch(() => [] as string[]),
  ]);
  const recentTasks = recent.filter((r) => r.kind === "task");
  const taskRefs: RecentRef[] = [
    ...recentTasks,
    ...(assigned.error ? [] : (assigned.data ?? []))
      .filter((t) => !recentTasks.some((r) => r.id === t.id))
      .map((t) => ({ kind: "task" as const, id: t.id })),
  ];
  const recentProjects = recent.filter((r) => r.kind === "project");
  const resolved = await resolveRecents([...taskRefs.slice(0, MAX_RECENTS - recentProjects.length), ...recentProjects]);
  const tasks = resolved.flatMap((r) => (r.kind === "task" ? [toQuickTask(r)] : [])).slice(0, MAX_TASKS);
  const recentProjectList = resolved.flatMap((r) => (r.kind === "project" ? [{ id: r.id, name: r.name, archived: r.archived }] : []));
  const seen = new Set(recentProjectList.map((p) => p.id));
  const starredSet = new Set(starred);
  const others = projects
    .filter((p) => p.archived_at === null && !seen.has(p.id))
    .sort((a, b) => Number(starredSet.has(b.id)) - Number(starredSet.has(a.id)))
    .map((p) => ({ id: p.id, name: p.name, archived: false }));
  return { tasks, projects: [...recentProjectList, ...others].slice(0, MAX_PROJECTS) };
}

function toQuickTask(item: QuickTask & { kind: "task" }): QuickTask {
  const { kind: _kind, ...task } = item;
  void _kind;
  return task;
}
