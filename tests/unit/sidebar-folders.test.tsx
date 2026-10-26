// Oct 26 notes (batch 3), part 5: personal sidebar folders and dragging between Starred and Projects.
// The database keeps folders private (suite zz32: own rows only, nobody files into someone else's
// folder); here: how the sidebar arranges them, and that a placement pointing at a folder that isn't the
// viewer's own never moves a project out of Projects.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ShellProvider } from "@/components/shell/shell-context";
import { SidebarProjects } from "@/components/shell/sidebar-projects";
import { ToastProvider } from "@/components/toast";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import {
  applySidebarChange,
  arrangeSidebar,
  folderNameProblem,
  folderOrderBefore,
  folderOrderMoved,
  orderBetween,
  placementOrder,
  type SidebarFolderState,
} from "@/lib/sidebar-folders";

const projects = [
  { id: "p1", name: "Brand refresh" },
  { id: "p2", name: "Website" },
  { id: "p3", name: "Q4 events" },
];
const state: SidebarFolderState = {
  folders: [
    { id: "f2", name: "Internal", collapsed: false, sortOrder: 2048 },
    { id: "f1", name: "Clients", collapsed: false, sortOrder: 1024 },
  ],
  placements: [
    { projectId: "p2", folderId: "f1", sortOrder: 2048 },
    { projectId: "p1", folderId: "f1", sortOrder: 1024 },
    // A folder that isn't one of the viewer's (never returned by RLS, but never trusted either).
    { projectId: "p3", folderId: "someone-elses-folder", sortOrder: 1024 },
  ],
};

test("folders in their order, each with its projects; everything else stays under Projects", () => {
  const arranged = arrangeSidebar(projects, state);
  assert.deepEqual(
    arranged.folders.map((f) => [f.folder.name, f.projects.map((p) => p.id)]),
    [
      ["Clients", ["p1", "p2"]],
      ["Internal", []],
    ],
  );
  assert.deepEqual(arranged.loose.map((p) => p.id), ["p3"], "a placement in a folder that isn't yours is ignored");
});

test("a project you can no longer open isn't shown, even if it was filed", () => {
  const arranged = arrangeSidebar(projects.slice(1), state);
  assert.deepEqual(arranged.folders[0].projects.map((p) => p.id), ["p2"]);
});

test("ordering: midpoints, Move up / down, dropping a folder in front of another", () => {
  assert.equal(orderBetween(null, null), 1024);
  assert.equal(orderBetween(1024, 2048), 1536);
  assert.equal(orderBetween(null, 1024), 0);
  assert.equal(orderBetween(2048, null), 3072);
  assert.equal(folderOrderMoved(state.folders, "f2", -1), 0, "Internal moves above Clients");
  assert.equal(folderOrderMoved(state.folders, "f1", -1), null, "the first can't move up");
  assert.equal(folderOrderMoved(state.folders, "f1", 1), 3072, "Clients moves below Internal");
  assert.equal(folderOrderBefore(state.folders, "f2", "f1"), 0);
  assert.equal(folderOrderBefore(state.folders, "f1", null), 3072);
  assert.equal(placementOrder(state, "f1", "p3", "p2"), 1536, "between Brand refresh and Website");
  assert.equal(placementOrder(state, "f1", "p3", null), 3072, "at the end");
});

test("optimistic changes: star, file, remove a folder", () => {
  const start = { ...state, starredIds: ["p2"] };
  assert.deepEqual(applySidebarChange(start, { type: "star", projectId: "p1", starred: true }).starredIds, ["p2", "p1"]);
  assert.deepEqual(applySidebarChange(start, { type: "star", projectId: "p2", starred: false }).starredIds, []);
  const filed = applySidebarChange(start, { type: "file", projectId: "p3", folderId: "f2", sortOrder: 1024 });
  assert.deepEqual(arrangeSidebar(projects, filed).folders[1].projects.map((p) => p.id), ["p3"]);
  const removed = applySidebarChange(start, { type: "removeFolder", folderId: "f1" });
  const arranged = arrangeSidebar(projects, removed);
  assert.deepEqual(arranged.folders.map((f) => f.folder.id), ["f2"]);
  assert.deepEqual(arranged.loose.map((p) => p.id), ["p1", "p2", "p3"], "its projects are back under Projects");
});

test("folder names", () => {
  assert.equal(folderNameProblem("  "), "Give the folder a name");
  assert.equal(folderNameProblem("x".repeat(61)), "Folder names are at most 60 characters");
  assert.equal(folderNameProblem(" Clients "), null);
});

test("the sidebar draws folders, starred projects, and a menu on every row", () => {
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const html = renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider
            member={{ id: "me", email: "me@example.com", name: "Me" } as never}
            isWorkspaceAdmin={false}
            workspace={{ name: "ALHC", logoUrl: null }}
            initialSidebar={DEFAULT_SIDEBAR_PREFS}
          >
            <ToastProvider>
              <SidebarProjects projects={projects} starredIds={["p3"]} folders={state} pathname="/projects/p1/list" />
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
  assert.match(html, /Clients/);
  assert.match(html, /Internal/);
  assert.match(html, /aria-label="Projects in Clients"/);
  assert.match(html, /Drag projects here/, "an empty folder says how to fill it");
  assert.match(html, /aria-label="New folder"/);
  assert.match(html, /aria-label="Options for Brand refresh"/);
  assert.match(html, /aria-label="Options for the folder Clients"/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /aria-current="page"/, "the open project is marked");
});
