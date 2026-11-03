// Nov 3 notes, batch 19 (video bugs): role wording, the Settings → Workspace tab, and quick-add rows that
// show while they save. Pure rules plus a look at the sources that draw them.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { QUICK_ADD_PENDING_SCOPE } from "@/lib/checklist";
import { unresolvedPendingCreates } from "@/lib/pending-creates";
import { ROLE_LABELS, PORTFOLIO_ROLE_LABELS, roleWithArticle } from "@/lib/roles";
import { SETTINGS_TABS, isSettingsTab } from "@/lib/shell";

test("portfolio and project cards say “an Owner”, never “a Owner”", () => {
  assert.equal(roleWithArticle(ROLE_LABELS.owner), "an Owner");
  assert.equal(roleWithArticle(ROLE_LABELS.admin), "an Admin");
  assert.equal(roleWithArticle(ROLE_LABELS.editor), "an Editor");
  assert.equal(roleWithArticle(ROLE_LABELS.commenter), "a Commenter");
  assert.equal(roleWithArticle(ROLE_LABELS.viewer), "a Viewer");
  assert.equal(roleWithArticle(PORTFOLIO_ROLE_LABELS.owner), "an Owner");
  for (const file of [
    "src/components/portfolio/portfolio-overview.tsx",
    "src/components/portfolio/portfolio-members.tsx",
    "src/components/project/members-manager.tsx",
    "src/components/project/share-dialog.tsx",
  ]) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /\? "an" : "a"/, `${file} picks the article from the label`);
  }
});

test("members have a Workspace tab in Settings", () => {
  assert.ok(SETTINGS_TABS.some((t) => t.key === "workspace" && t.label === "Workspace"));
  assert.equal(isSettingsTab("workspace"), true);
  const panel = fs.readFileSync("src/components/settings/settings-panel.tsx", "utf8");
  assert.match(panel, /tab === "workspace"/);
  assert.match(panel, /ONLY_ADMINS_NOTE/, "members read “Only workspace admins can change this.”");
});

test("a quick-added task shows at once and gives way to the saved one", () => {
  const open = [{ id: "a", title: "Existing" }];
  const entries = [
    { key: "k1", scope: QUICK_ADD_PENDING_SCOPE, title: "zz phone call", known: new Set(["a"]), savedId: "new-1", addedAt: 0 },
    { key: "k2", scope: QUICK_ADD_PENDING_SCOPE, title: "zz undated item", known: new Set(["a"]), savedId: null, addedAt: 0 },
  ];
  assert.deepEqual(
    unresolvedPendingCreates(QUICK_ADD_PENDING_SCOPE, open, entries).map((e) => e.key),
    ["k1", "k2"],
  );
  const refreshed = [...open, { id: "new-1", title: "zz phone call" }, { id: "new-2", title: "zz undated item" }];
  assert.deepEqual(unresolvedPendingCreates(QUICK_ADD_PENDING_SCOPE, refreshed, entries), []);
});

test("the quick add never locks while an earlier add is saving", () => {
  const source = fs.readFileSync("src/components/my-tasks/quick-add.tsx", "utf8");
  assert.doesNotMatch(source, /disabled=\{pending/, "the box and Add button stay usable");
  assert.doesNotMatch(source, /!parsed \|\| pending/, "Enter is never dropped");
  assert.match(source, /withPendingCreate\(\s*QUICK_ADD_PENDING_SCOPE/);
  const checklist = fs.readFileSync("src/components/my-tasks/checklist.tsx", "utf8");
  assert.match(checklist, /usePendingCreates\(QUICK_ADD_PENDING_SCOPE/);
  assert.match(checklist, /Repeats\n/, "the repeat mark is spelled out");
});

test("Customize → Emails shows Deliveries to Admins only", () => {
  const source = fs.readFileSync("src/components/project/customize-panel.tsx", "utf8");
  assert.match(source, /\{canManage \? <SubHeading>Deliveries<\/SubHeading> : null\}/);
});
