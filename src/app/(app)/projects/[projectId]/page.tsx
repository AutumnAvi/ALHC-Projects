import { redirect } from "next/navigation";
import { queryString } from "@/components/project/project-view-page";
import { getProfilePreferences, getProjectViewSettings, listProjectViews } from "@/lib/data";
import { openingView } from "@/lib/views";

// Opens the project on its default view (Owners pick it; else the first tab), or on the viewer's own
// saved view when they chose "Open my saved view by default" (Settings → Display; Oct 26 notes, batch 4).
export default async function ProjectIndex({ params, searchParams }: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  const [views, settings, preferences] = await Promise.all([
    listProjectViews(projectId),
    getProjectViewSettings(projectId),
    getProfilePreferences(),
  ]);
  const view = openingView(views, settings, preferences.openPersonalView);
  const query = queryString(await searchParams);
  redirect(view ? `/projects/${projectId}/views/${view.id}${query}` : `/projects/${projectId}/list${query}`);
}
