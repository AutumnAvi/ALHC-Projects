// Big move 1: the sidebar area's writes (starred projects, personal sidebar folders). Every function takes
// the caller's ApiContext first, validates its own input, writes only through ctx.db (RLS and the guard
// triggers decide), and throws ApiError on any refusal; no Next.js here.
import type { ApiContext, Db } from "../core/context";
import { check, nowIso } from "../core/db";
import { type DbErrorDetail, invalid } from "../core/errors";
import { id } from "../core/validate";
import type { SidebarFolderPatch } from "./model";
import { FOLDER_STEP, folderNameProblem } from "../../sidebar-folders";

// ---------------------------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------------------------

export async function setProjectStarred(ctx: ApiContext, projectId: string, starred: boolean): Promise<void> {
  return setProjectsStarred(ctx, [projectId], starred);
}

// Nov 2 notes (batch 15, 110): star or unstar several projects at once (a multi-project drag in the
// sidebar). The sidebar lives in the app layout, so the adapter revalidates the layout too: a plain refresh
// could leave the old starred list there, and the dropped projects vanished until a reload.
export async function setProjectsStarred(ctx: ApiContext, projectIds: string[], starred: boolean): Promise<void> {
  if (!Array.isArray(projectIds) || projectIds.length === 0 || projectIds.length > 100) throw invalid("Pick 1–100 projects");
  const supabase = ctx.db;
  for (const projectId of projectIds) {
    check(await supabase.rpc("set_project_starred", { target_project: id(projectId, "project"), starred: starred === true }));
  }
}

// ---------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------

// Oct 26 notes (batch 3): personal sidebar folders (own rows only; RLS and the guard triggers decide).
const FOLDER_UNAVAILABLE = "Sidebar folders need this release’s database update";

function folderError(result: { error: DbErrorDetail | null }) {
  if (result.error?.code === "PGRST205" || result.error?.code === "42P01") throw invalid(FOLDER_UNAVAILABLE);
  check(result, "That folder isn’t yours");
}

// Answers the new folder's id.
export async function createSidebarFolder(
  ctx: ApiContext,
  name: string,
  sortOrder: number,
  projectId?: string,
): Promise<{ folderId: string }> {
  const problem = folderNameProblem(typeof name === "string" ? name : "");
  if (problem) throw invalid(problem);
  if (!Number.isFinite(sortOrder)) throw invalid("Invalid position");
  const supabase = ctx.db;
  const inserted = await supabase.from("sidebar_folders").insert({ name: name.trim(), sort_order: sortOrder }).select("id").single();
  folderError(inserted);
  const folderId = inserted.data!.id;
  if (projectId) await placeProject(supabase, id(projectId, "project"), folderId, FOLDER_STEP);
  return { folderId };
}

export async function updateSidebarFolder(ctx: ApiContext, folderId: string, patch: SidebarFolderPatch): Promise<void> {
  const update: { name?: string; collapsed?: boolean; sort_order?: number } = {};
  if (patch.name !== undefined) {
    const problem = folderNameProblem(patch.name);
    if (problem) throw invalid(problem);
    update.name = patch.name.trim();
  }
  if (patch.collapsed !== undefined) update.collapsed = patch.collapsed === true;
  if (patch.sortOrder !== undefined) {
    if (!Number.isFinite(patch.sortOrder)) throw invalid("Invalid position");
    update.sort_order = patch.sortOrder;
  }
  const supabase = ctx.db;
  const result = await supabase.from("sidebar_folders").update(update).eq("id", id(folderId, "folder")).is("deleted_at", null).select("id");
  folderError(result);
  if (!result.data?.length) throw invalid("That folder isn’t there any more");
}

// Removing a folder puts its projects back under Projects (the database does it).
export async function deleteSidebarFolder(ctx: ApiContext, folderId: string): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase
    .from("sidebar_folders")
    .update({ deleted_at: nowIso() })
    .eq("id", id(folderId, "folder"))
    .is("deleted_at", null)
    .select("id");
  folderError(result);
}

async function placeProject(supabase: Db, projectId: string, folderId: string | null, sortOrder: number) {
  const existing = await supabase.from("sidebar_folder_projects").select("id").eq("project_id", projectId).maybeSingle();
  folderError(existing);
  if (existing.data) {
    folderError(
      await supabase.from("sidebar_folder_projects").update({ folder_id: folderId, sort_order: sortOrder }).eq("id", existing.data.id),
    );
  } else if (folderId) {
    const inserted = await supabase
      .from("sidebar_folder_projects")
      .insert({ project_id: projectId, folder_id: folderId, sort_order: sortOrder });
    if (inserted.error?.code === "42501") throw invalid("You can only file projects you can open");
    folderError(inserted);
  }
}

// Moves a project into one of the person's folders (at sortOrder), or back under Projects (null).
export async function fileSidebarProject(
  ctx: ApiContext,
  projectId: string,
  folderId: string | null,
  sortOrder = FOLDER_STEP,
): Promise<void> {
  if (!Number.isFinite(sortOrder)) throw invalid("Invalid position");
  const supabase = ctx.db;
  await placeProject(supabase, id(projectId, "project"), folderId ? id(folderId, "folder") : null, sortOrder);
}
