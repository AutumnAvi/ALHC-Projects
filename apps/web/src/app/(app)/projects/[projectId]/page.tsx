import { redirect } from "next/navigation";
import { ProjectViewPage, queryString } from "@/components/project/project-view-page";
import { CanonicalUrl } from "@/components/shell/canonical-url";
import { loadAppShell, loadProjectFrame } from "@/lib/screen-loaders";
import { openingView } from "@alhc/core/views";

// Opens the project on its default view (Owners pick it; else the first tab), or on the viewer's own
// saved view when they chose "Open my saved view by default" (Settings → Display; Oct 26 notes, batch 4).
// Nov 3 notes (batch 18, 135): the view is rendered right here (the address bar then moves to
// /projects/<id>/views/<view> on the client) instead of a redirect, which made every project open two
// server renders in a row.
export default async function ProjectIndex({ params, searchParams }: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  // Nov 4 notes (batch 22, M1): the frame and the shell (already read by the layouts) have all of it.
  const [frame, shell, query] = await Promise.all([loadProjectFrame(projectId), loadAppShell(), searchParams]);
  const view = openingView(frame.views, frame.viewSettings, shell.openPersonalView);
  if (!view) redirect(`/projects/${projectId}/list${queryString(query)}`);
  return (
    <>
      <CanonicalUrl path={`/projects/${projectId}/views/${view.id}`} />
      <ProjectViewPage projectId={projectId} view={view} layout={view.layout} searchParams={query} />
    </>
  );
}
