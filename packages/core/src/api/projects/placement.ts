// Big move 1: where a new project goes, shared by creating, copying a template, and duplicating.
import type { ApiContext } from "../core/context";
import type { ProjectVisibility } from "../../workspace";

// After a template or a duplicate is created: put it in the chosen team (best effort — the project
// already exists in the default team if this is refused).
export async function placeNewProject(
  ctx: ApiContext,
  projectId: string,
  teamId: string | null,
  visibility: ProjectVisibility | null,
): Promise<void> {
  if (!teamId && !visibility) return;
  await ctx.db
    .from("projects")
    .update({ ...(teamId ? { team_id: teamId } : {}), ...(visibility ? { visibility } : {}) })
    .eq("id", projectId);
}
