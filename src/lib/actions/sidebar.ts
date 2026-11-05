"use server";
// Big move 1: the sidebar area's Server Actions (starred projects, personal sidebar folders), thin wrappers
// around src/lib/api/sidebar/mutations.ts. Only what Next.js does (cached pages, the request's context)
// stays here.
import type { ActionResult } from "@/lib/api/core/result";
import type { SidebarFolderPatch } from "@/lib/api/sidebar/model";
import * as sidebarApi from "@/lib/api/sidebar/mutations";
import { run, runWith } from "@/lib/server/action";
import { FOLDER_STEP } from "@/lib/sidebar-folders";

// ---------------------------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------------------------

export async function setProjectStarred(projectId: string, starred: boolean): Promise<ActionResult> {
  return run((ctx) => sidebarApi.setProjectStarred(ctx, projectId, starred), { revalidate: [["/", "layout"]] });
}

// Nov 2 notes (batch 15, 110): the sidebar lives in the app layout, so the layout is revalidated too: a
// plain refresh could leave the old starred list there, and the dropped projects vanished until a reload.
export async function setProjectsStarred(projectIds: string[], starred: boolean): Promise<ActionResult> {
  return run((ctx) => sidebarApi.setProjectsStarred(ctx, projectIds, starred), { revalidate: [["/", "layout"]] });
}

// ---------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------

export async function createSidebarFolder(
  name: string,
  sortOrder: number,
  projectId?: string,
): Promise<ActionResult & { folderId?: string }> {
  return runWith((ctx) => sidebarApi.createSidebarFolder(ctx, name, sortOrder, projectId));
}

export async function updateSidebarFolder(folderId: string, patch: SidebarFolderPatch): Promise<ActionResult> {
  return run((ctx) => sidebarApi.updateSidebarFolder(ctx, folderId, patch));
}

// Removing a folder puts its projects back under Projects (the database does it).
export async function deleteSidebarFolder(folderId: string): Promise<ActionResult> {
  return run((ctx) => sidebarApi.deleteSidebarFolder(ctx, folderId));
}

// Moves a project into one of the person's folders (at sortOrder), or back under Projects (null); the
// sidebar lives in the app layout, so the layout is revalidated too.
export async function fileSidebarProject(projectId: string, folderId: string | null, sortOrder = FOLDER_STEP): Promise<ActionResult> {
  return run((ctx) => sidebarApi.fileSidebarProject(ctx, projectId, folderId, sortOrder), { revalidate: [["/", "layout"]] });
}
