"use server";

// Reads the app shell loads on demand (Asana parity, batch 1): the search palette's live results and
// recents, the Settings modal, and the Create menu's dialogs. Every one runs with the signed-in person's
// own Supabase client (cookies), never the service role, so RLS decides what comes back: no task or
// project the person can't open is ever returned, workspace admins included.

import { displayName } from "@/components/avatar";
import { bareTaskTitle, numbersOf } from "@/lib/request-numbers";
import { getViewer } from "@/lib/auth";
import {
  getGoalViewer,
  getMyForwarding,
  getMySettings,
  hasReal1Schema,
  listActivePeople,
  listGoals,
  listMyProjectRoles,
  listProfiles,
  visibleTaskNumbers,
  visibleTaskPlaces,
  listProjects,
  listProjectTemplates,
  listReadableProjects,
  listMyCalendarFeeds,
  listTeams,
  type MySettings,
} from "@/lib/data";
import { isCalendarFeedScope, type CalendarFeed } from "@/lib/calendar-feeds";
import { isEmailConfigured } from "@/lib/email";
import { forwardingAddress, isInboundEmailConfigured } from "@/lib/email-reply";
import { fieldTypeLabel, isFieldType } from "@/lib/fields";
import type { GalleryTemplate, TemplatePreview } from "@/lib/templates";
import { isUuid } from "@/lib/ids";
import { hasRole, type ProjectRole } from "@/lib/roles";
import {
  EMPTY_RESULTS,
  MAX_RECENTS,
  isSearchKind,
  type QuickProject,
  type QuickResults,
  type QuickTask,
  type RecentItem,
  type EmailSetup,
  type ForwardingSetup,
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
    !kind || kind === "people" ? listActivePeople() : null,
  ]);

  const taskRows = taskResult && !taskResult.error ? (taskResult.data ?? []) : [];
  const taskNumbers = await visibleTaskNumbers(taskRows.map((task) => task.id));
  const tasks: QuickTask[] = taskRows.map((t) => {
    const numbers = taskNumbers.get(t.id) ?? [];
    const label = numbers[0]?.label ?? null;
    return {
      id: t.id,
      title: bareTaskTitle(t.title, label),
      label,
      numbers,
      completed: Boolean(t.completed_at),
      // search_tasks names each project task with the first project it was added to that the person can
      // read (its home_project_* columns; Oct 29 notes, 55b: there's no home project); null = private.
      isPrivate: !t.home_project_id,
      projectId: t.home_project_id,
      projectName: t.home_project_name,
      href: t.home_project_id ? `/projects/${t.home_project_id}?task=${t.id}` : `/my-tasks?task=${t.id}`,
    };
  });
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
          .select("id, title, completed_at, home_project_id")
          .in("id", taskIds)
          .is("deleted_at", null)
      : null,
  ]);
  const projectsById = new Map(projects.map((p) => [p.id, p] as const));
  const tasks = taskResult && !taskResult.error ? taskResult.data ?? [] : [];
  // Every project of each task the person can read, in the order it was added to them (Oct 29 notes, 55b:
  // no home project): the first one labels and opens it, and its numbers are the badges.
  const places = await visibleTaskPlaces(tasks.map((t) => t.id));
  const tasksById = new Map(tasks.map((t) => [t.id, t] as const));

  return wanted.flatMap((ref): RecentItem[] => {
    if (ref.kind === "project") {
      const project = projectsById.get(ref.id);
      return project ? [{ kind: "project", id: project.id, name: project.name, archived: project.archived_at !== null }] : [];
    }
    const task = tasksById.get(ref.id);
    if (!task) return [];
    const isPrivate = !task.home_project_id;
    const place = places.get(task.id) ?? [];
    const projectId = isPrivate ? null : (place.find((p) => projectsById.has(p.projectId))?.projectId ?? null);
    const project = projectId ? projectsById.get(projectId) : undefined;
    const numbers = numbersOf(place);
    const label = numbers[0]?.label ?? null;
    return [
      {
        kind: "task",
        id: task.id,
        title: bareTaskTitle(task.title, label),
        label,
        numbers,
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

// What the Settings modal loads when it opens (since Asana parity, batch 5), in one round trip: the
// person's own settings and what email can do in this workspace (configuration, plus the active projects
// they administer by their own role, where inbound webhooks are set up).
export async function loadSettings(): Promise<{ me: MySettings; email: EmailSetup } | null> {
  if (!(await signedIn())) return null;
  const [me, projects, roles] = await Promise.all([getMySettings(), listProjects(), listMyProjectRoles()]);
  if (!me) return null;
  const sending = isEmailConfigured();
  return {
    me,
    email: {
      sending,
      // Replies only come back when comment emails go out with a Reply-To address.
      replyByEmail: sending && isInboundEmailConfigured(),
      // listProjects() is active projects only; an archived one caps everyone at Viewer anyway.
      inboundProjects: projects.flatMap((p) => (hasRole(roles.get(p.id), "admin") ? [{ id: p.id, name: p.name }] : [])),
      forwarding: await loadForwarding(projects, roles),
    },
  };
}

// Settings → Email forwarding: the person's address (made the first time they open Settings) once
// inbound email is set up here — the same Resend webhook as replies, plus what /api/inbound/email needs to
// read the message and write the task (RESEND_API_KEY, the service-role key) — and the database update is
// applied.
async function loadForwarding(
  projects: { id: string; name: string }[],
  roles: Map<string, ProjectRole>,
): Promise<ForwardingSetup> {
  if (!isInboundEmailConfigured() || !process.env.RESEND_API_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { state: "not_configured" };
  }
  if (!(await hasReal1Schema())) return { state: "needs_update" };
  const forwarding = await getMyForwarding();
  if (!forwarding) return { state: "needs_update" };
  const names = new Map(projects.map((p) => [p.id, p.name] as const));
  return {
    state: "ready",
    address: forwardingAddress(forwarding.token),
    defaultProjectId: forwarding.defaultProjectId,
    projects: projects.flatMap((p) => (hasRole(roles.get(p.id), "editor") ? [{ id: p.id, name: p.name }] : [])),
    recent: forwarding.recent.map((f) => ({
      id: f.id,
      status: f.status === "created" ? "created" : "rejected",
      reason: f.reason,
      taskId: f.taskId,
      taskTitle: f.taskId ? (forwarding.taskTitles.get(f.taskId) ?? null) : null,
      projectId: f.projectId,
      projectName: f.projectId ? (names.get(f.projectId) ?? null) : null,
      attachments: f.attachments,
      createdAt: f.createdAt,
    })),
  };
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

// The New project gallery (Asana parity, batch 4): every workspace template (templates are readable by
// everyone allowlisted), with "mine" for the ones the person saved.
export async function loadProjectGallery(): Promise<GalleryTemplate[] | null> {
  const { user, allowlisted } = await getViewer();
  if (!user || !allowlisted) return null;
  const templates = await listProjectTemplates();
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    summary: t.summary,
    isExample: t.isExample,
    mine: t.createdBy === user.id,
    createdByName: t.createdByName,
    sourceProjectName: t.sourceProject?.name ?? null,
  }));
}

const PREVIEW_TASKS = 4;

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// What a template holds, for the gallery's preview: its sections with their first few task titles, and
// its fields. Read with the person's own client (templates are workspace-level).
export async function loadTemplatePreview(templateId: string): Promise<TemplatePreview | null> {
  if (!isUuid(templateId) || !(await signedIn())) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("project_templates")
    .select("sections:content->sections, tasks:content->tasks, fields:content->fields")
    .eq("id", templateId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const list = (value: unknown) =>
    (Array.isArray(value) ? value : []).filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  const sections = list(data.sections).map((s) => ({ id: textOf(s.id), name: textOf(s.name) ?? "Untitled section" }));
  const bySection = new Map<string | null, string[]>();
  for (const task of list(data.tasks)) {
    const title = textOf(task.title);
    if (!title) continue;
    const key = textOf(task.section_id);
    const titles = bySection.get(key) ?? [];
    titles.push(title);
    bySection.set(key, titles);
  }
  const group = (titles: string[] = []) => ({ tasks: titles.slice(0, PREVIEW_TASKS), more: Math.max(titles.length - PREVIEW_TASKS, 0) });
  const known = new Set(sections.map((s) => s.id));
  const loose = [...bySection.entries()].filter(([key]) => !key || !known.has(key)).flatMap(([, titles]) => titles);
  return {
    sections: sections.map((s) => ({ name: s.name, ...group(s.id ? bySection.get(s.id) : []) })),
    unsectioned: loose.length ? group(loose) : null,
    fields: list(data.fields).flatMap((f) => {
      const name = textOf(f.name);
      if (!name || !isFieldType(f.field_type)) return [];
      return [{ name, type: fieldTypeLabel({ fieldType: f.field_type, boundToSections: f.bound_to_sections === true }) }];
    }),
  };
}

// The "Sync to calendar" dialog (Real features 4): the person's live link for My tasks, a project, or a
// team (never the token: only its hint), and the name of what it covers, read with their own client.
// available = false on a database without the update.
export async function loadCalendarFeed(
  scope: string,
  targetId: string | null,
): Promise<{ available: boolean; feed: CalendarFeed | null; targetName: string | null } | null> {
  if (!(await signedIn()) || !isCalendarFeedScope(scope)) return null;
  if (scope !== "my_tasks" && !isUuid(targetId)) return null;
  const feeds = await listMyCalendarFeeds();
  if (!feeds) return { available: false, feed: null, targetName: null };
  const feed =
    feeds.find((f) => f.scope === scope && (scope === "my_tasks" || f.projectId === targetId || f.teamId === targetId)) ?? null;
  let targetName: string | null = scope === "my_tasks" ? "My tasks" : (feed?.targetName ?? null);
  if (!targetName && targetId) {
    const supabase = await createClient();
    const row =
      scope === "project"
        ? (await supabase.from("projects").select("name").eq("id", targetId).is("deleted_at", null).maybeSingle()).data
        : (await supabase.from("teams").select("name").eq("id", targetId).is("deleted_at", null).maybeSingle()).data;
    targetName = row?.name ?? null;
  }
  return { available: true, feed, targetName };
}

// Settings → Calendar sync: every live link of the person's. Null on a database without the update.
export async function loadCalendarFeeds(): Promise<CalendarFeed[] | null> {
  if (!(await signedIn())) return null;
  return listMyCalendarFeeds();
}

// Oct 26 notes (batch 4): a task the pane can't open may be in the Trash. Trashed tasks are readable only
// by Editors+ of one of their projects (RLS), who can also restore them, so a row here means "show
// Restore". Null for anything else (missing, or no access): the pane says Not found as before.
export async function loadTrashedTask(taskId: string): Promise<{ id: string; title: string; deletedAt: string } | null> {
  if (!(await signedIn()) || !isUuid(taskId)) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("tasks")
    .select("id, title, deleted_at")
    .eq("id", taskId)
    .not("deleted_at", "is", null)
    .maybeSingle();
  return data?.deleted_at ? { id: data.id, title: data.title, deletedAt: data.deleted_at } : null;
}
