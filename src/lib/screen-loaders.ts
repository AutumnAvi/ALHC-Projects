import "server-only";
// Nov 4 notes (batch 22, M1): one database call per screen. Each loader below is one RPC (shapes in
// screen-shapes.ts, SQL in supabase/migrations/20261104030000_nov4_batch22_a.sql), cached per request, so
// the app layout, a layout under it, and the page share the same promise:
//
//   loadAppShell()            app_shell()          every signed-in page's frame (layout + any page)
//   loadProjectFrame(id)      project_frame()      /projects/<id>/… (layout + its pages)
//   loadProjectViewPage(…)    project_view_page()  a List / Board page of cards
//   loadMyTasksScreen()       my_tasks_screen()    /my-tasks
//   loadHomeScreen(tz)        home_screen()        Home
//
// The functions are SECURITY INVOKER, so RLS decides exactly as for the separate reads they replace, and
// the rows are mapped with the same code (row-mappers.ts and the helpers exported from data.ts).
//
// The migration is applied after this code is deployed, so until then a loader whose function isn't
// there (PGRST202) falls back to the separate reads it replaced; nothing else changes.
import { cache } from "react";
import { getViewer } from "@/lib/auth";
import {
  accessFromRows,
  approvalRowState,
  assembleMyTasks,
  awaitingFrom,
  getExpandedTaskIds,
  getHomeDashboard,
  getMyPersonalWorkWeek,
  getMyTasksChecked,
  getProfilePreferences,
  getProject,
  getProjectAccessStatus,
  getProjectRole,
  getProjectSectionsLocked,
  getProjectShowCompleted,
  getProjectViewSettings,
  getRequestSequence,
  getListCollapsedGroups,
  getListColumnWidths,
  getSubtaskPreferences,
  getViewPersonalConfig,
  getWorkWeek,
  getWorkspace,
  goalsEnabled,
  hasMyTaskRulesV2,
  inboxItemsFromPage,
  isWorkspaceAdmin,
  countUnreadInbox,
  labelInboxWith,
  listAwaitingMyApproval,
  listEditableProjectsWithSections,
  listInbox,
  listMyTaskRules,
  listMyTasks,
  listOwnProjectRoles,
  listProfiles,
  listProjectFieldSharing,
  listProjectFields,
  listProjectForms,
  listProjectMembers,
  listProjectRules,
  listProjectTaskPage,
  listProjectViews,
  listReadableProjects,
  listSectionTaskCounts,
  listSections,
  listSidebarFolders,
  listStarredProjectIds,
  listStatusTemplates,
  listTags,
  listTaskTemplates,
  myTaskExtrasFrom,
  myTasksFromCards,
  numbersFromPlaces,
  placesFromLabels,
  requestLabelMap,
  sectionCountsFrom,
  tagsEnabled,
  taskGroupPagesFrom,
  withPageLabels,
  type ApprovalRowState,
  type AwaitingApproval,
  type InboxItem,
  type MyTask,
  type ProjectTaskGroupPage,
} from "@/lib/data";
import type { HomeDashboard } from "@/lib/home";
import { parseHomeDashboard } from "@/lib/home";
import { withoutTeamMessages } from "@/lib/inbox";
import type { MyTaskRule, MyTaskRuleContext } from "@/lib/my-task-rules";
import { toMyTaskRule } from "@/lib/my-task-rules";
import { hasRole, type ProjectRole } from "@/lib/roles";
import {
  effectiveRoles,
  parseAppShell,
  parseMyTaskBundle,
  parseProjectFrame,
  archivedFirst,
  type AppShell,
  type MyTaskBundle,
  type MyTasksScreenPayload,
  type ProjectFrame,
  type ProjectRow,
} from "@/lib/screen-shapes";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { WORKSPACE_ASSETS_BUCKET } from "@/lib/workspace";
import { isUuid } from "@/lib/ids";
import type { ViewFilters, ViewSort } from "@/lib/views";

export type { AppShell, ProjectFrame } from "@/lib/screen-shapes";

function rpcMissing(error: { code?: string } | null | undefined) {
  return error?.code === "PGRST202" || error?.code === "42883";
}

// ---------------------------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------------------------

export type LoadedAppShell = AppShell & { logoUrl: string | null };

export const loadAppShell = cache(async (): Promise<LoadedAppShell> => {
  const supabase = await createClient();
  const result = await supabase.rpc("app_shell");
  let shell: AppShell;
  if (!result.error) shell = parseAppShell(result.data);
  else if (rpcMissing(result.error)) shell = await legacyAppShell();
  else throw new Error(`Failed to load the app: ${result.error.message}`);
  const logoPath = shell.workspace?.logoPath ?? null;
  return {
    ...shell,
    logoUrl: logoPath ? supabase.storage.from(WORKSPACE_ASSETS_BUCKET).getPublicUrl(logoPath).data.publicUrl : null,
  };
});

// The separate reads app_shell() replaces (a database without this release's update).
async function legacyAppShell(): Promise<AppShell> {
  const [workspace, readable, starIds, unreadCount, admin, profiles, tags, tagsOn, folders, subtaskPrefs, goalsOn, ownRoles, workWeek, personalWorkWeek, prefs, expanded, checked] =
    await Promise.all([
      getWorkspace(),
      listReadableProjects(),
      listStarredProjectIds(),
      countUnreadInbox(),
      isWorkspaceAdmin(),
      listProfiles(),
      listTags(),
      tagsEnabled(),
      listSidebarFolders(),
      getSubtaskPreferences(),
      goalsEnabled(),
      listOwnProjectRoles(),
      getWorkWeek(),
      getMyPersonalWorkWeek(),
      getProfilePreferences(),
      getExpandedTaskIds(),
      getMyTasksChecked(),
    ]);
  return {
    workspace: workspace
      ? {
          id: workspace.id,
          name: workspace.name,
          defaultTeamId: workspace.defaultTeamId,
          logoPath: workspace.logoPath,
          emailSenderName: workspace.emailSenderName,
        }
      : null,
    isWorkspaceAdmin: admin,
    unreadCount,
    readableProjects: readable,
    projects: readable.filter((p) => p.archived_at === null),
    archivedProjects: archivedFirst(readable),
    ownRoles,
    myRoles: effectiveRoles(ownRoles, readable),
    starIds,
    folders,
    subtaskPrefs,
    openPersonalView: prefs.openPersonalView,
    expandedTaskIds: expanded,
    myTasksChecked: checked,
    personalWorkWeek: personalWorkWeek ?? null,
    workWeek,
    profiles,
    avatars: Object.fromEntries(profiles.flatMap((p) => (p.avatar_url ? [[p.id, p.avatar_url]] : []))),
    tags,
    visibleTags: tagsOn ? tags : [],
    tagsEnabled: tagsOn,
    goalsEnabled: goalsOn,
  };
}

// ---------------------------------------------------------------------------------------------
// Project frame
// ---------------------------------------------------------------------------------------------

export const loadProjectFrame = cache(async (projectId: string): Promise<ProjectFrame> => {
  if (!isUuid(projectId)) return legacyProjectFrame(projectId, false);
  const supabase = await createClient();
  const result = await supabase.rpc("project_frame", { target_project: projectId });
  if (!result.error) return parseProjectFrame(result.data);
  if (rpcMissing(result.error)) return legacyProjectFrame(projectId, true);
  throw new Error(`Failed to load the project: ${result.error.message}`);
});

async function legacyProjectFrame(projectId: string, valid: boolean): Promise<ProjectFrame> {
  if (!valid) {
    return parseProjectFrame({ project: null, role: null, access_status: "missing", personal: {} });
  }
  const [project, views, role, taskTemplates, fields, forms, rules, members, sections, statusTemplates, numbering, viewSettings, sectionsLocked, fieldSharing, columnWidths, collapsedGroups, showCompleted] =
    await Promise.all([
      getProject(projectId),
      listProjectViews(projectId),
      getProjectRole(projectId),
      listTaskTemplates(projectId),
      listProjectFields(projectId),
      listProjectForms(projectId),
      listProjectRules(projectId),
      listProjectMembers(projectId),
      listSections(projectId),
      listStatusTemplates(projectId),
      getRequestSequence(projectId),
      getProjectViewSettings(projectId),
      getProjectSectionsLocked(projectId),
      listProjectFieldSharing(projectId).catch(() => null),
      getListColumnWidths(projectId),
      getListCollapsedGroups(projectId),
      getProjectShowCompleted(projectId),
    ]);
  const personalConfigs = new Map(
    (
      await Promise.all(
        views.filter((v) => v.ownerId === null).map(async (v) => [v.id, await getViewPersonalConfig(v.id)] as const),
      )
    ).flatMap(([id, config]) => (config ? [[id, config] as const] : [])),
  );
  return {
    project: project as ProjectRow | null,
    sectionsLocked,
    role,
    accessStatus: !project || !role ? await getProjectAccessStatus(projectId) : null,
    views,
    viewSettings,
    taskTemplates,
    fields,
    fieldSharing: fieldSharing ?? {},
    forms,
    rules,
    members,
    sections,
    statusTemplates,
    numbering,
    columnWidths,
    collapsedGroups,
    showCompleted,
    personalConfigs,
  };
}

// ---------------------------------------------------------------------------------------------
// List / Board page
// ---------------------------------------------------------------------------------------------

export type ProjectViewPageData = {
  // Null on a database without project_task_card_page (the page then reads every card).
  pages: ProjectTaskGroupPage[] | null;
  sectionCounts: Record<string, number> | null;
};

export const loadProjectViewPage = cache(
  async (
    projectId: string,
    filters: ViewFilters,
    timeZone: string,
    groupBy: string,
    sorts: ViewSort[],
    pageSize: number,
    limits: Record<string, number>,
  ): Promise<ProjectViewPageData> => {
    const supabase = await createClient();
    const result = await supabase.rpc("project_view_page", {
      target_project: projectId,
      filters: filters as Json,
      tz: timeZone,
      group_by: groupBy,
      sorts: sorts as Json,
      page_size: pageSize,
      limits: limits as Json,
    });
    if (rpcMissing(result.error)) {
      const [pages, sectionCounts] = await Promise.all([
        listProjectTaskPage(projectId, filters, timeZone, groupBy, sorts, pageSize, limits),
        listSectionTaskCounts(projectId),
      ]);
      return { pages, sectionCounts };
    }
    if (result.error) throw new Error(`Failed to load tasks: ${result.error.message}`);
    const data = (result.data ?? {}) as { page?: Json; labels?: Json; section_counts?: Json };
    return {
      pages: withPageLabels(taskGroupPagesFrom(data.page), requestLabelMap(data.labels)),
      sectionCounts: sectionCountsFrom(data.section_counts),
    };
  },
);

// ---------------------------------------------------------------------------------------------
// My tasks and Home
// ---------------------------------------------------------------------------------------------

export type MyTaskLists = { open: MyTask[]; completed: MyTask[]; awaiting: AwaitingApproval[] };

// my_task_bundle() → the rows labelMyTasks and listAwaitingMyApproval build, with the same code.
export function myTaskListsFromBundle(bundle: MyTaskBundle, roles: Map<string, ProjectRole>, userId: string) {
  const page = myTasksFromCards(bundle.cards);
  const places = placesFromLabels(bundle.labels);
  const numbers = numbersFromPlaces(places);
  const mine = [...page.open, ...page.completed].map((task) => task.id);
  const access = accessFromRows(mine, bundle.accessTasks, bundle.accessMemberships, roles, userId);
  const openIds = new Set(page.open.map((task) => task.id));
  const states = new Map<string, ApprovalRowState>();
  const stateMap = bundle.approvalStates && typeof bundle.approvalStates === "object" && !Array.isArray(bundle.approvalStates)
    ? bundle.approvalStates
    : {};
  for (const [taskId, value] of Object.entries(stateMap)) states.set(taskId, approvalRowState(value));
  const roots = bundle.accessTasks.filter((t) => openIds.has(t.id) && t.root_task_id !== null);
  const extras = page.open.length
    ? myTaskExtrasFrom(bundle.blockerCounts, bundle.children, states, roots)
    : new Map<string, Partial<MyTask>>();
  const lists = assembleMyTasks(page, numbers, access, extras);
  const { requests, tasks, rounds } = bundle.awaiting;
  const awaitingIds = [...new Set(requests.map((r) => r.task_id))];
  const awaiting = requests.length
    ? awaitingFrom(requests, tasks, rounds, places, accessFromRows(awaitingIds, bundle.accessTasks, bundle.accessMemberships, roles, userId))
    : [];
  return { ...lists, awaiting, numbers };
}

export type MyTasksScreen = MyTaskLists & {
  rules: MyTaskRule[] | null;
  rulesV2: boolean;
  editableSections: MyTasksScreenPayload["editable_sections"];
};

export const loadMyTasksScreen = cache(async (): Promise<MyTasksScreen> => {
  const { user } = await getViewer();
  const supabase = await createClient();
  const [result, shell] = await Promise.all([supabase.rpc("my_tasks_screen"), loadAppShell()]);
  if (rpcMissing(result.error) || !user) return legacyMyTasksScreen(user?.id ?? "");
  if (result.error) throw new Error(`Failed to load my tasks: ${result.error.message}`);
  const data = (result.data ?? {}) as Partial<MyTasksScreenPayload>;
  const { numbers: _numbers, ...lists } = myTaskListsFromBundle(parseMyTaskBundle(data.tasks), shell.myRoles, user.id);
  void _numbers;
  return {
    ...lists,
    rules: Array.isArray(data.rules) ? data.rules.map(toMyTaskRule) : null,
    rulesV2: data.rules_v2 === true,
    editableSections: Array.isArray(data.editable_sections) ? data.editable_sections : [],
  };
});

async function legacyMyTasksScreen(userId: string): Promise<MyTasksScreen> {
  const [{ open, completed }, awaiting, rules, rulesV2, editable] = await Promise.all([
    listMyTasks(userId),
    listAwaitingMyApproval(),
    listMyTaskRules(),
    hasMyTaskRulesV2(),
    listEditableProjectsWithSections(""),
  ]);
  return {
    open,
    completed,
    awaiting,
    rules,
    rulesV2,
    editableSections: editable.flatMap((p, i) =>
      p.sections.map((s, j) => ({ id: s.id, name: s.name, project_id: p.id, sort_order: i * 1e6 + j })),
    ),
  };
}

// The My Tasks automation builder's context (loadMyTaskRuleContext), from the shell and My tasks' call.
export function myTaskRuleContextFrom(
  sections: { id: string; name: string }[],
  shell: AppShell,
  screen: Pick<MyTasksScreen, "editableSections" | "rulesV2">,
): MyTaskRuleContext {
  // listEditableProjectsWithSections(""): active projects where the person is an Editor+, first 100.
  const editable = shell.projects.filter((p) => hasRole(shell.myRoles.get(p.id) ?? null, "editor")).slice(0, 100);
  return {
    sections: sections.map((s) => ({ id: s.id, name: s.name })),
    projects: shell.projects.map((p) => ({ id: p.id, name: p.name })),
    workWeek: shell.workWeek,
    personalWorkWeek: shell.personalWorkWeek,
    people: shell.profiles.map((p) => ({ id: p.id, name: p.full_name?.trim() || p.email })),
    tags: shell.tags.map((t) => ({ id: t.id, name: t.name, color: t.color, archived: t.archivedAt !== null })),
    tagsEnabled: shell.tagsEnabled,
    editableProjects: editable.map((p) => ({
      id: p.id,
      name: p.name,
      sections: screen.editableSections.filter((s) => s.project_id === p.id).map((s) => ({ id: s.id, name: s.name })),
    })),
    v2: screen.rulesV2,
  };
}

export type HomeScreen = MyTaskLists & { dashboard: HomeDashboard; inbox: InboxItem[] };

export const loadHomeScreen = cache(async (timeZone: string): Promise<HomeScreen> => {
  const { user } = await getViewer();
  const supabase = await createClient();
  const [result, shell] = await Promise.all([supabase.rpc("home_screen", { tz: timeZone }), loadAppShell()]);
  if (rpcMissing(result.error) || !user) return legacyHomeScreen(user?.id ?? "", timeZone);
  if (result.error) throw new Error(`Failed to load Home: ${result.error.message}`);
  const data = (result.data ?? {}) as { tasks?: Json; dashboard?: Json; inbox?: Json };
  const { numbers, ...lists } = myTaskListsFromBundle(parseMyTaskBundle(data.tasks), shell.myRoles, user.id);
  return {
    ...lists,
    dashboard: parseHomeDashboard(data.dashboard),
    inbox: labelInboxWith(withoutTeamMessages(inboxItemsFromPage(data.inbox ?? [])), numbers),
  };
});

async function legacyHomeScreen(userId: string, timeZone: string): Promise<HomeScreen> {
  const [{ open, completed }, awaiting, dashboard, inbox] = await Promise.all([
    listMyTasks(userId),
    listAwaitingMyApproval(),
    getHomeDashboard(timeZone),
    listInbox("activity"),
  ]);
  return { open, completed, awaiting, dashboard, inbox };
}

