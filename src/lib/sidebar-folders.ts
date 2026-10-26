// Oct 26 notes (batch 3): personal sidebar folders. Each person's own folders (sidebar_folders) and
// which of them each project sits in (sidebar_folder_projects; folder null = under Projects). Own rows
// only in the database, so nothing here is ever about anyone else's sidebar. Browser + server.

export const MAX_FOLDER_NAME = 60;
export const MAX_FOLDERS = 50;
export const FOLDER_STEP = 1024;

export type SidebarFolder = { id: string; name: string; collapsed: boolean; sortOrder: number };
export type SidebarPlacement = { projectId: string; folderId: string | null; sortOrder: number };
export type SidebarFolderState = { folders: SidebarFolder[]; placements: SidebarPlacement[] };

export const EMPTY_FOLDER_STATE: SidebarFolderState = { folders: [], placements: [] };

export function folderNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the folder a name";
  if (trimmed.length > MAX_FOLDER_NAME) return `Folder names are at most ${MAX_FOLDER_NAME} characters`;
  return null;
}

const byOrder = <T extends { sortOrder: number }>(a: T, b: T) => a.sortOrder - b.sortOrder;

// The Projects group: each folder (in its order) with its projects, then every project in no folder
// (in the order the sidebar lists projects). A placement of a project the person can no longer open, or
// in a folder that's gone, shows nothing / falls back to Projects.
export function arrangeSidebar<P extends { id: string; name: string }>(
  projects: readonly P[],
  state: SidebarFolderState,
): { folders: { folder: SidebarFolder; projects: P[] }[]; loose: P[] } {
  const folders = [...state.folders].sort(byOrder);
  const folderIds = new Set(folders.map((f) => f.id));
  const placement = new Map(state.placements.map((p) => [p.projectId, p] as const));
  const inFolder = new Map<string, { project: P; sortOrder: number }[]>();
  const loose: P[] = [];
  for (const project of projects) {
    const placed = placement.get(project.id);
    if (placed?.folderId && folderIds.has(placed.folderId)) {
      const list = inFolder.get(placed.folderId) ?? [];
      list.push({ project, sortOrder: placed.sortOrder });
      inFolder.set(placed.folderId, list);
    } else {
      loose.push(project);
    }
  }
  return {
    folders: folders.map((folder) => ({
      folder,
      projects: (inFolder.get(folder.id) ?? [])
        .sort((a, b) => a.sortOrder - b.sortOrder || a.project.name.localeCompare(b.project.name))
        .map((x) => x.project),
    })),
    loose,
  };
}

// A sort order between two neighbours (null = no neighbour on that side).
export function orderBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return FOLDER_STEP;
  if (before === null) return (after as number) - FOLDER_STEP;
  if (after === null) return before + FOLDER_STEP;
  return (before + after) / 2;
}

// Where a folder lands when it's dropped in front of another (null = at the end).
export function folderOrderBefore(folders: readonly SidebarFolder[], movingId: string, beforeId: string | null): number {
  const rest = [...folders].sort(byOrder).filter((f) => f.id !== movingId);
  const index = beforeId === null ? rest.length : rest.findIndex((f) => f.id === beforeId);
  const at = index < 0 ? rest.length : index;
  return orderBetween(rest[at - 1]?.sortOrder ?? null, rest[at]?.sortOrder ?? null);
}

// Move up / Move down (the keyboard path): the folder's new sort order, or null when it can't move.
export function folderOrderMoved(folders: readonly SidebarFolder[], id: string, delta: -1 | 1): number | null {
  const sorted = [...folders].sort(byOrder);
  const index = sorted.findIndex((f) => f.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= sorted.length) return null;
  const beforeId = delta < 0 ? sorted[target].id : (sorted[target + 1]?.id ?? null);
  return folderOrderBefore(sorted, id, beforeId);
}

// The end of a folder (a project dropped on the folder itself), or in front of a project in it.
export function placementOrder(
  state: SidebarFolderState,
  folderId: string,
  movingProjectId: string,
  beforeProjectId: string | null,
): number {
  const rest = state.placements
    .filter((p) => p.folderId === folderId && p.projectId !== movingProjectId)
    .sort(byOrder);
  const index = beforeProjectId === null ? rest.length : rest.findIndex((p) => p.projectId === beforeProjectId);
  const at = index < 0 ? rest.length : index;
  return orderBetween(rest[at - 1]?.sortOrder ?? null, rest[at]?.sortOrder ?? null);
}

// The sidebar's optimistic changes (applied at once, then replaced by the server's answer).
export type SidebarChange =
  | { type: "star"; projectId: string; starred: boolean }
  | { type: "file"; projectId: string; folderId: string | null; sortOrder: number }
  | { type: "folder"; folder: SidebarFolder }
  | { type: "removeFolder"; folderId: string };

export type SidebarState = SidebarFolderState & { starredIds: string[] };

export function applySidebarChange(state: SidebarState, change: SidebarChange): SidebarState {
  switch (change.type) {
    case "star": {
      const without = state.starredIds.filter((id) => id !== change.projectId);
      return { ...state, starredIds: change.starred ? [...without, change.projectId] : without };
    }
    case "file": {
      const others = state.placements.filter((p) => p.projectId !== change.projectId);
      return {
        ...state,
        placements: [...others, { projectId: change.projectId, folderId: change.folderId, sortOrder: change.sortOrder }],
      };
    }
    case "folder": {
      const others = state.folders.filter((f) => f.id !== change.folder.id);
      return { ...state, folders: [...others, change.folder] };
    }
    case "removeFolder":
      return {
        ...state,
        folders: state.folders.filter((f) => f.id !== change.folderId),
        placements: state.placements.map((p) => (p.folderId === change.folderId ? { ...p, folderId: null } : p)),
      };
  }
}
