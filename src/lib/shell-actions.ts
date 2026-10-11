"use server";

// Reads the app shell loads on demand (Asana parity, batch 1): the search palette's live results and
// recents, the Settings modal, and the Create menu's dialogs. Every one runs with the signed-in person's
// own Supabase client (cookies), never the service role, so RLS decides what comes back: no task or
// project the person can't open is ever returned, workspace admins included.

import { displayName } from "@/components/avatar";
import { getViewer } from "@/lib/auth";
import {
  getGoalViewer,
  getMySettings,
  listGoals,
  listMyProjectRoles,
  listProfiles,
  listProjects,
  listReadableProjects,
  listTeams,
  type MySettings,
} from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { hasRole } from "@/lib/roles";
import {
  EMPTY_RESULTS,
  MAX_RECENTS,
  isSearchKind,
  type QuickPerson,
  type QuickProject,
  type QuickResults,
  type QuickTask,
  type RecentItem,
  type RecentRef,
  type SearchKind,
} from "@/lib/shell";
import { createClient } from "@/lib/supabase/server";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@/lib/workload";

async function signedIn() {
  const { user, allowlisted } = await getViewer();
  return Boolean(user && allowlisted);
}

// Starts-with matches first, then the rest, each alphabetically.
function rank<T>(items: T[], label: (item: T) => string, needle: string): T[] {
  return [...items].sort((a, b) => {
    const la = label(a).toLowerCase();
    const lb = label(b).toLowerCase();
    const sa = la.startsWith(needle) ? 0 : 1;
    const sb = lb.startsWith(needle) ? 0 : 1;
    return sa - sb || la.localeCompare(lb);
  });
}

// People in the workspace: profiles whose address is still on the allowlist (removed people left out).
async function activePeople(): Promise<QuickPerson[]> {
  const supabase = await createClient();
  const [profiles, allowed] = await Promise.all([
    listProfiles(),
    supabase.from("allowed_emails").select("email").is("removed_at", null),
  ]);
  if (allowed.error) return [];
  const active = new Set((allowed.data ?? []).map((row) => row.email.toLowerCase()));
  return profiles
    .filter((p) => active.has(p.email.toLowerCase()))
    .map((p) => ({ id: p.id, name: displayName(p), email: p.email }));
}

// The palette's live results. `only` narrows to one kind (a chip), with more rows.
export async function quickSearch(query: string, only: SearchKind | null = null): Promise<QuickResults> {
  const q = typeof query === "string" ? query.trim().slice(0, 200) : "";
  if (!q || !(await signedIn())) return EMPTY_RESULTS;
  const kind = isSearchKind(only) ? only : null;
  const limit = kind ? 20 : 5;
  const needle = q.toLowerCase();
  const supabase = await createClient();

  const [taskResult, projects, people] = await Promise.all([
    !kind || kind === "tasks" ? supabase.rpc("search_tasks", { query: q, max_results: limit }) : null,
    !kind || kind === "projects" ? listReadableProjects() : null,
    !kind || kind === "people" ? activePeople() : null,
  ]);

  const tasks: QuickTask[] =
    taskResult && !taskResult.error
      ? (taskResult.data ?? []).map((t) => ({
          id: t.id,
          title: t.title,
          completed: Boolean(t.completed_at),
          // search_tasks labels every project task with a project the person can read; null = private.
          isPrivate: !t.home_project_id,
          projectId: t.home_project_id,
          projectName: t.home_project_name,
          href: t.home_project_id ? `/projects/${t.home_project_id}?task=${t.id}` : `/my-tasks?task=${t.id}`,
        }))
      : [];
  const matchedProjects: QuickProject[] = projects
    ? rank(
        projects.filter((p) => p.name.toLowerCase().includes(needle)),
        (p) => p.name,
        needle,
      )
        // Active projects before archived ones.
        .sort((a, b) => Number(a.archived_at !== null) - Number(b.archived_at !== null))
        .slice(0, limit)
        .map((p) => ({ id: p.id, name: p.name, archived: p.archived_at !== null }))
    : [];
  const matchedPeople = people
    ? rank(
        people.filter((p) => p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle)),
        (p) => p.name,
        needle,
      ).slice(0, limit)
    : [];

  return { tasks, projects: matchedProjects, people: matchedPeople };
}

// Recently opened tasks and projects, newest first, keeping only what the person can still read.
export async function resolveRecents(refs: RecentRef[]): Promise<RecentItem[]> {
  if (!Array.isArray(refs) || !(await signedIn())) return [];
  const wanted = refs
    .filter((r) => r && (r.kind === "task" || r.kind === "project") && isUuid(r.id))
    .slice(0, MAX_RECENTS);
  if (wanted.length === 0) return [];
  const taskIds = wanted.filter((r) => r.kind === "task").map((r) => r.id);
  const supabase = await createClient();
  const [projects, taskResult] = await Promise.all([
    listReadableProjects(),
    taskIds.length
      ? supabase
          .from("tasks")
          .select("id, title, completed_at, home_project_id, root_task_id")
          .in("id", taskIds)
          .is("deleted_at", null)
      : null,
  ]);
  const projectsById = new Map(projects.map((p) => [p.id, p] as const));
  const tasks = taskResult && !taskResult.error ? taskResult.data ?? [] : [];

  // A task read through a project other than its home (multi-homed, or a subtask of such a task) is
  // labelled and opened with one of its own (its root's) memberships that RLS shows the person.
  const needOther = tasks.filter((t) => t.home_project_id && !projectsById.has(t.home_project_id));
  const otherProject = new Map<string, string>();
  if (needOther.length) {
    const roots = [...new Set(needOther.map((t) => t.root_task_id ?? t.id))];
    const memberships = await supabase
      .from("task_projects")
      .select("task_id, project_id")
      .in("task_id", roots)
      .is("deleted_at", null);
    for (const row of memberships.error ? [] : memberships.data ?? []) {
      if (projectsById.has(row.project_id) && !otherProject.has(row.task_id)) otherProject.set(row.task_id, row.project_id);
    }
  }
  const tasksById = new Map(tasks.map((t) => [t.id, t] as const));

  return wanted.flatMap((ref): RecentItem[] => {
    if (ref.kind === "project") {
      const project = projectsById.get(ref.id);
      return project ? [{ kind: "project", id: project.id, name: project.name, archived: project.archived_at !== null }] : [];
    }
    const task = tasksById.get(ref.id);
    if (!task) return [];
    const isPrivate = !task.home_project_id;
    const projectId = isPrivate
      ? null
      : projectsById.has(task.home_project_id!)
        ? task.home_project_id
        : (otherProject.get(task.root_task_id ?? task.id) ?? null);
    const project = projectId ? projectsById.get(projectId) : undefined;
    return [
      {
        kind: "task",
        id: task.id,
        title: task.title,
        completed: Boolean(task.completed_at),
        isPrivate,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        // A private task opens in My tasks, others in a readable project's pane; the Search page's pane
        // (which shows any readable task) is the fallback.
        href: isPrivate
          ? `/my-tasks?task=${task.id}`
          : project
            ? `/projects/${project.id}?task=${task.id}`
            : `/search?task=${task.id}`,
      },
    ];
  });
}

export async function loadMySettings(): Promise<MySettings | null> {
  return getMySettings();
}

// Projects the person can post a message in (Commenter+, active; an archived project caps everyone at
// Viewer), for Create → Message.
export async function loadMessageProjects(): Promise<{ id: string; name: string }[]> {
  if (!(await signedIn())) return [];
  const [projects, roles] = await Promise.all([listProjects(), listMyProjectRoles()]);
  return projects.filter((p) => hasRole(roles.get(p.id), "commenter")).map(({ id, name }) => ({ id, name }));
}

// What the New goal dialog needs, for Create → Goal.
export async function loadGoalDialog() {
  if (!(await signedIn())) return null;
  const [viewer, profiles, teams, goals, timeZone] = await Promise.all([
    getGoalViewer(),
    listProfiles(),
    listTeams(),
    listGoals(),
    getViewerTimeZone(),
  ]);
  return {
    viewer,
    people: profiles.map((p) => ({ id: p.id, name: displayName(p) })),
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
    goals,
    today: todayIn(timeZone),
  };
}
