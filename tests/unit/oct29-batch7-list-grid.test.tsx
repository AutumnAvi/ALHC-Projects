// Oct 29 notes, batch 7 — item 53: the List's column header and its rows line up. The Name header used to
// be `relative` and `sticky` with two z-indexes, other columns' resize handles (z-[3], hanging 4px into the
// next column) painted over the pinned Name header once they scrolled behind it (Avi's stray divider ~72px
// before the Name column's end, with "Due date" half hidden), and a row's Name cell could spill badges and
// tags over the next column. Header and rows now share one grid and one pinned-cell definition
// (src/components/project/list-grid.ts); these checks hold them to it at several widths.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import {
  LIST_CELL,
  LIST_FILLER_TRACK,
  LIST_HEADER_ROW,
  LIST_PINNED_CELL,
  LIST_RESIZE_HANDLE,
  LIST_VIEW_WIDTH_VAR,
  NAME_COLUMN_ROOM,
  NAME_GAP_REM,
  NAME_GUTTER,
  NAME_INDENT,
  SUBTASK_STEP_REM,
  listGridStyle,
  listGridTemplate,
  listHeaderCellClass,
  listNameTrack,
  nameOffsetRem,
  subtaskIndentRem,
  type ListWho,
} from "@/components/project/list-grid";
import { ListView } from "@/components/project/list-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import { DEFAULT_COLUMN_WIDTHS, MIN_TASK_COLUMN_WIDTH, type ColumnWidths } from "@/lib/column-widths";
import type { Profile, ProjectTask, Section, SubtaskItem } from "@/lib/data";
import type { FieldDef } from "@/lib/fields";
import type { ProjectRole } from "@/lib/roles";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import type { Tag } from "@/lib/tags";
import { parseViewConfig, type ColumnKey } from "@/lib/views";

// ---------------------------------------------------------------------------------------------
// A small parser for React's static markup (it escapes < > " & ' in text and attributes), so the
// tests can look at the header's and rows' cells as elements.
// ---------------------------------------------------------------------------------------------

type El = { tag: string; attrs: Record<string, string>; children: El[]; parent: El | null };
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function decode(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [], parent: null };
  let current = root;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g)) {
    const [, closing, tag, attrText, selfClosing] = m;
    if (closing) {
      while (current !== root && current.tag !== tag) current = current.parent!;
      if (current !== root) current = current.parent!;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? "");
    const el: El = { tag, attrs, children: [], parent: current };
    current.children.push(el);
    if (!selfClosing && !VOID.has(tag)) current = el;
  }
  return root;
}

function all(el: El, match: (el: El) => boolean, out: El[] = []): El[] {
  for (const child of el.children) {
    if (match(child)) out.push(child);
    all(child, match, out);
  }
  return out;
}

const tokens = (el: El | string) => (typeof el === "string" ? el : (el.attrs.class ?? "")).split(/\s+/).filter(Boolean);
const hasAll = (el: El, classes: string) => tokens(classes).every((t) => tokens(el).includes(t));
const styleOf = (el: El, property: string) => {
  for (const part of (el.attrs.style ?? "").split(";")) {
    const colon = part.indexOf(":");
    if (colon > 0 && part.slice(0, colon).trim() === property) return part.slice(colon + 1).trim();
  }
  return null;
};
// z-index utilities (z-1, z-[1], hover:z-10, …) and position utilities.
const isZ = (t: string) => /^(?:[\w-[\]()@:]+:)?-?z-/.test(t);
const POSITIONS = ["static", "relative", "absolute", "fixed", "sticky"];

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, role: ProjectRole) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <ProjectAccessProvider role={role}>{node}</ProjectAccessProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const section: Section = { id: "s1", project_id: "p1", name: "To do", sort_order: 1024 };
const amy: Profile = { id: "amy", email: "amy@example.com", full_name: "Amy Pond", avatar_url: null };
const F1 = "00000000-0000-4000-8000-0000000000f1";
const priority: FieldDef = {
  id: F1,
  projectId: "p1",
  name: "Priority",
  fieldType: "single_select",
  options: [{ id: "o1", name: "High", color: "red" }],
  boundToSections: false,
  showInViews: true,
  sortOrder: 1,
  description: null,
  notifyOnChange: false,
  inLibrary: false,
};
const tags: Tag[] = ["Design", "Print", "Spring campaign"].map((name, i) => ({
  id: `g${i}`,
  name,
  color: (["blue", "green", "orange"] as const)[i],
  archivedAt: null,
  createdBy: null,
}));

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "t1",
    title: "Write the brief",
    completedAt: null,
    startOn: null,
    dueOn: "2026-11-02",
    assigneeId: "amy",
    homeProjectId: "p1",
    createdAt: "2026-10-01T00:00:00Z",
    sectionId: "s1",
    sortOrder: 1024,
    subtaskCount: 0,
    subtaskDoneCount: 0,
    projectCount: 1,
    fieldValues: { [F1]: "o1" },
    recurring: false,
    blockedBy: 0,
    kind: "task",
    approvalStatus: null,
    tagIds: [],
    commentCount: 0,
    ...over,
  };
}

function sub(id: string, parentId: string, over: Partial<SubtaskItem> = {}): SubtaskItem {
  return {
    id,
    parentId,
    title: `Subtask ${id}`,
    completedAt: null,
    assigneeId: null,
    startOn: null,
    dueOn: null,
    kind: "task",
    sortOrder: 1024,
    subtaskCount: 0,
    subtaskDoneCount: 0,
    ...over,
  };
}

const tasks = [
  task(),
  task({
    id: "t2",
    title: "Spring flyer for the lobby with a long name",
    sortOrder: 2048,
    subtaskCount: 2,
    subtaskDoneCount: 1,
    projectCount: 2,
    commentCount: 4,
    attachmentCount: 2,
    recurring: true,
    tagIds: ["g0", "g1", "g2"],
  }),
  task({ id: "t3", title: "Brand guide", sortOrder: 3072, kind: "approval", approvalStatus: "changes_requested", approvalPaused: true, commentCount: 12 }),
];
const subtasks = [sub("a", "t2", { sortOrder: 1, subtaskCount: 1 }), sub("b", "t2", { sortOrder: 2 }), sub("a1", "a")];

function renderList(role: ProjectRole, columns: ColumnKey[] | null, widths: ColumnWidths) {
  const html = render(
    <ListView
      projectId="p1"
      sections={[section]}
      tasks={tasks}
      profiles={[amy]}
      fields={[priority]}
      config={parseViewConfig(columns ? { columns } : {})}
      tags={tags}
      columnWidths={widths}
      subtasks={subtasks}
      expandedTaskIds={["t2", "a"]}
      sectionTaskCounts={{ s1: 3 }}
    />,
    role,
  );
  const root = parse(html);
  const header = all(root, (el) => el.attrs.class === LIST_HEADER_ROW);
  assert.equal(header.length, 1, "one column header");
  const taskRows = all(root, (el) => "data-task-row" in el.attrs);
  const subtaskRows = all(root, (el) => "data-subtask-row" in el.attrs);
  return { header: header[0], taskRows, subtaskRows };
}

// ---------------------------------------------------------------------------------------------
// The definitions
// ---------------------------------------------------------------------------------------------

test("one grid: Name, the view's columns at their widths, then the filler", () => {
  assert.equal(listGridTemplate({}, []), `${DEFAULT_COLUMN_WIDTHS.task}px ${LIST_FILLER_TRACK}`, "Name alone: nothing to keep room for");
  assert.equal(
    listGridTemplate({ task: 240, due: 96 }, ["assignee", "due", `field:${F1}`]),
    `${listNameTrack(240)} ${DEFAULT_COLUMN_WIDTHS.assignee}px 96px ${DEFAULT_COLUMN_WIDTHS.field}px minmax(2.5rem,1fr)`,
  );
  assert.deepEqual(listGridStyle({ task: 240 }, ["tags"]), {
    gridTemplateColumns: `${listNameTrack(240)} ${DEFAULT_COLUMN_WIDTHS.tags}px minmax(2.5rem,1fr)`,
  });
});

test("a wide Name column never covers the whole view (else every column would stay hidden behind it)", () => {
  // The saved width, unless the List's visible width (set by the List; the window's until then) less
  // NAME_COLUMN_ROOM is smaller — never under the 200px minimum.
  assert.equal(
    listNameTrack(800),
    `min(800px,max(${MIN_TASK_COLUMN_WIDTH}px,calc(var(${LIST_VIEW_WIDTH_VAR},100vw) - ${NAME_COLUMN_ROOM})))`,
  );
  assert.equal(NAME_COLUMN_ROOM, "10rem");
  assert.equal(listNameTrack(360, false), "360px", "no other columns: the saved width");
  // One track string, used by the header and every row (checked on the rendered List below).
  assert.ok(listGridTemplate({ task: 800 }, ["due"]).startsWith(`${listNameTrack(800)} `));
});

test("the pinned Name cell: one position, one z-index, the same classes in the header and the rows", () => {
  const pinnedHeader = tokens(listHeaderCellClass(true));
  // THE BUG: the Name header was `relative sticky … z-[1] … z-[2]` (whichever Tailwind printed last won).
  assert.deepEqual(pinnedHeader.filter((t) => POSITIONS.includes(t)), ["sticky"], "exactly one position");
  assert.deepEqual(pinnedHeader.filter(isZ), ["z-[1]"], "exactly one z-index");
  assert.ok(tokens(LIST_PINNED_CELL).every((t) => pinnedHeader.includes(t)), "the header uses the rows' pinned cell as is");
  for (const t of ["sticky", "left-0", "z-[1]", "overflow-hidden"]) assert.ok(tokens(LIST_PINNED_CELL).includes(t), t);
  assert.ok(!tokens(LIST_PINNED_CELL).some((t) => /^border-[rl]?$|^border-(?:r|l)-/.test(t)), "the divider isn't a border (it'd push the handle 1px in)");
  assert.ok(tokens(LIST_PINNED_CELL).includes("after:right-0") && tokens(LIST_PINNED_CELL).includes("after:w-px"), "a 1px divider on the last pixel");

  const column = tokens(listHeaderCellClass(false));
  assert.deepEqual(column.filter((t) => POSITIONS.includes(t)), ["relative"], "other header cells: relative (for their handle) only");
  assert.deepEqual(column.filter(isZ), [], "and no z-index, so nothing they hold rises above the pinned Name");
  assert.ok(tokens(LIST_CELL).every((t) => column.includes(t) && pinnedHeader.includes(t)), "every cell is a LIST_CELL");
});

test("resize handles stay inside their own cell, with no z-index, their line on the cell's last pixel", () => {
  const handle = tokens(LIST_RESIZE_HANDLE);
  assert.deepEqual(handle.filter(isZ), [], "no z-index (it was z-[3], above the pinned Name header)");
  assert.ok(handle.includes("right-0"), "anchored to its cell's right edge");
  assert.ok(!handle.some((t) => /^-(?:right|left|inset)/.test(t)), "never hangs into the next column (it was -right-1)");
  assert.ok(handle.includes("after:right-0") && handle.includes("after:w-px"), "the line is the last pixel, like the pinned divider");
});

test("the Name cell's leading controls: one definition for header, rows, subtasks, and the add rows", () => {
  // Editors: handle 1 · checkbox 0.875 · expand 1 · completion 1.125, 0.5rem apart after 0.375rem.
  assert.equal(nameOffsetRem("editor", "expand"), 3.25);
  assert.equal(nameOffsetRem("editor", "complete"), 4.75);
  assert.equal(nameOffsetRem("editor", "title"), 6.375);
  assert.equal(nameOffsetRem("viewer", "expand"), 0.75);
  assert.equal(nameOffsetRem("viewer", "complete"), 2.25);
  assert.equal(nameOffsetRem("viewer", "title"), 3.875);

  // The literal Tailwind classes are the same numbers (Tailwind only sees literal class names).
  const rem = (cls: string) => {
    const arbitrary = /^pl-\[([\d.]+)rem\]$/.exec(cls);
    if (arbitrary) return Number(arbitrary[1]);
    const scale = /^pl-([\d.]+)$/.exec(cls);
    assert.ok(scale, `unexpected class ${cls}`);
    return Number(scale[1]) * 0.25;
  };
  for (const who of ["editor", "viewer"] as ListWho[]) {
    assert.equal(rem(NAME_INDENT[who].row), NAME_GUTTER[who].padding, `${who}: the row's padding`);
    // "Name" sits over the completion circles (Asana's header); batch 6's expand arrow had left it over
    // the arrow column.
    assert.equal(rem(NAME_INDENT[who].header), nameOffsetRem(who, "complete"), `${who}: the header label`);
    assert.equal(rem(NAME_INDENT[who].title), nameOffsetRem(who, "title"), `${who}: the names`);
    // A first-level subtask's arrow is under its parent's completion circle, and so on per level.
    assert.equal(subtaskIndentRem(who, 1), nameOffsetRem(who, "complete"));
    assert.equal(subtaskIndentRem(who, 3) - subtaskIndentRem(who, 2), SUBTASK_STEP_REM);
  }
  assert.equal(SUBTASK_STEP_REM, 1 + NAME_GAP_REM);
});

// ---------------------------------------------------------------------------------------------
// The rendered List
// ---------------------------------------------------------------------------------------------

const cases: { role: ProjectRole; who: ListWho; columns: ColumnKey[] | null; widths: ColumnWidths }[] = [
  { role: "editor", who: "editor", columns: null, widths: {} },
  { role: "editor", who: "editor", columns: ["due", "assignee", `field:${F1}`, "tags"], widths: { task: 200, due: 48, assignee: 800 } },
  { role: "editor", who: "editor", columns: ["assignee", "due", "start", "section"], widths: { task: 800, start: 96, section: 300 } },
  { role: "viewer", who: "viewer", columns: null, widths: { task: 280 } },
  { role: "viewer", who: "viewer", columns: ["tags", "due"], widths: { task: 520, tags: 64 } },
];

test("header and every row (tasks and subtasks) share the grid template, at several widths", () => {
  for (const { role, columns, widths } of cases) {
    const { header, taskRows, subtaskRows } = renderList(role, columns, widths);
    const template = styleOf(header, "grid-template-columns");
    const expected = listGridTemplate(widths, columns ?? ["assignee", "due", `field:${F1}`, "tags"]);
    assert.equal(template, expected, `${role} ${JSON.stringify(widths)}: the header's tracks`);
    assert.equal(taskRows.length, 3);
    assert.equal(subtaskRows.length, 3, "open rows' subtasks (two levels)");
    const tracks = (columns ?? ["assignee", "due", `field:${F1}`, "tags"]).length + 2;
    for (const row of [header, ...taskRows, ...subtaskRows]) {
      assert.equal(styleOf(row, "grid-template-columns"), template, "same tracks as the header");
      assert.equal(row.children.length, tracks, "one cell per track");
    }
  }
});

test("only the Name cell is pinned, the same way in the header and every row; nothing else has a z-index", () => {
  for (const { role, who, columns, widths } of cases) {
    const { header, taskRows, subtaskRows } = renderList(role, columns, widths);
    for (const row of [header, ...taskRows, ...subtaskRows]) {
      const [name, ...rest] = row.children;
      assert.ok(hasAll(name, LIST_PINNED_CELL), `${role}: the first cell is the pinned Name cell`);
      assert.deepEqual(tokens(name).filter((t) => POSITIONS.includes(t)), ["sticky"]);
      assert.deepEqual(tokens(name).filter(isZ), ["z-[1]"]);
      for (const cell of rest) assert.ok(!tokens(cell).includes("sticky"), "other cells scroll");
      // Inside the header row and inside each row, the pinned cell's z-[1] is the only z-index: so no
      // other column's handle, chip, or control can paint over the pinned Name column.
      const zs = all(row, () => true).flatMap((el) => tokens(el).filter(isZ));
      assert.deepEqual(zs, ["z-[1]"], `${role} ${JSON.stringify(widths)}: z-indexes in a ${row === header ? "header" : "row"}`);
    }
    // The header's handles: one per resizable column, each inside its own cell.
    const handles = all(header, (el) => el.attrs.role === "separator");
    assert.equal(handles.length, header.children.length - 1, "Name and every column (not the filler)");
    for (const handle of handles) {
      assert.equal(handle.attrs.class, LIST_RESIZE_HANDLE);
      assert.ok(header.children.includes(handle.parent!), "a direct child of its header cell");
    }
    // The header label and the rows' leading gutter come from one definition.
    assert.ok(tokens(header.children[0]).includes(NAME_INDENT[who].header), "the Name label over the completion circles");
    for (const row of taskRows) assert.ok(tokens(row.children[0]).includes(NAME_INDENT[who].row));
    for (const row of subtaskRows) {
      const depth = row.attrs["data-subtask-row"] === "a1" ? 2 : 1;
      assert.equal(styleOf(row.children[0], "padding-left"), `${subtaskIndentRem(who, depth)}rem`);
    }
  }
});

test("a row's Name cell never spills into the next column: wide content is clipped, inline tags give way", () => {
  const { taskRows } = renderList("editor", ["assignee", "due"], { task: 200 });
  const flyer = taskRows.find((row) => row.attrs["data-task-row"] === "t2")!;
  const name = flyer.children[0];
  assert.ok(tokens(name).includes("overflow-hidden"), "the pinned cell clips at its track");
  const tagWrap = all(name, (el) => (el.attrs["aria-label"] ?? "").startsWith("Tags:"))[0]?.parent;
  assert.ok(tagWrap, "inline tags (no Tags column)");
  assert.ok(hasAll(tagWrap, "min-w-0 overflow-hidden"), "the tags shrink and clip before the open link does");
});
