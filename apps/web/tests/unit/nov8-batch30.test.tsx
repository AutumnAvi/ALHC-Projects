// Nov 8 notes, batch 30 — the Customize panel redesign (customize-opus/PROPOSAL.md). The home screen's three
// groups with a name and one count per row and only what each role can use, task numbering's inline switch
// (the prefix only on its own page), Automations grouped On / Off, the shared pattern of the side pages, no
// Task types and templates card, and task templates in the "+ Add task" menu. The pure rules are pinned in
// packages/core/tests/nov8-batch30.test.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ToastProvider } from "@/components/toast";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { CustomizeHome, LOCK_SECTIONS_TIP, type CustomizeSummary } from "@/components/project/customize-panel";
import { AutomationsView } from "@/components/project/customize/automations";
import { PanelSwitch } from "@/components/project/customize/ui";
import { emptyNumbering } from "@alhc/core/request-numbers";
import type { ProjectRole } from "@alhc/core/roles";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

function render(node: ReactNode, role: ProjectRole = "owner") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/views/v1">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ToastProvider>
            <ProjectAccessProvider role={role}>{node}</ProjectAccessProvider>
          </ToastProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

function summary(overrides: Partial<CustomizeSummary> = {}): CustomizeSummary {
  const rule = (id: string, name: string, enabled: boolean, actionTypes: string[] = []) => ({
    id,
    name,
    enabled,
    trigger: "When a task is created",
    actionTypes,
    branches: 1,
  });
  return {
    fields: [],
    sectionNames: [],
    forms: [
      { id: "f1", title: "Design request", open: true, sendsConfirmation: true },
      { id: "f2", title: "Event intake", open: false, sendsConfirmation: false },
    ],
    rules: [
      rule("r1", "When due date changes → Add a comment and notify the assignee", true, ["send_email"]),
      rule("r2", "Greetings", false, ["send_email"]),
      rule("r3", "Rule 1 trigger", false),
    ],
    statusTemplates: [],
    statusTemplatesAvailable: true,
    numbering: { ...emptyNumbering(), enabled: true, template: "MKT-{n:3}", wrapBrackets: false, nextNumber: 12 },
    sections: [],
    owner: { sectionsLocked: true },
    tabs: [
      { kind: "tab", key: "overview", label: "Overview", layout: null, hidden: false },
      { kind: "view", key: "v1", label: "List", layout: "list", hidden: false },
      { kind: "view", key: "v2", label: "Timeline", layout: "timeline", hidden: true },
      { kind: "tab", key: "messages", label: "Messages", layout: null, hidden: true },
    ],
    ...overrides,
  };
}

function home(role: ProjectRole, overrides: Partial<CustomizeSummary> = {}) {
  return render(
    <CustomizeHome projectId="p1" summary={summary(overrides)} counts={{ unnumbered: 248, labelled: 248 }} details={null} onOpen={() => {}} />,
    role,
  );
}

test("home: three light groups, every item on the first screen, a name and one count each", () => {
  const html = home("owner");
  for (const heading of ["Build", "Connect", "Project settings"]) assert.match(html, new RegExp(`<h3[^>]*>${heading}`));
  for (const item of ["Automations", "Fields", "Forms", "Emails", "Apps", "Task numbering", "Lock sections", "Tabs", "Status templates"]) {
    assert.ok(html.includes(`>${item}<`), `${item} is on the first screen`);
  }
  // Emails counts the automations that email plus forms that confirm; Tabs says "2 hidden", not 4.
  assert.match(html, />Emails<\/span><span[^>]*>3</);
  assert.match(html, />Tabs<\/span><span[^>]*>2 hidden</);
  assert.doesNotMatch(html, /Task types and templates/);
  assert.doesNotMatch(html, /Owner settings|Owners only/, "Lock sections has no Owners tag");
  // No summary lines under the items (the old cards had a text-xs line under each name).
  assert.doesNotMatch(html, /automations that move, assign|Priority, status, and other details|Saved layouts/);
});

test("home: task numbering is a switch with the next label; the prefix is never inline", () => {
  const html = home("owner");
  assert.match(html, /MKT-012/);
  assert.match(html, /role="switch" aria-checked="true" aria-label="Number new tasks"/);
  assert.doesNotMatch(html, /Prefix/, "the prefix is set on the numbering page only");
  const off = home("owner", { numbering: { ...emptyNumbering(), enabled: false, template: "MKT-{n:3}" } });
  assert.match(off, /role="switch" aria-checked="false" aria-label="Number new tasks"/);
  assert.doesNotMatch(off, /MKT-0/, "no label while numbering is off");
});

test("home: Lock sections is a plain switch with its explanation on hover", () => {
  const html = home("owner");
  assert.ok(html.includes(`data-tooltip="${LOCK_SECTIONS_TIP}"`));
  assert.match(html, /aria-checked="true" aria-label="Lock sections"/);
});

test("home: each role sees only what it can use (an Editor sees no Lock sections or Apps)", () => {
  const html = home("editor", { owner: null });
  assert.ok(!html.includes(">Lock sections<"));
  assert.ok(!html.includes(">Apps<"));
  for (const item of ["Automations", "Fields", "Forms", "Emails", "Task numbering", "Tabs", "Status templates"]) {
    assert.ok(html.includes(`>${item}<`), `${item} is still there`);
  }
  const admin = home("admin", { owner: null });
  assert.ok(admin.includes(">Apps<") && !admin.includes(">Lock sections<"));
});

test("one switch size everywhere", () => {
  const html = renderToStaticMarkup(<PanelSwitch checked label="x" onChange={() => {}} />);
  assert.match(html, /h-4 w-7/);
  for (const file of ["customize-panel.tsx", "customize/pages.tsx", "customize/automations.tsx", "customize/numbering.tsx"]) {
    const source = fs.readFileSync(`src/components/project/${file}`, "utf8");
    assert.doesNotMatch(source, /role="switch"/, `${file} uses PanelSwitch`);
  }
});

test("Automations: grouped On and Off, full names, the … menu only on hover", () => {
  const html = render(<AutomationsView base="/projects/p1" back="/projects/p1/views/v1" projectId="p1" rules={summary().rules} />, "admin");
  assert.match(html, /On<span[^>]*>1<\/span>/);
  assert.match(html, /Off<span[^>]*>2<\/span>/);
  assert.match(html, /line-clamp-2/, "names wrap to two lines instead of being cut");
  assert.match(html, /aria-label="More for Greetings"[^>]*class="[^"]*opacity-0 group-hover:opacity-100/);
  assert.match(html, /role="tab"[^>]*>Automations<span[^>]*>3<\/span>/);
  assert.match(html, />Templates</);
  assert.match(html, />History</);
  assert.match(html, /Open full page/);
  const editor = render(<AutomationsView base="/projects/p1" back="/x" projectId="p1" rules={summary().rules} />, "editor");
  assert.doesNotMatch(editor, /role="switch"|More for/, "below Admin automations are read-only");
});

test("side pages share one footer link and keep Deliveries for Admins", () => {
  const pages = fs.readFileSync("src/components/project/customize/pages.tsx", "utf8");
  assert.match(pages, /\{canManage \? \(\s*<FooterLink\s*href=\{`\$\{base\}\/settings\/deliveries`\}/, "the Emails delivery log is Admin+");
  assert.doesNotMatch(pages, /title="Deliveries"/, "Deliveries left Apps");
  assert.match(pages, /\/> From the field library\n/);
});

test("task templates moved to the + Add task menu", () => {
  const panel = fs.readFileSync("src/components/project/customize-panel.tsx", "utf8");
  assert.doesNotMatch(panel, /TypesView|taskTemplates/);
  const toolbar = fs.readFileSync("src/components/project/view-toolbar.tsx", "utf8");
  assert.match(toolbar, />From a template</);
  assert.match(toolbar, /createTaskFromTemplate\(template\.id, topSectionId, null\)/);
  assert.match(toolbar, /Manage templates…/);
});
