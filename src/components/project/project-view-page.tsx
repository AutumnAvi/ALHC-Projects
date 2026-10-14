import { redirect } from "next/navigation";
import { BoardView } from "@/components/project/board-view";
import { CalendarView } from "@/components/project/calendar-view";
import { ListView } from "@/components/project/list-view";
import { TimelineView } from "@/components/project/timeline-view";
import { ViewToolbar } from "@/components/project/view-toolbar";
import { ViewConfigProvider } from "@/components/project/view-config";
import { TaskPaneBoundary } from "@/components/task/task-pane";
import { listBulkContext } from "@/components/bulk/bulk-context";
import { calendarVisibleDays } from "@/lib/date-input";
import {
  filterProjectTaskIds,
  listProfiles,
  listProjectDependencies,
  listProjectFields,
  listProjectSchedule,
  projectCriticalPath,
  listProjectTaskPage,
  listProjectTasks,
  type ProjectTask,
  listProjectViews,
  listSectionTaskCounts,
  listSections,
  listSubtaskTrees,
  listTags,
  getListColumnWidths,
} from "@/lib/data";
import { todayIn } from "@/lib/workload";
import { EMPTY_CRITICAL_PATH } from "@/lib/critical-path";
import { getViewerTimeZone } from "@/lib/timezone";
import {
  decodeConfig,
  groupOf,
  isIsoDate,
  parsePageLimits,
  pruneConfig,
  ROW_PAGE,
  showsSubtasks,
  sortOf,
  type ProjectView,
  type ViewLayout,
} from "@/lib/views";

type SearchParams = Record<string, string | string[] | undefined>;

export function queryString(searchParams: SearchParams) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

// /projects/<id>/list|board|calendar|timeline open the project's first view with that layout (keeping
// ?task= and ?f=), so older links keep working. Without one, the layout renders its default config.
export async function LayoutRoute({
  projectId,
  layout,
  searchParams,
}: {
  projectId: string;
  layout: ViewLayout;
  searchParams: SearchParams;
}) {
  const view = (await listProjectViews(projectId)).find((v) => v.layout === layout);
  if (view) redirect(`/projects/${projectId}/views/${view.id}${queryString(searchParams)}`);
  return <ProjectViewPage projectId={projectId} view={null} layout={layout} searchParams={searchParams} />;
}

// Renders a saved view, or the default config for a layout when the project has no such view.
// `?f=` carries an unsaved (draft) config; `?task=` opens the task pane.
export async function ProjectViewPage({
  projectId,
  view,
  layout,
  searchParams,
}: {
  projectId: string;
  view: ProjectView | null;
  layout: ViewLayout;
  searchParams: SearchParams;
}) {
  const openTaskId = typeof searchParams.task === "string" ? searchParams.task : null;
  const paging = layout === "list" || layout === "board";
  // Calendar loads the visible month or week. Timeline still reads every card until its own path.
  const scheduling = layout === "calendar";

  const [sections, fullTasks, profiles, fields, timeZone, dependencies, criticalPath, bulk, tags, columnWidths, sectionCounts] =
    await Promise.all([
    listSections(projectId),
    paging || scheduling ? Promise.resolve(null) : listProjectTasks(projectId),
    listProfiles(),
    listProjectFields(projectId),
    getViewerTimeZone(),
    layout === "timeline" ? listProjectDependencies(projectId) : Promise.resolve([]),
    layout === "timeline" ? projectCriticalPath(projectId) : Promise.resolve(EMPTY_CRITICAL_PATH),
    layout === "list" ? listBulkContext(projectId) : Promise.resolve(undefined),
    listTags(),
    layout === "list" ? getListColumnWidths(projectId) : Promise.resolve({}),
    listSectionTaskCounts(projectId),
  ]);

  const context = {
    sectionIds: new Set(sections.map((s) => s.id)),
    fields,
    profileIds: new Set(profiles.map((p) => p.id)),
    tagIds: new Set(tags.map((t) => t.id)),
  };
  const baseConfig = pruneConfig(view?.config ?? {}, context);
  let config = pruneConfig(decodeConfig(searchParams.f) ?? baseConfig, context);
  // Older links carry ?sub=1: show it as an unsaved draft of the view's Show subtasks setting.
  if (layout === "list" && searchParams.sub === "1" && !showsSubtasks(config)) config = { ...config, show_subtasks: true };
  const limits = parsePageLimits(typeof searchParams.n === "string" ? searchParams.n : undefined);
  const today = todayIn(timeZone);
  const calendarMode = searchParams.cal === "week" ? "week" : "month";
  const requestedDay = typeof searchParams.d === "string" && isIsoDate(searchParams.d) ? searchParams.d : today;
  const calendarDays = layout === "calendar" ? calendarVisibleDays(requestedDay, calendarMode) : null;
  // List and Board paint one page per group. Calendar loads the visible weeks (and the undated
  // tray). Timeline still reads every matching task. A missing function falls back to the full list.
  let [taskPage, scheduleTasks] = await Promise.all([
    paging
      ? listProjectTaskPage(
          projectId,
          config.filters ?? {},
          timeZone,
          groupOf(config),
          sortOf(config),
          ROW_PAGE,
          limits,
        )
      : Promise.resolve(null),
    calendarDays
      ? listProjectSchedule(
          projectId,
          config.filters ?? {},
          timeZone,
          { start: calendarDays[0], end: calendarDays[calendarDays.length - 1] },
          "calendar",
        )
      : Promise.resolve(null),
  ]);
  let everyTask = fullTasks;
  let visible: ProjectTask[];
  if (scheduleTasks) {
    visible = scheduleTasks;
  } else if (taskPage) {
    const seen = new Set<string>();
    visible = [];
    for (const group of taskPage) {
      for (const task of group.tasks) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        visible.push(task);
      }
    }
  } else {
    everyTask = fullTasks ?? (await listProjectTasks(projectId));
    const matching = await filterProjectTaskIds(projectId, config.filters ?? {}, timeZone);
    visible = everyTask.filter((task) => matching.has(task.id));
    taskPage = null;
  }
  const props = { projectId, sections, tasks: visible, profiles, fields, config, openTaskId, tags };
  // List's “Show subtasks” (the view's show_subtasks setting, off by default): each task's subtask tree
  // under its row.
  const showSubtasks = layout === "list" && showsSubtasks(config);
  const subtasks = showSubtasks ? await listSubtaskTrees(visible.map((t) => t.id)) : [];
  // Every task per section, whatever the view shows: a section can be deleted only when it's empty.
  const sectionTaskCounts: Record<string, number> = sectionCounts ?? {};
  if (!sectionCounts) {
    for (const task of everyTask ?? visible) {
      if (task.sectionId) sectionTaskCounts[task.sectionId] = (sectionTaskCounts[task.sectionId] ?? 0) + 1;
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <ViewConfigProvider key={`config-${view?.id ?? layout}`} baseConfig={baseConfig} config={config}>
        <ViewToolbar projectId={projectId} view={view} layout={layout} context={{ sections, profiles, fields, tags }} />
        {layout === "list" ? (
          // The toolbar stays put; the list scrolls under it with a sticky column header.
          <div className="min-h-0 flex-1 overflow-auto">
            <ListView
              key={`list-${view?.id ?? "default"}`}
              {...props}
              taskPage={taskPage}
              bulk={bulk}
              subtasks={showSubtasks ? subtasks : null}
              columnWidths={columnWidths}
              sectionTaskCounts={sectionTaskCounts}
            />
          </div>
        ) : null}
        {layout === "board" ? (
          <BoardView
            key={`board-${view?.id ?? "default"}`}
            {...props}
            taskPage={taskPage}
            sectionTaskCounts={sectionTaskCounts}
          />
        ) : null}
        {layout === "calendar" ? (
          <CalendarView
            projectId={projectId}
            tasks={visible}
            profiles={profiles}
            openTaskId={openTaskId}
            windowed={scheduleTasks !== null}
            today={today}
            anchor={requestedDay}
            mode={calendarMode}
            days={calendarDays}
          />
        ) : null}
        {layout === "timeline" ? (
          <TimelineView
            key={`timeline-${view?.id ?? "default"}`}
            {...props}
            dependencies={dependencies}
            criticalPath={criticalPath}
          />
        ) : null}
      </ViewConfigProvider>
      {openTaskId ? <TaskPaneBoundary taskId={openTaskId} /> : null}
    </main>
  );
}
