// Big move 1: the screens area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { getViewer } from "../auth/queries";
import { hasMyTaskRulesV2, listMyTaskRules, listProjectRules } from "../automations/queries";
import { type ApiContext, read } from "../core/context";
import { rpcMissing } from "../core/db";
import { listProjectFields, listProjectFieldSharing } from "../fields/queries";
import { listProjectForms } from "../forms/queries";
import { goalsEnabled } from "../goals/queries";
import { inboxItemsFromPage, labelInboxWith } from "../inbox/model";
import { countUnreadInbox, listInbox } from "../inbox/queries";
import {
  getExpandedTaskIds,
  getHomeDashboard,
  getMyPersonalWorkWeek,
  getMyTasksChecked,
  getProfilePreferences,
  getSubtaskPreferences,
} from "../me/queries";
import { listAwaitingMyApproval, listMyTasks } from "../my-tasks/queries";
import { getRequestSequence } from "../numbers/queries";
import { listProfiles } from "../people/queries";
import {
  getProject,
  getProjectAccessStatus,
  getProjectRole,
  getProjectSectionsLocked,
  listEditableProjectsWithSections,
  listOwnProjectRoles,
  listProjectMembers,
  listReadableProjects,
  listSections,
  listSidebarFolders,
  listStarredProjectIds,
  listStatusTemplates,
} from "../projects/queries";
import {
  type HomeScreen,
  type LoadedAppShell,
  myTaskListsFromBundle,
  type MyTasksScreen,
  type ProjectViewPageData,
} from "./model";
import { listTags, tagsEnabled } from "../tags/queries";
import { requestLabelMap, sectionCountsFrom, taskGroupPagesFrom, withPageLabels } from "../tasks/model";
import { listProjectTaskPage, listSectionTaskCounts } from "../tasks/queries";
import { listTaskTemplates } from "../templates/queries";
import {
  getListCollapsedGroups,
  getListColumnWidths,
  getProjectShowCompleted,
  getProjectViewSettings,
  getViewPersonalConfig,
  listProjectViews,
} from "../views/queries";
import { getWorkspace, getWorkWeek, isWorkspaceAdmin } from "../workspace/queries";
import { parseHomeDashboard } from "../../home";
import { isUuid } from "../../ids";
import { withoutTeamMessages } from "../../inbox";
import { toMyTaskRule } from "../../my-task-rules";
import {
  type AppShell,
  archivedFirst,
  effectiveRoles,
  type MyTasksScreenPayload,
  parseAppShell,
  parseMyTaskBundle,
  parseProjectFrame,
  type ProjectFrame,
  type ProjectRow,
} from "../../screen-shapes";
import type { Json } from "../../supabase/database.types";
import type { ViewFilters, ViewSort } from "../../views";
import { WORKSPACE_ASSETS_BUCKET } from "../../workspace";

export const loadAppShell = read(async (ctx: ApiContext): Promise<LoadedAppShell> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("app_shell");
  let shell: AppShell;
  if (!result.error) shell = parseAppShell(result.data);
  else if (rpcMissing(result.error)) shell = await legacyAppShell(ctx);
  else throw new Error(`Failed to load the app: ${result.error.message}`);
  const logoPath = shell.workspace?.logoPath ?? null;
  return {
    ...shell,
    logoUrl: logoPath ? supabase.storage.from(WORKSPACE_ASSETS_BUCKET).getPublicUrl(logoPath).data.publicUrl : null,
  };
});

// The separate reads app_shell() replaces (a database without this release's update).
async function legacyAppShell(ctx: ApiContext): Promise<AppShell> {
  const [workspace, readable, starIds, unreadCount, admin, profiles, tags, tagsOn, folders, subtaskPrefs, goalsOn, ownRoles, workWeek, personalWorkWeek, prefs, expanded, checked] =
    await Promise.all([
      getWorkspace(ctx),
      listReadableProjects(ctx),
      listStarredProjectIds(ctx),
      countUnreadInbox(ctx),
      isWorkspaceAdmin(ctx),
      listProfiles(ctx),
      listTags(ctx),
      tagsEnabled(ctx),
      listSidebarFolders(ctx),
      getSubtaskPreferences(ctx),
      goalsEnabled(ctx),
      listOwnProjectRoles(ctx),
      getWorkWeek(ctx),
      getMyPersonalWorkWeek(ctx),
      getProfilePreferences(ctx),
      getExpandedTaskIds(ctx),
      getMyTasksChecked(ctx),
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

export const loadProjectFrame = read(async (ctx: ApiContext, projectId: string): Promise<ProjectFrame> => {
  if (!isUuid(projectId)) return legacyProjectFrame(ctx, projectId, false);
  const supabase = ctx.db;
  const result = await supabase.rpc("project_frame", { target_project: projectId });
  if (!result.error) return parseProjectFrame(result.data);
  if (rpcMissing(result.error)) return legacyProjectFrame(ctx, projectId, true);
  throw new Error(`Failed to load the project: ${result.error.message}`);
});

async function legacyProjectFrame(ctx: ApiContext, projectId: string, valid: boolean): Promise<ProjectFrame> {
  if (!valid) {
    return parseProjectFrame({ project: null, role: null, access_status: "missing", personal: {} });
  }
  const [project, views, role, taskTemplates, fields, forms, rules, members, sections, statusTemplates, numbering, viewSettings, sectionsLocked, fieldSharing, columnWidths, collapsedGroups, showCompleted] =
    await Promise.all([
      getProject(ctx, projectId),
      listProjectViews(ctx, projectId),
      getProjectRole(ctx, projectId),
      listTaskTemplates(ctx, projectId),
      listProjectFields(ctx, projectId),
      listProjectForms(ctx, projectId),
      listProjectRules(ctx, projectId),
      listProjectMembers(ctx, projectId),
      listSections(ctx, projectId),
      listStatusTemplates(ctx, projectId),
      getRequestSequence(ctx, projectId),
      getProjectViewSettings(ctx, projectId),
      getProjectSectionsLocked(ctx, projectId),
      listProjectFieldSharing(ctx, projectId).catch(() => null),
      getListColumnWidths(ctx, projectId),
      getListCollapsedGroups(ctx, projectId),
      getProjectShowCompleted(ctx, projectId),
    ]);
  const personalConfigs = new Map(
    (
      await Promise.all(
        views.filter((v) => v.ownerId === null).map(async (v) => [v.id, await getViewPersonalConfig(ctx, v.id)] as const),
      )
    ).flatMap(([id, config]) => (config ? [[id, config] as const] : [])),
  );
  return {
    project: project as ProjectRow | null,
    sectionsLocked,
    role,
    accessStatus: !project || !role ? await getProjectAccessStatus(ctx, projectId) : null,
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

export const loadProjectViewPage = read(
  async (
    ctx: ApiContext, projectId: string,
    filters: ViewFilters,
    timeZone: string,
    groupBy: string,
    sorts: ViewSort[],
    pageSize: number,
    limits: Record<string, number>,
  ): Promise<ProjectViewPageData> => {
    const supabase = ctx.db;
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
        listProjectTaskPage(ctx, projectId, filters, timeZone, groupBy, sorts, pageSize, limits),
        listSectionTaskCounts(ctx, projectId),
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

export const loadMyTasksScreen = read(async (ctx: ApiContext): Promise<MyTasksScreen> => {
  const { user } = await getViewer(ctx);
  const supabase = ctx.db;
  const loadedAt = Date.now();
  const [result, shell] = await Promise.all([supabase.rpc("my_tasks_screen"), loadAppShell(ctx)]);
  if (rpcMissing(result.error) || !user) return { ...(await legacyMyTasksScreen(ctx, user?.id ?? "")), loadedAt };
  if (result.error) throw new Error(`Failed to load my tasks: ${result.error.message}`);
  const data = (result.data ?? {}) as Partial<MyTasksScreenPayload>;
  const { numbers: _numbers, ...lists } = myTaskListsFromBundle(parseMyTaskBundle(data.tasks), shell.myRoles, user.id);
  void _numbers;
  return {
    ...lists,
    loadedAt,
    rules: Array.isArray(data.rules) ? data.rules.map(toMyTaskRule) : null,
    rulesV2: data.rules_v2 === true,
    editableSections: Array.isArray(data.editable_sections) ? data.editable_sections : [],
  };
});

async function legacyMyTasksScreen(ctx: ApiContext, userId: string): Promise<Omit<MyTasksScreen, "loadedAt">> {
  const [{ open, completed }, awaiting, rules, rulesV2, editable] = await Promise.all([
    listMyTasks(ctx, userId),
    listAwaitingMyApproval(ctx),
    listMyTaskRules(ctx),
    hasMyTaskRulesV2(ctx),
    listEditableProjectsWithSections(ctx, ""),
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

export const loadHomeScreen = read(async (ctx: ApiContext, timeZone: string): Promise<HomeScreen> => {
  const { user } = await getViewer(ctx);
  const supabase = ctx.db;
  const loadedAt = Date.now();
  const [result, shell] = await Promise.all([supabase.rpc("home_screen", { tz: timeZone }), loadAppShell(ctx)]);
  if (rpcMissing(result.error) || !user) return { ...(await legacyHomeScreen(ctx, user?.id ?? "", timeZone)), loadedAt };
  if (result.error) throw new Error(`Failed to load Home: ${result.error.message}`);
  const data = (result.data ?? {}) as { tasks?: Json; dashboard?: Json; inbox?: Json };
  const { numbers, ...lists } = myTaskListsFromBundle(parseMyTaskBundle(data.tasks), shell.myRoles, user.id);
  return {
    ...lists,
    loadedAt,
    dashboard: parseHomeDashboard(data.dashboard),
    inbox: labelInboxWith(withoutTeamMessages(inboxItemsFromPage(data.inbox ?? [])), numbers),
  };
});

async function legacyHomeScreen(ctx: ApiContext, userId: string, timeZone: string): Promise<Omit<HomeScreen, "loadedAt">> {
  const [{ open, completed }, awaiting, dashboard, inbox] = await Promise.all([
    listMyTasks(ctx, userId),
    listAwaitingMyApproval(ctx),
    getHomeDashboard(ctx, timeZone),
    listInbox(ctx, "activity"),
  ]);
  return { open, completed, awaiting, dashboard, inbox };
}
