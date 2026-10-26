"use client";

import Link from "next/link";
import { useOptimistic, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Folder,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { MenuItem, Popover } from "@/components/popover";
import { useShell } from "@/components/shell/shell-context";
import { DROP_TARGET, Group, NAV_LINK } from "@/components/shell/sidebar-group";
import { useServerAction } from "@/components/toast";
import {
  createSidebarFolder,
  deleteSidebarFolder,
  fileSidebarProject,
  setProjectStarred,
  updateSidebarFolder,
} from "@/lib/actions";
import { projectColorClass } from "@/lib/project-colors";
import {
  FOLDER_STEP,
  MAX_FOLDER_NAME,
  applySidebarChange,
  arrangeSidebar,
  folderNameProblem,
  folderOrderBefore,
  folderOrderMoved,
  orderBetween,
  placementOrder,
  type SidebarChange,
  type SidebarFolder,
  type SidebarFolderState,
  type SidebarState,
} from "@/lib/sidebar-folders";

export type SidebarProject = { id: string; name: string };

// Native drag and drop (wide screens); every move is also in the rows' "…" menus (keyboard, touch).
const PROJECT_DRAG = "application/x-alhc-sidebar-project";
const FOLDER_DRAG = "application/x-alhc-sidebar-folder";

type Dragging = { kind: "project"; id: string; from: "starred" | "projects" } | { kind: "folder"; id: string };

const ROW_MENU_BUTTON =
  "absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded text-shell-muted opacity-0 hover:bg-shell-hover hover:text-white focus-visible:opacity-100 group-hover/row:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100";
const NAME_INPUT =
  "h-7 w-full min-w-0 rounded-md border border-shell-line bg-shell-hover px-2 text-sm text-white placeholder:text-shell-muted focus:border-accent-400 focus:outline-none";

// Oct 26 notes (batch 3): the sidebar's Starred and Projects groups. Drag a project into Starred to star
// it, or back to Projects to unstar it; each person's own folders (private to them, never anyone else's
// sidebar) hold projects they drag in, and can be renamed, collapsed, reordered, and removed (their
// projects go back under Projects).
export function SidebarProjects({
  projects,
  starredIds,
  folders,
  pathname,
}: {
  projects: SidebarProject[];
  starredIds: string[];
  folders: SidebarFolderState;
  pathname: string;
}) {
  const { openDialog } = useShell();
  const [, run] = useServerAction();
  const confirm = useConfirm();
  const [state, apply] = useOptimistic<SidebarState, SidebarChange[]>(
    { ...folders, starredIds },
    (current, changes) => changes.reduce(applySidebarChange, current),
  );
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ projectId?: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const byId = new Map(projects.map((p) => [p.id, p] as const));
  const starred = state.starredIds.flatMap((id) => {
    const project = byId.get(id);
    return project ? [project] : [];
  });
  const starredSet = new Set(state.starredIds);
  const arranged = arrangeSidebar(projects, state);
  const folderOf = new Map(
    arranged.folders.flatMap(({ folder, projects: list }) => list.map((p) => [p.id, folder.id] as const)),
  );
  const isCurrent = (projectId: string) => pathname === `/projects/${projectId}` || pathname.startsWith(`/projects/${projectId}/`);

  // ----- Changes (optimistic; the server's answer replaces them) -----

  function star(projectId: string, on: boolean) {
    run(() => setProjectStarred(projectId, on), () => apply([{ type: "star", projectId, starred: on }]));
  }

  function file(projectId: string, folderId: string | null, beforeProjectId: string | null = null) {
    const sortOrder = folderId ? placementOrder(state, folderId, projectId, beforeProjectId) : FOLDER_STEP;
    run(
      () => fileSidebarProject(projectId, folderId, sortOrder),
      () => apply([{ type: "file", projectId, folderId, sortOrder }]),
    );
  }

  function saveFolder(folder: SidebarFolder, patch: Partial<Pick<SidebarFolder, "name" | "collapsed" | "sortOrder">>) {
    run(() => updateSidebarFolder(folder.id, patch), () => apply([{ type: "folder", folder: { ...folder, ...patch } }]));
  }

  async function removeFolder(folder: SidebarFolder) {
    const ok = await confirm({
      title: `Remove the folder “${folder.name}”?`,
      message: "Its projects go back under Projects.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    run(() => deleteSidebarFolder(folder.id), () => apply([{ type: "removeFolder", folderId: folder.id }]));
  }

  function createFolder(name: string, projectId?: string) {
    setCreating(null);
    if (folderNameProblem(name)) return;
    const last = [...state.folders].sort((a, b) => a.sortOrder - b.sortOrder).at(-1);
    const sortOrder = orderBetween(last?.sortOrder ?? null, null);
    const tempId = `new-folder-${Date.now()}`;
    run(
      () => createSidebarFolder(name.trim(), sortOrder, projectId),
      () =>
        apply([
          { type: "folder", folder: { id: tempId, name: name.trim(), collapsed: false, sortOrder } },
          ...(projectId ? [{ type: "file" as const, projectId, folderId: tempId, sortOrder: FOLDER_STEP }] : []),
        ]),
    );
  }

  // ----- Drag and drop -----

  function startProjectDrag(e: DragEvent<HTMLElement>, projectId: string, from: "starred" | "projects") {
    e.dataTransfer.setData(PROJECT_DRAG, projectId);
    e.dataTransfer.effectAllowed = "move";
    setDragging({ kind: "project", id: projectId, from });
  }
  function startFolderDrag(e: DragEvent<HTMLElement>, folderId: string) {
    e.dataTransfer.setData(FOLDER_DRAG, folderId);
    e.dataTransfer.effectAllowed = "move";
    setDragging({ kind: "folder", id: folderId });
  }
  function endDrag() {
    setDragging(null);
    setTarget(null);
  }
  // Takes the drop (and marks where it would land) when `ok`; inner targets stop it reaching outer ones.
  function over(e: DragEvent<HTMLElement>, key: string, ok: boolean) {
    if (!ok) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (target !== key) setTarget(key);
  }
  function leave(e: DragEvent<HTMLElement>, key: string) {
    if (target === key && !e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null);
  }
  function drop(e: DragEvent<HTMLElement>, act: () => void) {
    e.preventDefault();
    e.stopPropagation();
    endDrag();
    act();
  }

  const draggedProject = dragging?.kind === "project" ? dragging : null;
  const draggedFolder = dragging?.kind === "folder" ? dragging : null;

  // ----- Rows -----

  function projectRow(project: SidebarProject, from: "starred" | "projects", folderId: string | null) {
    const key = `before:${project.id}`;
    const inFolder = folderId !== null;
    return (
      <li
        key={`${from}-${project.id}`}
        className={`group/row relative ${target === key ? "border-t-2 border-accent-400" : ""}`}
        onDragOver={
          inFolder
            ? (e) => over(e, key, Boolean(draggedProject) && draggedProject?.id !== project.id)
            : undefined
        }
        onDragLeave={inFolder ? (e) => leave(e, key) : undefined}
        onDrop={inFolder ? (e) => drop(e, () => draggedProject && file(draggedProject.id, folderId, project.id)) : undefined}
      >
        <Link
          href={`/projects/${project.id}`}
          aria-current={isCurrent(project.id) ? "page" : undefined}
          className={`${NAV_LINK} pr-8`}
          title={project.name}
          draggable
          onDragStart={(e) => startProjectDrag(e, project.id, from)}
          onDragEnd={endDrag}
        >
          {/* Asana's project icon: a small colored rounded square. */}
          <span aria-hidden className={`ml-0.5 size-3 shrink-0 rounded-[3px] ${projectColorClass(project.id)}`} />
          <span className="truncate">{project.name}</span>
        </Link>
        <Popover
          label={`Options for ${project.name}`}
          panelClassName="w-60 p-1.5"
          buttonClassName={ROW_MENU_BUTTON}
          button={<MoreHorizontal className="size-4" aria-hidden />}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  close();
                  star(project.id, !starredSet.has(project.id));
                }}
              >
                {starredSet.has(project.id) ? (
                  <>
                    <StarOff className="size-4 text-zinc-500" /> Remove from Starred
                  </>
                ) : (
                  <>
                    <Star className="size-4 text-zinc-500" /> Add to Starred
                  </>
                )}
              </MenuItem>
              {state.folders
                .filter((f) => f.id !== folderOf.get(project.id))
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((folder) => (
                  <MenuItem
                    key={folder.id}
                    onClick={() => {
                      close();
                      file(project.id, folder.id);
                    }}
                  >
                    <FolderInput className="size-4 text-zinc-500" />
                    <span className="truncate">Move to {folder.name}</span>
                  </MenuItem>
                ))}
              {folderOf.has(project.id) ? (
                <MenuItem
                  onClick={() => {
                    close();
                    file(project.id, null);
                  }}
                >
                  <FolderMinus className="size-4 text-zinc-500" /> Remove from folder
                </MenuItem>
              ) : null}
              <MenuItem
                onClick={() => {
                  close();
                  setCreating({ projectId: project.id });
                }}
              >
                <FolderPlus className="size-4 text-zinc-500" /> New folder with this project
              </MenuItem>
            </>
          )}
        </Popover>
      </li>
    );
  }

  function folderRow({ folder, projects: list }: { folder: SidebarFolder; projects: SidebarProject[] }, index: number) {
    const intoKey = `folder:${folder.id}`;
    const beforeKey = `folderBefore:${folder.id}`;
    const open = !folder.collapsed;
    const count = arranged.folders.length;
    const containsCurrent = list.some((p) => isCurrent(p.id));
    return (
      <li key={folder.id} className={target === beforeKey ? "border-t-2 border-accent-400" : undefined}>
        <div
          className={`group/row relative ${target === intoKey ? DROP_TARGET : ""}`}
          onDragOver={(e) => {
            if (draggedFolder) over(e, beforeKey, draggedFolder.id !== folder.id);
            else over(e, intoKey, Boolean(draggedProject) && folderOf.get(draggedProject!.id) !== folder.id);
          }}
          onDragLeave={(e) => leave(e, draggedFolder ? beforeKey : intoKey)}
          onDrop={(e) =>
            drop(e, () => {
              if (draggedFolder) saveFolder(stateFolder(draggedFolder.id)!, { sortOrder: folderOrderBefore(state.folders, draggedFolder.id, folder.id) });
              else if (draggedProject) file(draggedProject.id, folder.id);
            })
          }
        >
          {renaming === folder.id ? (
            <FolderNameInput
              label={`Rename ${folder.name}`}
              initial={folder.name}
              onDone={(name) => {
                setRenaming(null);
                if (name !== null && name.trim() !== folder.name && !folderNameProblem(name)) saveFolder(folder, { name: name.trim() });
              }}
            />
          ) : (
            <button
              type="button"
              draggable
              onDragStart={(e) => startFolderDrag(e, folder.id)}
              onDragEnd={endDrag}
              aria-expanded={open}
              onClick={() => saveFolder(folder, { collapsed: open })}
              className={`${NAV_LINK} w-full pr-8 text-left ${containsCurrent && !open ? "text-white" : ""}`}
              title={folder.name}
            >
              <ChevronRight aria-hidden className={`size-3.5 shrink-0 text-shell-muted transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? (
                <FolderOpen className="size-4 shrink-0 text-shell-muted" aria-hidden />
              ) : (
                <Folder className="size-4 shrink-0 text-shell-muted" aria-hidden />
              )}
              <span className="truncate">{folder.name}</span>
              <span className="ml-auto text-2xs tabular-nums text-shell-muted">{list.length || ""}</span>
            </button>
          )}
          {renaming === folder.id ? null : (
            <Popover
              label={`Options for the folder ${folder.name}`}
              panelClassName="w-52 p-1.5"
              buttonClassName={ROW_MENU_BUTTON}
              button={<MoreHorizontal className="size-4" aria-hidden />}
            >
              {(close) => (
                <>
                  <MenuItem
                    onClick={() => {
                      close();
                      setRenaming(folder.id);
                    }}
                  >
                    <Pencil className="size-4 text-zinc-500" /> Rename
                  </MenuItem>
                  <MenuItem
                    disabled={index === 0}
                    onClick={() => {
                      close();
                      const order = folderOrderMoved(state.folders, folder.id, -1);
                      if (order !== null) saveFolder(folder, { sortOrder: order });
                    }}
                  >
                    <ArrowUp className="size-4 text-zinc-500" /> Move up
                  </MenuItem>
                  <MenuItem
                    disabled={index === count - 1}
                    onClick={() => {
                      close();
                      const order = folderOrderMoved(state.folders, folder.id, 1);
                      if (order !== null) saveFolder(folder, { sortOrder: order });
                    }}
                  >
                    <ArrowDown className="size-4 text-zinc-500" /> Move down
                  </MenuItem>
                  <MenuItem
                    danger
                    onClick={() => {
                      close();
                      removeFolder(folder);
                    }}
                  >
                    <Trash2 className="size-4" /> Delete folder
                  </MenuItem>
                </>
              )}
            </Popover>
          )}
        </div>
        {open ? (
          <ul className="flex flex-col gap-px pl-4" aria-label={`Projects in ${folder.name}`}>
            {list.map((project) => projectRow(project, "projects", folder.id))}
            {list.length === 0 ? (
              <li className="px-2 py-1 text-xs text-shell-muted">Drag projects here, or use a project’s “…” menu.</li>
            ) : null}
          </ul>
        ) : null}
      </li>
    );
  }

  function stateFolder(folderId: string) {
    return state.folders.find((f) => f.id === folderId);
  }

  return (
    <>
      <Group
        group="starred"
        title="Starred"
        dropHighlight={target === "starred"}
        onDragOver={(e) => over(e, "starred", draggedProject !== null && draggedProject.from !== "starred" && !starredSet.has(draggedProject.id))}
        onDragLeave={(e) => leave(e, "starred")}
        onDrop={(e) => drop(e, () => draggedProject && star(draggedProject.id, true))}
      >
        {starred.map((project) => projectRow(project, "starred", null))}
        {starred.length === 0 ? (
          <li className="flex items-start gap-2 px-2 py-1 text-xs text-shell-text">
            <Star className="mt-0.5 size-3.5 shrink-0 text-shell-text" aria-hidden />
            {draggedProject ? "Drop here to star it." : "Star a project from its header, or drag one here."}
          </li>
        ) : null}
      </Group>

      <Group
        group="projects"
        title="Projects"
        dropHighlight={target === "projects"}
        onDragOver={(e) =>
          over(
            e,
            "projects",
            draggedFolder !== null ||
              (draggedProject !== null && (draggedProject.from === "starred" || folderOf.has(draggedProject.id))),
          )
        }
        onDragLeave={(e) => leave(e, "projects")}
        onDrop={(e) =>
          drop(e, () => {
            if (draggedFolder) {
              const folder = stateFolder(draggedFolder.id);
              if (folder) saveFolder(folder, { sortOrder: folderOrderBefore(state.folders, folder.id, null) });
            } else if (draggedProject?.from === "starred") {
              star(draggedProject.id, false);
            } else if (draggedProject) {
              file(draggedProject.id, null);
            }
          })
        }
        action={
          <span className="flex items-center">
            <button
              type="button"
              onClick={() => setCreating({})}
              aria-label="New folder"
              data-tooltip="New folder"
              className="rounded p-0.5 text-shell-muted hover:bg-shell-hover hover:text-white"
            >
              <FolderPlus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => openDialog({ kind: "project" })}
              aria-label="New project"
              aria-haspopup="dialog"
              data-tooltip="New project"
              className="rounded p-0.5 text-shell-muted hover:bg-shell-hover hover:text-white"
            >
              <Plus className="size-4" />
            </button>
          </span>
        }
      >
        {creating ? (
          <li className="px-1 py-0.5">
            <FolderNameInput
              label="New folder name"
              initial=""
              onDone={(name) => (name === null ? setCreating(null) : createFolder(name, creating.projectId))}
            />
          </li>
        ) : null}
        {arranged.folders.map((entry, index) => folderRow(entry, index))}
        {arranged.loose.map((project) => projectRow(project, "projects", null))}
        {projects.length === 0 ? (
          <li>
            <button
              type="button"
              onClick={() => openDialog({ kind: "project" })}
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-shell-muted hover:bg-shell-hover hover:text-white"
            >
              <Plus className="size-3.5" aria-hidden />
              Create your first project
            </button>
          </li>
        ) : null}
      </Group>
    </>
  );
}

// An inline name box: Enter saves, Escape cancels, leaving it saves what was typed (or cancels if empty).
function FolderNameInput({
  label,
  initial,
  onDone,
}: {
  label: string;
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  function finish(name: string | null) {
    if (done) return;
    setDone(true);
    onDone(name);
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(value.trim() ? value : null);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    }
  }
  return (
    <input
      // Opened by the person's own click on New folder / Rename.
      autoFocus
      aria-label={label}
      value={value}
      maxLength={MAX_FOLDER_NAME}
      placeholder="Folder name"
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value.trim() ? value : null)}
      className={NAME_INPUT}
    />
  );
}
