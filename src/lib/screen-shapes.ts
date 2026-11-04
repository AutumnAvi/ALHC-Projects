// Nov 4 notes (batch 22, M1): the JSON the screen loader functions return (supabase/migrations/
// 20261104030000_nov4_batch22_a.sql) and the pure code that turns it into the app's types. One database
// call per screen: viewer_member(), app_shell(), project_frame(), project_view_page(), my_task_bundle() /
// my_tasks_screen(), home_screen(). The payload types are the contract for any client that calls these
// functions directly (the desktop and phone apps to come): each object has "version": 1, row objects use
// the tables' own column names, and keys are only ever added.
//
// No server-only imports, so the unit tests read these too. The mapping is the same code the per-table
// reads in data.ts use (row-mappers.ts, toRuleDef, toTag, toStatusTemplate, …), so a screen shows the
// same data whichever way it was read.
import type { ProjectAccessStatus } from "@/lib/access-requests";
import { parseAccessStatus } from "@/lib/access-requests";
import { DEFAULT_CHECKED_MODE, isCheckedMode, type CheckedMode } from "@/lib/checklist";
import { parseColumnWidths, type ColumnWidths } from "@/lib/column-widths";
import type { FieldDef, FieldSharing } from "@/lib/fields";
import type { FormDef } from "@/lib/forms";
import type { TaskNumbering } from "@/lib/request-numbers";
import { isProjectRole, type ProjectRole } from "@/lib/roles";
import {
  numberingFromRow,
  toFieldDef,
  toFormDef,
  toProjectView,
  toTaskTemplate,
  type TaskTemplate,
  type TaskTemplateRow,
} from "@/lib/row-mappers";
import { toRuleDef, type RuleDef } from "@/lib/rules";
import type { SidebarFolderState } from "@/lib/sidebar-folders";
import { toStatusTemplate, type StatusTemplate } from "@/lib/status-templates";
import { DEFAULT_SUBTASK_PREFS, parseSubtaskPrefs, type SubtaskPrefs } from "@/lib/subtask-view";
import type { Json, Tables } from "@/lib/supabase/database.types";
import { toTag, type Tag } from "@/lib/tags";
import {
  isFixedTab,
  NO_VIEW_SETTINGS,
  parseViewConfig,
  type ProjectView,
  type ProjectViewSettings,
  type ViewConfig,
} from "@/lib/views";
import { DEFAULT_WORK_WEEK, normalizeWorkWeek } from "@/lib/workdays";

export const SCREEN_PAYLOAD_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Payloads (what the database returns)
// ---------------------------------------------------------------------------------------------

export type ViewerMemberPayload = {
  version: 1;
  id: string | null;
  allowlisted: boolean;
  profile: { full_name: string | null; avatar_url: string | null } | null;
};

export type ProjectRow = Pick<
  Tables<"projects">,
  | "id"
  | "name"
  | "description"
  | "sort_order"
  | "approval_completes_task"
  | "status"
  | "status_note"
  | "status_updated_at"
  | "status_updated_by"
  | "archived_at"
  | "team_id"
  | "visibility"
>;

export type ProfileRow = Pick<Tables<"profiles">, "id" | "email" | "full_name" | "avatar_url">;

export type TagRow = {
  id: string;
  name: string;
  color: string;
  palette_color: string | null;
  archived_at: string | null;
  created_by: string | null;
};

export type AppShellPayload = {
  version: 1;
  workspace: {
    id: string;
    name: string;
    default_team_id: string | null;
    logo_path: string | null;
    email_sender_name: string | null;
    tags_enabled: boolean | null;
    goals_enabled: boolean | null;
    work_week: number[] | null;
  } | null;
  is_workspace_admin: boolean;
  unread_count: number;
  projects: ProjectRow[];
  own_roles: { project_id: string; role: string }[];
  star_ids: string[];
  folders: { id: string; name: string; collapsed: boolean; sort_order: number }[];
  folder_placements: { project_id: string; folder_id: string; sort_order: number }[];
  preferences: {
    subtask_hide_completed: boolean | null;
    subtask_assigned_to_me: boolean | null;
    subtask_sort: string | null;
    open_personal_view: boolean | null;
    expanded_task_ids: string[] | null;
    my_tasks_checked: string | null;
    work_week: number[] | null;
  } | null;
  profiles: ProfileRow[];
  tags: TagRow[];
};

export type SectionRow = { id: string; project_id: string; name: string; sort_order: number };

export type ProjectFramePayload = {
  version: 1;
  project: (ProjectRow & { sections_locked: boolean | null }) | null;
  role: string | null;
  access_status: string | null;
  views: Tables<"project_views">[];
  view_settings: { default_view_id: string | null; hidden_tabs: string[] | null; hidden_view_ids: string[] | null } | null;
  task_templates: TaskTemplateRow[];
  fields: Tables<"custom_fields">[];
  field_sharing: {
    field_id: string;
    library_field_id: string | null;
    is_source: boolean;
    is_shared: boolean;
    placement_count: number;
    definition_editable: boolean;
    definition_manageable: boolean;
  }[];
  forms: (Tables<"forms"> & { submission_count: number; last_submitted_at: string | null })[];
  rules: Parameters<typeof toRuleDef>[0][];
  members: {
    profile_id: string;
    role: string;
    created_at: string;
    profile: { email: string; full_name: string | null; avatar_url: string | null };
  }[];
  sections: SectionRow[];
  status_templates: Parameters<typeof toStatusTemplate>[0][];
  numbering: Omit<Parameters<typeof numberingFromRow>[0], "advanced"> | null;
  personal: {
    column_widths: Json | null;
    collapsed_groups: string[] | null;
    show_completed: boolean | null;
    view_configs: { view_id: string; config: Json }[];
  };
};

export type ProjectViewPagePayload = {
  version: 1;
  // project_task_card_page's own object ({ groups: [...] }).
  page: Json;
  // { task id: label } from task_request_labels_in.
  labels: Json;
  // { section id: count } from project_section_task_counts.
  section_counts: Json;
};

export type MyTaskBundlePayload = {
  version: 1;
  // my_task_cards()'s own object ({ open: [...], completed: [...] }).
  cards: Json;
  // task_project_labels()'s own object ({ task id: [place] }).
  labels: Json;
  access_tasks: AccessTaskRow[];
  access_memberships: { task_id: string; project_id: string }[];
  blocker_counts: Json;
  children: { parent_task_id: string | null; completed_at: string | null }[];
  approval_states: Json;
  awaiting: {
    requests: { id: string; task_id: string; round_id: string | null; created_at: string }[];
    tasks: { id: string; title: string; kind: string; due_on: string | null; completed_at: string | null }[];
    rounds: { id: string; status: string; due_on: string | null; round_number: number }[];
  };
};

export type AccessTaskRow = {
  id: string;
  root_task_id: string | null;
  home_project_id: string | null;
  created_by: string | null;
  assignee_id: string | null;
};

export type MyTasksScreenPayload = {
  version: 1;
  tasks: MyTaskBundlePayload;
  rules: { id: string; name: string; enabled: boolean; trigger_type: string; trigger_config: Json; conditions: Json; actions: Json }[];
  rules_v2: boolean;
  editable_sections: { id: string; name: string; project_id: string; sort_order: number }[];
};

export type HomeScreenPayload = {
  version: 1;
  tasks: MyTaskBundlePayload;
  // home_dashboard(tz)'s own object.
  dashboard: Json;
  // inbox_page('activity')'s own array.
  inbox: Json;
};

// ---------------------------------------------------------------------------------------------
// Parsed (what the app uses)
// ---------------------------------------------------------------------------------------------

export type ViewerMember = { allowlisted: boolean; fullName: string | null; avatarUrl: string | null };

export type ShellWorkspace = {
  id: string;
  name: string;
  defaultTeamId: string | null;
  logoPath: string | null;
  emailSenderName: string | null;
};

export type AppShell = {
  workspace: ShellWorkspace | null;
  isWorkspaceAdmin: boolean;
  unreadCount: number;
  // Every readable project, archived ones included (listReadableProjects), in sidebar order.
  readableProjects: ProjectRow[];
  // Active ones (listProjects) and archived ones, newest archive first (listArchivedProjects).
  projects: ProjectRow[];
  archivedProjects: ProjectRow[];
  // The person's own membership roles (listOwnProjectRoles) and the effective ones, archived projects
  // counting as Viewer (listMyProjectRoles).
  ownRoles: Map<string, ProjectRole>;
  myRoles: Map<string, ProjectRole>;
  starIds: string[];
  folders: SidebarFolderState;
  subtaskPrefs: SubtaskPrefs;
  openPersonalView: boolean;
  expandedTaskIds: string[];
  myTasksChecked: CheckedMode;
  // The person's own workdays (null = the organization's).
  personalWorkWeek: number[] | null;
  workWeek: number[];
  profiles: ProfileRow[];
  // Profile id → picture, for people who have one.
  avatars: Record<string, string>;
  // Every tag, and the ones the app shows (none while the workspace has tags off).
  tags: Tag[];
  visibleTags: Tag[];
  tagsEnabled: boolean;
  goalsEnabled: boolean;
};

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function parseViewerMember(data: unknown): ViewerMember {
  const o = asObject(data) ?? {};
  const profile = asObject(o.profile);
  return {
    allowlisted: o.allowlisted === true,
    fullName: typeof profile?.full_name === "string" ? profile.full_name : null,
    avatarUrl: typeof profile?.avatar_url === "string" ? profile.avatar_url : null,
  };
}

// The same order rule as listArchivedProjects (newest archive first).
export function archivedFirst(projects: ProjectRow[]): ProjectRow[] {
  return projects.filter((p) => p.archived_at !== null).sort((a, b) => b.archived_at!.localeCompare(a.archived_at!));
}

export function effectiveRoles(own: Map<string, ProjectRole>, readable: ProjectRow[]): Map<string, ProjectRole> {
  const archived = new Set(readable.filter((p) => p.archived_at !== null).map((p) => p.id));
  return new Map([...own].map(([projectId, role]) => [projectId, archived.has(projectId) ? "viewer" : role] as const));
}

export function parseAppShell(data: unknown): AppShell {
  const o = (asObject(data) ?? {}) as Partial<AppShellPayload>;
  const ws = o.workspace ?? null;
  const readable = asArray<ProjectRow>(o.projects);
  const ownRoles = new Map(
    asArray<{ project_id: string; role: string }>(o.own_roles)
      .filter((m) => isProjectRole(m.role))
      .map((m) => [m.project_id, m.role as ProjectRole] as const),
  );
  const prefs = o.preferences ?? null;
  const profiles = asArray<ProfileRow>(o.profiles);
  const tags = asArray<TagRow>(o.tags).map(toTag);
  const tagsEnabled = ws ? (ws.tags_enabled ?? false) : false;
  const checked = prefs?.my_tasks_checked;
  const ownWeek = prefs?.work_week ?? null;
  return {
    workspace: ws
      ? { id: ws.id, name: ws.name, defaultTeamId: ws.default_team_id, logoPath: ws.logo_path, emailSenderName: ws.email_sender_name }
      : null,
    isWorkspaceAdmin: o.is_workspace_admin === true,
    unreadCount: typeof o.unread_count === "number" ? o.unread_count : 0,
    readableProjects: readable,
    projects: readable.filter((p) => p.archived_at === null),
    archivedProjects: archivedFirst(readable),
    ownRoles,
    myRoles: effectiveRoles(ownRoles, readable),
    starIds: asArray<string>(o.star_ids),
    folders: {
      folders: asArray<AppShellPayload["folders"][number]>(o.folders).map((f) => ({
        id: f.id,
        name: f.name,
        collapsed: f.collapsed,
        sortOrder: f.sort_order,
      })),
      placements: asArray<AppShellPayload["folder_placements"][number]>(o.folder_placements).map((p) => ({
        projectId: p.project_id,
        folderId: p.folder_id,
        sortOrder: p.sort_order,
      })),
    },
    subtaskPrefs: prefs ? parseSubtaskPrefs(prefs) : DEFAULT_SUBTASK_PREFS,
    openPersonalView: prefs?.open_personal_view ?? false,
    expandedTaskIds: Array.isArray(prefs?.expanded_task_ids) ? prefs.expanded_task_ids : [],
    myTasksChecked: isCheckedMode(checked) ? checked : DEFAULT_CHECKED_MODE,
    personalWorkWeek: ownWeek && ownWeek.length ? normalizeWorkWeek(ownWeek) : null,
    workWeek: ws ? normalizeWorkWeek(ws.work_week) : [...DEFAULT_WORK_WEEK],
    profiles,
    avatars: Object.fromEntries(profiles.flatMap((p) => (p.avatar_url ? [[p.id, p.avatar_url]] : []))),
    tags,
    visibleTags: tagsEnabled ? tags : [],
    tagsEnabled,
    goalsEnabled: ws ? (ws.goals_enabled ?? false) : false,
  };
}

export type FrameMember = {
  profileId: string;
  role: ProjectRole;
  name: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  addedAt: string;
};

export type FrameForm = FormDef & { submissionCount: number; lastSubmittedAt: string | null };

export type ProjectFrame = {
  project: ProjectRow | null;
  sectionsLocked: boolean;
  role: ProjectRole | null;
  // Only when the project or the role is missing: what the "not a member" page needs.
  accessStatus: ProjectAccessStatus | null;
  views: ProjectView[];
  viewSettings: ProjectViewSettings;
  taskTemplates: TaskTemplate[];
  fields: FieldDef[];
  fieldSharing: Record<string, FieldSharing>;
  forms: FrameForm[];
  rules: RuleDef[];
  members: FrameMember[];
  sections: SectionRow[];
  statusTemplates: StatusTemplate[];
  numbering: TaskNumbering | null;
  // The person's own settings in this project.
  columnWidths: ColumnWidths;
  collapsedGroups: string[];
  showCompleted: boolean | null;
  personalConfigs: Map<string, ViewConfig>;
};

export function parseProjectFrame(data: unknown): ProjectFrame {
  const o = (asObject(data) ?? {}) as Partial<ProjectFramePayload>;
  const project = o.project ?? null;
  const settings = o.view_settings ?? null;
  const sharing: Record<string, FieldSharing> = {};
  for (const r of asArray<ProjectFramePayload["field_sharing"][number]>(o.field_sharing)) {
    sharing[r.field_id] = {
      fieldId: r.field_id,
      libraryFieldId: r.library_field_id,
      isSource: r.is_source,
      isShared: r.is_shared,
      placementCount: r.placement_count,
      definitionEditable: r.definition_editable,
      definitionManageable: r.definition_manageable,
    };
  }
  const personal = asObject(o.personal) ?? {};
  const personalConfigs = new Map<string, ViewConfig>();
  for (const c of asArray<{ view_id: string; config: Json }>(personal.view_configs)) {
    if (c.config) personalConfigs.set(c.view_id, parseViewConfig(c.config));
  }
  let projectRow: ProjectRow | null = null;
  if (project) {
    const { sections_locked: _locked, ...rest } = project;
    void _locked;
    projectRow = rest;
  }
  return {
    project: projectRow,
    sectionsLocked: project?.sections_locked === true,
    role: isProjectRole(o.role) ? o.role : null,
    accessStatus: o.access_status === null || o.access_status === undefined ? null : parseAccessStatus(o.access_status),
    views: asArray<Tables<"project_views">>(o.views).map(toProjectView),
    viewSettings: settings
      ? {
          defaultViewId: settings.default_view_id,
          hiddenTabs: (settings.hidden_tabs ?? []).filter(isFixedTab),
          hiddenViewIds: settings.hidden_view_ids ?? [],
        }
      : NO_VIEW_SETTINGS,
    taskTemplates: asArray<TaskTemplateRow>(o.task_templates).map(toTaskTemplate),
    fields: asArray<Tables<"custom_fields">>(o.fields).map(toFieldDef),
    fieldSharing: sharing,
    forms: asArray<ProjectFramePayload["forms"][number]>(o.forms).map((row) => ({
      ...toFormDef(row),
      submissionCount: Number(row.submission_count) || 0,
      lastSubmittedAt: row.last_submitted_at ?? null,
    })),
    rules: asArray<Parameters<typeof toRuleDef>[0]>(o.rules).map(toRuleDef),
    members: asArray<ProjectFramePayload["members"][number]>(o.members)
      .filter((m) => isProjectRole(m.role))
      .map((m) => ({
        profileId: m.profile_id,
        role: m.role as ProjectRole,
        name: m.profile.full_name?.trim() || m.profile.email,
        email: m.profile.email,
        fullName: m.profile.full_name,
        avatarUrl: m.profile.avatar_url,
        addedAt: m.created_at,
      })),
    sections: asArray<SectionRow>(o.sections),
    statusTemplates: asArray<Parameters<typeof toStatusTemplate>[0]>(o.status_templates).map(toStatusTemplate),
    numbering: o.numbering ? numberingFromRow({ ...o.numbering, advanced: true }) : null,
    columnWidths: parseColumnWidths(personal.column_widths),
    collapsedGroups: asArray<unknown>(personal.collapsed_groups).filter((key): key is string => typeof key === "string"),
    showCompleted: typeof personal.show_completed === "boolean" ? personal.show_completed : null,
    personalConfigs,
  };
}

// Pieces of my_task_bundle() the app combines (labels, access, extras) with the same code as before.
export type MyTaskBundle = {
  cards: Json;
  labels: Json;
  accessTasks: AccessTaskRow[];
  accessMemberships: { task_id: string; project_id: string }[];
  blockerCounts: Map<string, number>;
  children: { parent_task_id: string | null; completed_at: string | null }[];
  approvalStates: Json;
  awaiting: MyTaskBundlePayload["awaiting"];
};

export function parseMyTaskBundle(data: unknown): MyTaskBundle {
  const o = (asObject(data) ?? {}) as Partial<MyTaskBundlePayload>;
  const blockerCounts = new Map<string, number>();
  for (const [taskId, count] of Object.entries(asObject(o.blocker_counts) ?? {})) {
    if (typeof count === "number" && count > 0) blockerCounts.set(taskId, count);
  }
  const awaiting = asObject(o.awaiting) ?? {};
  return {
    cards: (o.cards ?? null) as Json,
    labels: (o.labels ?? {}) as Json,
    accessTasks: asArray<AccessTaskRow>(o.access_tasks),
    accessMemberships: asArray<{ task_id: string; project_id: string }>(o.access_memberships),
    blockerCounts,
    children: asArray<{ parent_task_id: string | null; completed_at: string | null }>(o.children),
    approvalStates: (o.approval_states ?? {}) as Json,
    awaiting: {
      requests: asArray(awaiting.requests),
      tasks: asArray(awaiting.tasks),
      rounds: asArray(awaiting.rounds),
    },
  };
}
