// Oct 25 notes, note 2 — role clarity: the one role picker lists every role with what it can do,
// greys out what the viewer can't give (Commenter with where to turn it on), and "Their default role"
// resolves like the database's default_project_role_for().
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { portfolioRoleOptions, projectRoleOptions, teamRoleOptions } from "@/components/role-picker";
import { SmartPicker } from "@/components/smart-picker";
import { COMMENTER_OFF_REASON, ROLE_DESCRIPTIONS, assignableRoles, effectiveDefaultRole, PERSON_DEFAULT_ROLE } from "@/lib/roles";

test("the four project roles are listed, highest first, each with a one-line hint (Oct 26 notes)", () => {
  const options = projectRoleOptions({ grantable: assignableRoles("owner", true), allowCommenter: true });
  assert.deepEqual(options.map((o) => o.value), ["owner", "editor", "commenter", "viewer"]);
  for (const o of options) {
    assert.equal(o.description, ROLE_DESCRIPTIONS[o.value as keyof typeof ROLE_DESCRIPTIONS]);
    assert.ok(o.description && !o.description.includes("\n"), `${o.value} has a one-line hint`);
    assert.ok(!o.disabled, `${o.value} is offered to an owner`);
  }
  // Admin is no longer handed out; someone who already has it still sees it as their current role.
  assert.ok(!assignableRoles("owner", true).includes("admin"));
  const older = projectRoleOptions({ grantable: assignableRoles("owner", true), allowCommenter: true, current: "admin" });
  assert.deepEqual(older.map((o) => o.value), ["owner", "admin", "editor", "commenter", "viewer"]);
});

test("Commenter is greyed out (not hidden) while the workspace has it off", () => {
  const options = projectRoleOptions({ grantable: assignableRoles("owner", false), allowCommenter: false });
  const commenter = options.find((o) => o.value === "commenter");
  assert.ok(commenter, "still listed");
  assert.equal(commenter.disabled, true);
  assert.equal(commenter.disabledReason, COMMENTER_OFF_REASON);
  assert.equal(COMMENTER_OFF_REASON, "Turn on in Admin console → Security");
  // Someone who already is a Commenter keeps it selectable.
  const current = projectRoleOptions({ grantable: assignableRoles("owner", false), allowCommenter: false, current: "commenter" });
  assert.ok(!current.find((o) => o.value === "commenter")?.disabled);
});

test("roles the viewer can't give are greyed out with the reason", () => {
  const admin = projectRoleOptions({ grantable: assignableRoles("admin", true), allowCommenter: true });
  assert.equal(admin.find((o) => o.value === "owner")?.disabled, true);
  assert.match(admin.find((o) => o.value === "owner")?.disabledReason ?? "", /owners/);
  const inviting = projectRoleOptions({ grantable: assignableRoles("owner", true), allowCommenter: true, inviting: true });
  assert.equal(inviting.find((o) => o.value === "owner")?.disabled, true, "owners are made from the list");
});

test("“Their default role” comes first when asked for", () => {
  const options = projectRoleOptions({ grantable: ["editor", "viewer"], allowCommenter: true, includeDefault: true });
  assert.equal(options[0].value, PERSON_DEFAULT_ROLE);
  assert.match(options[0].description ?? "", /default/i);
});

test("a default role resolves like the database", () => {
  assert.equal(effectiveDefaultRole(null, true), "editor", "no default = Editor");
  assert.equal(effectiveDefaultRole("viewer", false), "viewer");
  assert.equal(effectiveDefaultRole("commenter", true), "commenter");
  assert.equal(effectiveDefaultRole("commenter", false), "viewer", "Commenter off → Viewer");
  assert.equal(effectiveDefaultRole("admin", true), "editor", "never more than Editor");
});

test("portfolio and team roles use the same picker", () => {
  assert.deepEqual(portfolioRoleOptions({ grantable: ["admin", "editor", "viewer"] }).map((o) => [o.value, Boolean(o.disabled)]), [
    ["owner", true],
    ["admin", false],
    ["editor", false],
    ["viewer", false],
  ]);
  assert.deepEqual(teamRoleOptions().map((o) => o.value), ["lead", "member"]);
});

test("a picker with a name is submitted with its form (a hidden input)", () => {
  const html = renderToStaticMarkup(
    <SmartPicker label="Role" name="role" value="viewer" onChange={() => {}} options={[{ value: "viewer", label: "Viewer" }]} />,
  );
  assert.match(html, /<input type="hidden" name="role" value="viewer"\/>/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-label="Role"/);
});
