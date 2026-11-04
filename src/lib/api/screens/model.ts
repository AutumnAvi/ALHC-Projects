// Big move 1: the screens area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { InboxItem } from "@/lib/api/inbox/model";
import {
  assembleMyTasks,
  type AwaitingApproval,
  awaitingFrom,
  type MyTask,
  myTaskExtrasFrom,
  myTasksFromCards,
} from "@/lib/api/my-tasks/model";
import { numbersFromPlaces, placesFromLabels } from "@/lib/api/numbers/model";
import {
  accessFromRows,
  approvalRowState,
  type ApprovalRowState,
  type ProjectTaskGroupPage,
} from "@/lib/api/tasks/model";
import type { HomeDashboard } from "@/lib/home";
import type { MyTaskRule, MyTaskRuleContext } from "@/lib/my-task-rules";
import { hasRole, type ProjectRole } from "@/lib/roles";
import type { AppShell, MyTaskBundle, MyTasksScreenPayload } from "@/lib/screen-shapes";

// ---------------------------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------------------------

export type LoadedAppShell = AppShell & { logoUrl: string | null };

// ---------------------------------------------------------------------------------------------
// List / Board page
// ---------------------------------------------------------------------------------------------

export type ProjectViewPageData = {
  // Null on a database without project_task_card_page (the page then reads every card).
  pages: ProjectTaskGroupPage[] | null;
  sectionCounts: Record<string, number> | null;
};

// ---------------------------------------------------------------------------------------------
// My tasks and Home
// ---------------------------------------------------------------------------------------------

type MyTaskLists = { open: MyTask[]; completed: MyTask[]; awaiting: AwaitingApproval[] };

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
  // Nov 4 notes, batch 28 (M4): when the reads started (server clock): the client data cache keeps the
  // newest copy of the person's tasks between My tasks and Home.
  loadedAt: number;
  rules: MyTaskRule[] | null;
  rulesV2: boolean;
  editableSections: MyTasksScreenPayload["editable_sections"];
};

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

export type HomeScreen = MyTaskLists & { dashboard: HomeDashboard; inbox: InboxItem[]; loadedAt: number };
