import { redirect } from "next/navigation";
import { ProjectViewPage, queryString } from "@/components/project/project-view-page";
import { CanonicalUrl } from "@/components/shell/canonical-url";
import { getProfilePreferences, getProjectViewSettings, listProjectViews } from "@/lib/data";
import { openingView } from "@/lib/views";

// Opens the project on its default view (Owners pick it; else the first tab), or on the viewer's own
// saved view when they chose "Open my saved view by default" (Settings → Display; Oct 26 notes, batch 4).
// Nov 3 notes (batch 18, 135): the view is rendered right here (the address bar then moves to
// /projects/<id>/views/<view> on the client) instead of a redirect, which made every project open two
// server renders in a row.
export default async function ProjectIndex({ params, searchParams }: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  const [views, settings, preferences, query] = await Promise.all([
    listProjectViews(projectId),
    getProjectViewSettings(projectId),
    getProfilePreferences(),
    searchParams,
  ]);
  const view = openingView(views, settings, preferences.openPersonalView);
  if (!view) redirect(`/projects/${projectId}/list${queryString(query)}`);
  return (
    <>
      <CanonicalUrl path={`/projects/${projectId}/views/${view.id}`} />
      <ProjectViewPage projectId={projectId} view={view} layout={view.layout} searchParams={query} />
    </>
  );
}
