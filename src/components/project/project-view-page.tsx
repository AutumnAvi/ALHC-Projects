import { redirect } from "next/navigation";
import { BoardView } from "@/components/project/board-view";
import { CalendarView } from "@/components/project/calendar-view";
import { ListView } from "@/components/project/list-view";
import { TimelineView } from "@/components/project/timeline-view";
import { ViewToolbar } from "@/components/project/view-toolbar";
import { TaskPaneBoundary } from "@/components/task/task-pane";
import { listBulkContext } from "@/components/bulk/bulk-context";
import {
  filterProjectTaskIds,
  listProfiles,
  listProjectDependencies,
  listProjectFields,
  projectCriticalPath,
  listProjectTasks,
  listProjectViews,
  listSections,
  listSubtaskTrees,
  listTags,
} from "@/lib/data";
import { EMPTY_CRITICAL_PATH } from "@/lib/critical-path";
import { getViewerTimeZone } from "@/lib/timezone";
import { decodeConfig, pruneConfig, showsSubtasks, type ProjectView, type ViewLayout } from "@/lib/views";

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

  const [sections, tasks, profiles, fields, timeZone, dependencies, criticalPath, bulk, tags] = await Promise.all([
    listSections(projectId),
    listProjectTasks(projectId),
    listProfiles(),
    listProjectFields(projectId),
    getViewerTimeZone(),
    layout === "timeline" ? listProjectDependencies(projectId) : Promise.resolve([]),
    layout === "timeline" ? projectCriticalPath(projectId) : Promise.resolve(EMPTY_CRITICAL_PATH),
    layout === "list" ? listBulkContext(projectId) : Promise.resolve(undefined),
    listTags(),
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
  const matching = await filterProjectTaskIds(projectId, config.filters ?? {}, timeZone);
  const visible = tasks.filter((t) => matching.has(t.id));
  const props = { projectId, sections, tasks: visible, profiles, fields, config, openTaskId, tags };
  // List's “Show subtasks” (the view's show_subtasks setting, off by default): each task's subtask tree
  // under its row.
  const showSubtasks = layout === "list" && showsSubtasks(config);
  const subtasks = showSubtasks ? await listSubtaskTrees(visible.map((t) => t.id)) : [];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <ViewToolbar
        key={`toolbar-${view?.id ?? layout}`}
        projectId={projectId}
        view={view}
        layout={layout}
        baseConfig={baseConfig}
        config={config}
        context={{ sections, profiles, fields, tags }}
      />
      {layout === "list" ? (
        // The toolbar stays put; the list scrolls under it with a sticky column header.
        <div className="min-h-0 flex-1 overflow-auto">
          <ListView key={`list-${view?.id ?? "default"}`} {...props} bulk={bulk} subtasks={showSubtasks ? subtasks : null} />
        </div>
      ) : null}
      {layout === "board" ? <BoardView key={`board-${view?.id ?? "default"}`} {...props} /> : null}
      {layout === "calendar" ? (
        <CalendarView tasks={visible} profiles={profiles} openTaskId={openTaskId} />
      ) : null}
      {layout === "timeline" ? (
        <TimelineView
          key={`timeline-${view?.id ?? "default"}`}
          {...props}
          dependencies={dependencies}
          criticalPath={criticalPath}
        />
      ) : null}
      {openTaskId ? <TaskPaneBoundary taskId={openTaskId} /> : null}
    </main>
  );
}
