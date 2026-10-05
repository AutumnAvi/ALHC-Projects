import { redirect } from "next/navigation";
import { BoardView } from "@/components/project/board-view";
import { CalendarView } from "@/components/project/calendar-view";
import { ListView } from "@/components/project/list-view";
import { ViewToolbar } from "@/components/project/view-toolbar";
import { TaskPane } from "@/components/task/task-pane";
import {
  filterProjectTaskIds,
  listProfiles,
  listProjectFields,
  listProjectTasks,
  listProjectViews,
  listSections,
} from "@/lib/data";
import { getViewerTimeZone } from "@/lib/timezone";
import { decodeConfig, pruneConfig, type ProjectView, type ViewLayout } from "@/lib/views";

type SearchParams = Record<string, string | string[] | undefined>;

export function queryString(searchParams: SearchParams) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

// /projects/<id>/list|board|calendar open the project's first view with that layout (keeping
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

  const [sections, tasks, profiles, fields, timeZone] = await Promise.all([
    listSections(projectId),
    listProjectTasks(projectId),
    listProfiles(),
    listProjectFields(projectId),
    getViewerTimeZone(),
  ]);

  const context = {
    sectionIds: new Set(sections.map((s) => s.id)),
    fields,
    profileIds: new Set(profiles.map((p) => p.id)),
  };
  const baseConfig = pruneConfig(view?.config ?? {}, context);
  const config = pruneConfig(decodeConfig(searchParams.f) ?? baseConfig, context);
  const matching = await filterProjectTaskIds(projectId, config.filters ?? {}, timeZone);
  const visible = tasks.filter((t) => matching.has(t.id));
  const props = { projectId, sections, tasks: visible, profiles, fields, config, openTaskId };

  return (
    <main className={`flex min-h-0 flex-1 flex-col ${layout === "list" ? "overflow-auto" : ""}`}>
      <ViewToolbar
        key={`toolbar-${view?.id ?? layout}`}
        projectId={projectId}
        view={view}
        layout={layout}
        baseConfig={baseConfig}
        config={config}
        context={{ sections, profiles, fields }}
      />
      {layout === "list" ? <ListView key={`list-${view?.id ?? "default"}`} {...props} /> : null}
      {layout === "board" ? <BoardView key={`board-${view?.id ?? "default"}`} {...props} /> : null}
      {layout === "calendar" ? (
        <CalendarView tasks={visible} profiles={profiles} openTaskId={openTaskId} />
      ) : null}
      {openTaskId ? <TaskPane taskId={openTaskId} /> : null}
    </main>
  );
}
