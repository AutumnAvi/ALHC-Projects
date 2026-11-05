// Big move 1: the shell area's reads — what the app shell loads on demand (Asana parity, batch 1): the
// search palette's live results and recents, the "#" link picker's suggestions, the Settings modal, and the
// Create menu's dialogs. Every one runs with the caller's own context (the signed-in person's session,
// never the service role), so RLS decides what comes back: no task or project the person can't open is
// ever returned, workspace admins included. No Next.js here: configuration (the email switches, the reply
// domain) and the viewer's time zone come in as arguments.
import { getViewer } from "@/lib/api/auth/queries";
import { listMyCalendarFeeds } from "@/lib/api/calendar/queries";
import type { ApiContext } from "@/lib/api/core/context";
import { getGoalViewer, listGoals } from "@/lib/api/goals/queries";
import type { MySettings } from "@/lib/api/me/model";
import { getMyForwarding, getMySettings } from "@/lib/api/me/queries";
import { visibleTaskNumbers, visibleTaskPlaces } from "@/lib/api/numbers/queries";
import { listActivePeople, listProfiles } from "@/lib/api/people/queries";
import { listMyProjectRoles, listProjects, listReadableProjects, listStarredProjectIds } from "@/lib/api/projects/queries";
import { LINK_SEARCH_MAX_PROJECTS, LINK_SEARCH_MAX_TASKS, type SettingsEmailConfig } from "@/lib/api/shell/model";
import { listTeams } from "@/lib/api/teams/queries";
import { listProjectTemplates } from "@/lib/api/templates/queries";
import { isCalendarFeedScope, type CalendarFeed } from "@/lib/calendar-feeds";
import { fieldTypeLabel, isFieldType } from "@/lib/fields";
import { isUuid } from "@/lib/ids";
import { displayName } from "@/lib/people";
import { templateOutline, type TemplateOutline } from "@/lib/project-roles";
import { bareTaskTitle, numbersOf } from "@/lib/request-numbers";
import { hasRole, type ProjectRole } from "@/lib/roles";
import {
  EMPTY_RESULTS,
  MAX_RECENTS,
  isSearchKind,
  type EmailSetup,
  type ForwardingSetup,
  type QuickProject,
  type QuickResults,
  type QuickTask,
  type RecentItem,
  type RecentRef,
  type SearchKind,
} from "@/lib/shell";
import type { GalleryTemplate, TemplatePreview } from "@/lib/templates";
import { todayIn } from "@/lib/workload";

async function signedIn(ctx: ApiContext) {
  const { user, allowlisted } = await getViewer(ctx);
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
export async function quickSearch(ctx: ApiContext, query: string, only: SearchKind | null = null): Promise<QuickResults> {
  const q = typeof query === "string" ? query.trim().slice(0, 200) : "";
  if (!q || !(await signedIn(ctx))) return EMPTY_RESULTS;
  const kind = isSearchKind(only) ? only : null;
  const limit = kind ? 20 : 5;
  const needle = q.toLowerCase();
  const supabase = ctx.db;

  const [taskResult, projects, people] = await Promise.all([
    !kind || kind === "tasks" ? supabase.rpc("search_tasks", { query: q, max_results: limit }) : null,
    !kind || kind === "projects" ? listReadableProjects(ctx) : null,
    !kind || kind === "people" ? listActivePeople(ctx) : null,
  ]);

  const taskRows = taskResult && !taskResult.error ? (taskResult.data ?? []) : [];
  const taskNumbers = await visibleTaskNumbers(ctx, taskRows.map((task) => task.id));
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
export async function resolveRecents(ctx: ApiContext, refs: RecentRef[]): Promise<RecentItem[]> {
  if (!Array.isArray(refs) || !(await signedIn(ctx))) return [];
  const wanted = refs
    .filter((r) => r && (r.kind === "task" || r.kind === "project") && isUuid(r.id))
    .slice(0, MAX_RECENTS);
  if (wanted.length === 0) return [];
  const taskIds = wanted.filter((r) => r.kind === "task").map((r) => r.id);
  const supabase = ctx.db;
  const [projects, taskResult] = await Promise.all([
    listReadableProjects(ctx),
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
  const places = await visibleTaskPlaces(ctx, tasks.map((t) => t.id));
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

// Nov 4 notes (batch 25, 158): "#" alone (no query) in the link picker suggests before anything is typed,
// like "@" does for people: the tasks and projects this browser opened recently (ids only, resolved through
// RLS like the palette's recents), then the person's open tasks they were assigned most recently and their
// starred, then other active, projects. `userId` is the signed-in person (the caller checked the session).
export async function linkSuggestions(
  ctx: ApiContext,
  userId: string,
  recent: RecentRef[],
): Promise<{ tasks: QuickTask[]; projects: QuickProject[] }> {
  const supabase = ctx.db;
  const [assigned, projects, starred] = await Promise.all([
    supabase
      .from("tasks")
      .select("id")
      .eq("assignee_id", userId)
      .is("completed_at", null)
      .is("deleted_at", null)
      .order("assigned_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .limit(LINK_SEARCH_MAX_TASKS),
    listReadableProjects(ctx),
    listStarredProjectIds(ctx).catch(() => [] as string[]),
  ]);
  const recentTasks = recent.filter((r) => r.kind === "task");
  const taskRefs: RecentRef[] = [
    ...recentTasks,
    ...(assigned.error ? [] : (assigned.data ?? []))
      .filter((t) => !recentTasks.some((r) => r.id === t.id))
      .map((t) => ({ kind: "task" as const, id: t.id })),
  ];
  const recentProjects = recent.filter((r) => r.kind === "project");
  const resolved = await resolveRecents(ctx, [...taskRefs.slice(0, MAX_RECENTS - recentProjects.length), ...recentProjects]);
  const tasks = resolved.flatMap((r) => (r.kind === "task" ? [toQuickTask(r)] : [])).slice(0, LINK_SEARCH_MAX_TASKS);
  const recentProjectList = resolved.flatMap((r) => (r.kind === "project" ? [{ id: r.id, name: r.name, archived: r.archived }] : []));
  const seen = new Set(recentProjectList.map((p) => p.id));
  const starredSet = new Set(starred);
  const others = projects
    .filter((p) => p.archived_at === null && !seen.has(p.id))
    .sort((a, b) => Number(starredSet.has(b.id)) - Number(starredSet.has(a.id)))
    .map((p) => ({ id: p.id, name: p.name, archived: false }));
  return { tasks, projects: [...recentProjectList, ...others].slice(0, LINK_SEARCH_MAX_PROJECTS) };
}

function toQuickTask(item: QuickTask & { kind: "task" }): QuickTask {
  const { kind: _kind, ...task } = item;
  void _kind;
  return task;
}

// What the Settings modal loads when it opens (since Asana parity, batch 5), in one round trip: the
// person's own settings and what email can do in this workspace (configuration, plus the active projects
// they administer by their own role, where inbound webhooks are set up).
export async function loadSettings(
  ctx: ApiContext,
  config: SettingsEmailConfig,
): Promise<{ me: MySettings; email: EmailSetup } | null> {
  if (!(await signedIn(ctx))) return null;
  const [me, projects, roles] = await Promise.all([getMySettings(ctx), listProjects(ctx), listMyProjectRoles(ctx)]);
  if (!me) return null;
  const sending = config.sending;
  return {
    me,
    email: {
      sending,
      // Replies only come back when comment emails go out with a Reply-To address.
      replyByEmail: sending && config.inbound,
      // listProjects() is active projects only; an archived one caps everyone at Viewer anyway.
      inboundProjects: projects.flatMap((p) => (hasRole(roles.get(p.id), "admin") ? [{ id: p.id, name: p.name }] : [])),
      forwarding: await loadForwarding(ctx, config, projects, roles),
    },
  };
}

// Settings → Email forwarding: the person's address (made the first time they open Settings) once
// inbound email is set up here — the same Resend webhook as replies, plus what /api/inbound/email needs to
// read the message and write the task (RESEND_API_KEY, the service-role key: `config.forwarding`) — and the
// database update is applied.
async function loadForwarding(
  ctx: ApiContext,
  config: SettingsEmailConfig,
  projects: { id: string; name: string }[],
  roles: Map<string, ProjectRole>,
): Promise<ForwardingSetup> {
  if (!config.forwarding) {
    return { state: "not_configured" };
  }
  const forwarding = await getMyForwarding(ctx);
  if (!forwarding) return { state: "needs_update" };
  const names = new Map(projects.map((p) => [p.id, p.name] as const));
  return {
    state: "ready",
    address: config.forwardingAddress(forwarding.token),
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
export async function loadMessageProjects(ctx: ApiContext): Promise<{ id: string; name: string }[]> {
  if (!(await signedIn(ctx))) return [];
  const [projects, roles] = await Promise.all([listProjects(ctx), listMyProjectRoles(ctx)]);
  return projects.filter((p) => hasRole(roles.get(p.id), "commenter")).map(({ id, name }) => ({ id, name }));
}

// What the New goal dialog needs, for Create → Goal. `timeZone` is the viewer's (the adapter reads it).
export async function loadGoalDialog(ctx: ApiContext, timeZone: string) {
  if (!(await signedIn(ctx))) return null;
  const [viewer, profiles, teams, goals] = await Promise.all([
    getGoalViewer(ctx),
    listProfiles(ctx),
    listTeams(ctx),
    listGoals(ctx),
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
export async function loadProjectGallery(ctx: ApiContext): Promise<GalleryTemplate[] | null> {
  const { user, allowlisted } = await getViewer(ctx);
  if (!user || !allowlisted) return null;
  const templates = await listProjectTemplates(ctx);
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
export async function loadTemplatePreview(ctx: ApiContext, templateId: string): Promise<TemplatePreview | null> {
  if (!isUuid(templateId) || !(await signedIn(ctx))) return null;
  const supabase = ctx.db;
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

// Nov 2 notes (batch 14, 95): what a template holds, for "Customize before creating" — its sections, tasks,
// fields, and roles (from the template's snapshot, readable by everyone signed in) — and the people of the
// workspace who can fill its roles.
export async function loadTemplateOutline(
  ctx: ApiContext,
  templateId: string,
): Promise<{ outline: TemplateOutline; people: { id: string; name: string }[] } | null> {
  if (!isUuid(templateId) || !(await signedIn(ctx))) return null;
  const supabase = ctx.db;
  const [{ data }, people] = await Promise.all([
    supabase
      .from("project_templates")
      .select("sections:content->sections, tasks:content->tasks, fields:content->fields, roles:content->roles")
      .eq("id", templateId)
      .is("deleted_at", null)
      .maybeSingle(),
    listActivePeople(ctx),
  ]);
  if (!data) return null;
  return {
    outline: templateOutline({ sections: data.sections, tasks: data.tasks, fields: data.fields, roles: data.roles }),
    people: people.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// The "Sync to calendar" dialog (Real features 4): the person's live link for My tasks, a project, or a
// team (never the token: only its hint), and the name of what it covers, read with their own client.
// available = false on a database without the update.
export async function loadCalendarFeed(
  ctx: ApiContext,
  scope: string,
  targetId: string | null,
): Promise<{ available: boolean; feed: CalendarFeed | null; targetName: string | null } | null> {
  if (!(await signedIn(ctx)) || !isCalendarFeedScope(scope)) return null;
  if (scope !== "my_tasks" && !isUuid(targetId)) return null;
  const feeds = await listMyCalendarFeeds(ctx);
  if (!feeds) return { available: false, feed: null, targetName: null };
  const feed =
    feeds.find((f) => f.scope === scope && (scope === "my_tasks" || f.projectId === targetId || f.teamId === targetId)) ?? null;
  let targetName: string | null = scope === "my_tasks" ? "My tasks" : (feed?.targetName ?? null);
  if (!targetName && targetId) {
    const supabase = ctx.db;
    const row =
      scope === "project"
        ? (await supabase.from("projects").select("name").eq("id", targetId).is("deleted_at", null).maybeSingle()).data
        : (await supabase.from("teams").select("name").eq("id", targetId).is("deleted_at", null).maybeSingle()).data;
    targetName = row?.name ?? null;
  }
  return { available: true, feed, targetName };
}

// Settings → Calendar sync: every live link of the person's. Null on a database without the update.
export async function loadCalendarFeeds(ctx: ApiContext): Promise<CalendarFeed[] | null> {
  if (!(await signedIn(ctx))) return null;
  return listMyCalendarFeeds(ctx);
}

// Oct 26 notes (batch 4): a task the pane can't open may be in the Trash. Trashed tasks are readable only
// by Editors+ of one of their projects (RLS), who can also restore them, so a row here means "show
// Restore". Null for anything else (missing, or no access): the pane says Not found as before.
export async function loadTrashedTask(
  ctx: ApiContext,
  taskId: string,
): Promise<{ id: string; title: string; deletedAt: string } | null> {
  if (!(await signedIn(ctx)) || !isUuid(taskId)) return null;
  const supabase = ctx.db;
  const { data } = await supabase
    .from("tasks")
    .select("id, title, deleted_at")
    .eq("id", taskId)
    .not("deleted_at", "is", null)
    .maybeSingle();
  return data?.deleted_at ? { id: data.id, title: data.title, deletedAt: data.deleted_at } : null;
}
