// Nov 2 notes, batch 14: optimistic sections (92), Show completed as a view option (93 / 102), personal view
// changes and section order (94), template customization and project roles (95), the bulk Field icons (96),
// the overlay registry and layers (99), Asana tokens for attachments (103), and Slack destinations (105).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldTypeIcon } from "@/components/project/field-type-icon";
import { filterChips } from "@/components/project/filter-editor";
import {
  PENDING_SECTION_PREFIX,
  isPendingSection,
  pendingSortOrder,
  unresolvedPending,
  type PendingSection,
} from "@/components/project/pending-sections";
import { closeAllPopovers, openPopoverCount, registerPopover } from "@/components/overlay-registry";
import { LAYER_Z } from "@/lib/layers";
import { asanaTokenProblem, describeAttachmentFiles } from "@alhc/core/imports-shared";
import {
  cleanCustomization,
  customizationSummary,
  describeRoleUpdate,
  templateOutline,
  EMPTY_CUSTOMIZATION,
} from "@alhc/core/project-roles";
import { roleOfSlot, roleSlot } from "@alhc/core/rules";
import {
  destinationLabel,
  isSlackWebApi,
  parseSlackSettings,
  slackApiError,
  slackManifestUrl,
  slackTokenProblem,
  SLACK_POST_MESSAGE_URL,
} from "@alhc/core/slack";
import { orderSections, parseViewConfig, pruneConfig, sameConfig, withSectionMoved } from "@alhc/core/views";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const N = "44444444-4444-4444-8444-444444444444";
const sections = [
  { id: A, name: "A", sort_order: 1024 },
  { id: B, name: "B", sort_order: 2048 },
  { id: C, name: "C", sort_order: 3072 },
];

// ---------------------------------------------------------------------------------------------
// 94 A view's own section order
// ---------------------------------------------------------------------------------------------

test("94: section_order reorders listed sections in their own slots; others keep their place", () => {
  assert.deepEqual(orderSections(sections, {}).map((s) => s.id), [A, B, C], "no order = the project's");
  assert.deepEqual(orderSections(sections, { section_order: [C, A, B] }).map((s) => s.id), [C, A, B]);
  const withNew = [...sections, { id: N, name: "New", sort_order: 1500 }].sort((a, b) => a.sort_order - b.sort_order);
  assert.deepEqual(
    orderSections(withNew, { section_order: [C, A, B] }).map((s) => s.id),
    [C, N, A, B],
    "a section added later shows where it was added",
  );
});

test("94: moving a section is a draft of the config; back to the project's order drops the key", () => {
  const moved = withSectionMoved({}, sections, C, A);
  assert.deepEqual(moved.section_order, [C, A, B]);
  const back = withSectionMoved(moved, sections, C, null);
  assert.equal(back.section_order, undefined, "the project's own order needs no key");
  assert.ok(sameConfig(back, {}));
  const plain = {};
  assert.equal(withSectionMoved(plain, sections, A, A), plain, "a no-op returns the config itself");
  const pending = [...sections, { id: `${PENDING_SECTION_PREFIX}x`, name: "Saving", sort_order: 9999 }];
  assert.deepEqual(
    withSectionMoved({}, pending, B, null, (s) => !isPendingSection(s)).section_order,
    [A, C, B],
    "sections still being saved never enter the order",
  );
});

test("94: section_order parses, dedupes, keeps only uuids, and prunes deleted sections", () => {
  const parsed = parseViewConfig({ section_order: [B, B, "nope", A, 7] });
  assert.deepEqual(parsed.section_order, [B, A]);
  assert.equal(parseViewConfig({ section_order: [] }).section_order, undefined);
  const pruned = pruneConfig(parsed, { sectionIds: new Set([A]), fields: [], profileIds: new Set() });
  assert.deepEqual(pruned.section_order, [A]);
  assert.equal(pruneConfig({ section_order: [B] }, { sectionIds: new Set([A]), fields: [], profileIds: new Set() }).section_order, undefined);
});

test("94: the toolbar offers Save for me, and Save as default for everyone only to those allowed", () => {
  const source = fs.readFileSync("src/components/project/view-toolbar.tsx", "utf8");
  assert.match(source, /Save for me/);
  assert.match(source, /Save as default for everyone/);
  assert.match(source, /ownView \|\| !canSaveForEveryone/, "below Owner it's just Save for me (hidden, not greyed out)");
  assert.match(source, /Reset to default/);
});

// ---------------------------------------------------------------------------------------------
// 92 Optimistic sections
// ---------------------------------------------------------------------------------------------

test("92: a pending section sorts where it was added and goes once the saved one arrives", () => {
  assert.equal(pendingSortOrder(sections, null), 4096, "after the last");
  assert.equal(pendingSortOrder(sections, B), 1536, "between the one above and `before`");
  assert.equal(pendingSortOrder(sections, A), 0, "before the first");
  const pending: PendingSection = {
    id: `${PENDING_SECTION_PREFIX}1`,
    project_id: "p1",
    name: "Review",
    sort_order: 4096,
    pending: true,
    known: new Set([A, B, C]),
  };
  const page = sections.map((s) => ({ ...s, project_id: "p1" }));
  assert.equal(unresolvedPending("p1", page, [pending]).length, 1, "still saving");
  assert.equal(unresolvedPending("p2", page, [pending]).length, 0, "other projects don't show it");
  const saved = [...page, { id: N, project_id: "p1", name: "Review", sort_order: 4096 }];
  assert.equal(unresolvedPending("p1", saved, [pending]).length, 0, "the saved section replaces it");
  const renamed = [...page.map((s) => (s.id === A ? { ...s, name: "Review" } : s))];
  assert.equal(unresolvedPending("p1", renamed, [pending]).length, 1, "an older section renamed alike doesn't count");
});

// ---------------------------------------------------------------------------------------------
// 93 / 102 Show completed is a view option
// ---------------------------------------------------------------------------------------------

test("93 / 102: showing completed tasks isn't a filter chip in the toolbar; Completed only still is", () => {
  const context = { sections: [], profiles: [], fields: [] };
  assert.equal(filterChips({ completion: "all" }, context, { completionIsViewOption: true }).length, 0);
  assert.equal(filterChips({ completion: "all" }, context).length, 1, "elsewhere (dashboards) it still reads as a chip");
  assert.equal(filterChips({ completion: "completed" }, context, { completionIsViewOption: true }).length, 1);
  const source = fs.readFileSync("src/components/project/view-toolbar.tsx", "utf8");
  assert.match(source, /role="switch"/, "one switch-like button");
  assert.ok(!/>\s*Hide completed\s*</.test(source) && /\n\s*Show completed\n/.test(source), "its label never changes width");
});

// ---------------------------------------------------------------------------------------------
// 95 Project roles and Customize before creating
// ---------------------------------------------------------------------------------------------

const snapshot = {
  sections: [
    { id: A, name: "Intake" },
    { id: B, name: "Design" },
  ],
  tasks: [
    { id: C, title: "Brief", section_id: A },
    { id: N, title: "Mockups", section_id: B },
  ],
  fields: [
    { id: "f1", name: "Priority", field_type: "single_select" },
    { id: "f2", name: "Status", field_type: "single_select", bound_to_sections: true },
  ],
  roles: [{ id: "r1", name: "Designer" }, { id: "r2", name: "" }],
};

test("95: the template outline lists sections, tasks, fields (not the bound Status), and named roles", () => {
  const outline = templateOutline(snapshot);
  assert.deepEqual(outline.sections.map((s) => s.name), ["Intake", "Design"]);
  assert.deepEqual(outline.tasks.map((t) => [t.title, t.sectionId]), [["Brief", A], ["Mockups", B]]);
  assert.deepEqual(outline.fields.map((f) => f.name), ["Priority"]);
  assert.deepEqual(outline.roles.map((r) => r.name), ["Designer"]);
  assert.deepEqual(templateOutline(null), { sections: [], tasks: [], fields: [], roles: [] });
});

test("95: only real edits are sent; a left-out section takes its added tasks with it", () => {
  const outline = templateOutline(snapshot);
  const edits = cleanCustomization(
    {
      sections: { [A]: { skip: true }, [B]: { name: " Design " } },
      tasks: { [N]: { title: "Mockups v2" } },
      fields: { f1: { skip: true } },
      added_tasks: [
        { section_id: A, title: "Gone with Intake" },
        { section_id: B, title: "  Extra  " },
        { section_id: B, title: "   " },
      ],
      roles: { r1: "person-1" },
    },
    outline,
  );
  assert.deepEqual(edits.sections, { [A]: { skip: true } }, "an unchanged name isn't an edit");
  assert.deepEqual(edits.tasks, { [N]: { title: "Mockups v2" } });
  assert.deepEqual(edits.fields, { f1: { skip: true } });
  assert.deepEqual(edits.added_tasks, [{ section_id: B, title: "Extra" }]);
  assert.deepEqual(edits.roles, { r1: "person-1" });
  assert.equal(customizationSummary(EMPTY_CUSTOMIZATION), null);
  assert.match(customizationSummary(edits) ?? "", /left out/);
});

test("95: role slots and messages", () => {
  assert.equal(roleSlot("abc"), "project_role:abc");
  assert.equal(roleOfSlot("project_role:abc"), "abc");
  assert.equal(roleOfSlot("field:abc"), null);
  assert.equal(describeRoleUpdate("Designer", 3, 0), "Updated 3 open tasks for Designer");
  assert.match(describeRoleUpdate("Designer", 0, 1), /No open tasks needed a change for Designer; 1 couldn’t be changed/);
});

// ---------------------------------------------------------------------------------------------
// 96 Bulk Field icons, 97 cursor row
// ---------------------------------------------------------------------------------------------

test("96: the bulk bar's Field picker shows each field's type icon (the Fields list's icons)", () => {
  const number = renderToStaticMarkup(<FieldTypeIcon field={{ fieldType: "number", boundToSections: false }} />);
  const people = renderToStaticMarkup(<FieldTypeIcon field={{ fieldType: "people", boundToSections: false }} />);
  assert.notEqual(number, people);
  const bulk = fs.readFileSync("src/components/bulk/bulk-bar.tsx", "utf8");
  assert.match(bulk, /icon: <FieldTypeIcon field=\{f\}/);
  const editor = fs.readFileSync("src/components/project/field-editor.tsx", "utf8");
  assert.match(editor, /from "@\/components\/project\/field-type-icon"/, "one icon map");
});

test("97: the keyboard cursor lights the whole row", () => {
  const list = fs.readFileSync("src/components/project/list-view.tsx", "utf8");
  assert.match(list, /const lit = selected \|\| open \|\| active;/);
  const mine = fs.readFileSync("src/components/my-tasks/my-tasks-view.tsx", "utf8");
  assert.match(mine, /selected \|\| selection\.cursor === task\.id \? "bg-accent-50"/);
});

// ---------------------------------------------------------------------------------------------
// 99 Overlays
// ---------------------------------------------------------------------------------------------

test("99: one popover at a time, nested ones stay, and a modal closes them all", () => {
  closeAllPopovers();
  const closed: string[] = [];
  const panel = (name: string, inside: Set<object>) => ({
    close: () => closed.push(name),
    contains: (node: Node) => inside.has(node as unknown as object),
  });
  const menuButton = {} as Node;
  const pickerButton = {} as Node;
  const otherButton = {} as Node;
  const menuInside = new Set<object>([menuButton, pickerButton]);
  const offMenu = registerPopover(panel("menu", menuInside), menuButton);
  const offPicker = registerPopover(panel("picker", new Set([pickerButton])), pickerButton);
  assert.deepEqual(closed, [], "a picker opened inside the menu keeps the menu open");
  assert.equal(openPopoverCount(), 2);
  registerPopover(panel("other", new Set([otherButton])), otherButton);
  assert.deepEqual(closed.sort(), ["menu", "picker"], "another menu closes both");
  closeAllPopovers();
  assert.deepEqual(closed.sort(), ["menu", "other", "picker"], "a modal closes the rest");
  assert.equal(openPopoverCount(), 0);
  offMenu();
  offPicker();
});

test("99: the palette sits above every menu, and alerts above the palette", () => {
  assert.ok(LAYER_Z.palette > LAYER_Z.popover && LAYER_Z.palette > LAYER_Z.floating);
  assert.ok(LAYER_Z.popover > LAYER_Z.modal, "a menu opened in a dialog shows over it");
  assert.ok(LAYER_Z.alert > LAYER_Z.palette && LAYER_Z.toast > LAYER_Z.alert);
  const palette = fs.readFileSync("src/components/shell/search-palette.tsx", "utf8");
  assert.match(palette, /fixed inset-0 z-\[75\]/);
  assert.match(palette, /useClosesPopovers\(\)/);
  assert.match(palette, /See all tasks matching/, "101: the quick jump points at the full results page");
});

// ---------------------------------------------------------------------------------------------
// 103 Asana token for attachments
// ---------------------------------------------------------------------------------------------

test("103: Asana personal access tokens are checked for shape only; files left as links are counted", () => {
  assert.equal(asanaTokenProblem(""), null, "optional");
  assert.equal(asanaTokenProblem("2/1204567890123/1209876543210:0123456789abcdef0123456789abcdef"), null);
  assert.match(asanaTokenProblem("hunter2") ?? "", /personal access token/);
  assert.match(
    describeAttachmentFiles({ downloaded: 2, need_token: 3 }) ?? "",
    /2 attachment files downloaded; 3 files left as links \(no Asana token\)/,
  );
  const settings = fs.readFileSync("src/components/project/import-settings.tsx", "utf8");
  assert.match(settings, /This export has no attachments/);
  assert.match(settings, /never saved/);
});

// ---------------------------------------------------------------------------------------------
// 105 Slack
// ---------------------------------------------------------------------------------------------

test("105: slack_settings parses to names and hints only", () => {
  const s = parseSlackSettings({
    connected: true,
    team_name: "Autumn Lake",
    destinations: [
      { id: "d1", kind: "channel", name: "design", is_private: false, available: true },
      { id: "d2", kind: "webhook", name: "Marketing", hint: "hooks.slack.com …abcd", available: true },
      { kind: "channel" },
    ],
    legacy_projects: 2,
  });
  assert.equal(s.connected, true);
  assert.deepEqual(s.destinations.map(destinationLabel), ["#design", "Marketing"]);
  assert.equal(s.legacyProjects, 2);
  assert.equal(parseSlackSettings(null).connected, false);
});

test("105: tokens, Slack's own errors, and the app manifest", () => {
  assert.match(slackTokenProblem("") ?? "", /Bot User OAuth Token/);
  assert.match(slackTokenProblem("abc") ?? "", /xoxb-/);
  assert.equal(slackTokenProblem("xoxb-1234-5678-abcdefghijkl"), null);
  assert.equal(slackApiError('{"ok":true}'), null);
  assert.match(slackApiError('{"ok":false,"error":"not_in_channel"}') ?? "", /isn’t in that channel/);
  assert.match(slackApiError("not json") ?? "", /unexpected/);
  assert.ok(isSlackWebApi(SLACK_POST_MESSAGE_URL) && !isSlackWebApi("https://hooks.slack.com/services/x"));
  const manifest = JSON.parse(decodeURIComponent(slackManifestUrl().split("manifest_json=")[1]));
  assert.deepEqual(manifest.oauth_config.scopes.bot.sort(), ["channels:read", "chat:write", "chat:write.public", "groups:read"]);
});

test("105: the drain reads Slack's ok / error and sends the stored bot token only to Slack's Web API", () => {
  const drain = fs.readFileSync("src/lib/integrations.ts", "utf8");
  assert.match(drain, /row\.channel === "slack" && isSlackWebApi\(row\.target_url\)/);
  assert.match(drain, /slackApiError\(response\.body\)/);
});
