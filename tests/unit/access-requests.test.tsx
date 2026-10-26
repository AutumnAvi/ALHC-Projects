// Oct 26 notes (batch 3), part 3: a project link someone isn't part of shows "You're not part of this
// project" with one button; the owners' Inbox card reads the request from the item's data.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { NoProjectAccess } from "@/components/project/no-project-access";
import { ToastProvider } from "@/components/toast";
import { accessRequestOf, isAccessGranted, isAccessGrantRole, parseAccessStatus } from "@/lib/access-requests";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <ToastProvider>{node}</ToastProvider>
    </AppRouterContext.Provider>,
  );

test("parseAccessStatus: anything unknown is a real Not found", () => {
  assert.equal(parseAccessStatus("can_request"), "can_request");
  assert.equal(parseAccessStatus("requested"), "requested");
  assert.equal(parseAccessStatus("archived"), "archived");
  assert.equal(parseAccessStatus("member"), "member");
  assert.equal(parseAccessStatus("missing"), "missing");
  assert.equal(parseAccessStatus("owner"), "missing");
  assert.equal(parseAccessStatus(null), "missing");
});

test("the not-a-member page offers exactly one request button", () => {
  const html = render(<NoProjectAccess projectId="p1" status="can_request" />);
  assert.match(html, /You’re not part of this project/);
  assert.equal(html.match(/<button/g)?.length, 1);
  assert.match(html, /Request to be added to this project/);
  assert.doesNotMatch(html, /Not found/);
});

test("after asking, the page says the request was sent and offers no button", () => {
  const html = render(<NoProjectAccess projectId="p1" status="requested" />);
  assert.match(html, /Request sent/);
  assert.doesNotMatch(html, /<button/);
});

test("an archived project can't take requests", () => {
  const html = render(<NoProjectAccess projectId="p1" status="archived" />);
  assert.match(html, /archived/);
  assert.doesNotMatch(html, /<button/);
});

test("Inbox data: the owners' item and the requester's item", () => {
  const item = accessRequestOf({
    access_request: true,
    access_request_id: "r1",
    requester_name: "Oscar",
    requester_email: "oscar@example.com",
    access_request_status: "approved",
    granted_role: "viewer",
  });
  assert.deepEqual(item, {
    requestId: "r1",
    requesterName: "Oscar",
    requesterEmail: "oscar@example.com",
    status: "approved",
    grantedRole: "viewer",
  });
  assert.equal(accessRequestOf({ access_request: true, access_request_id: "r2" })?.status, "pending");
  assert.equal(accessRequestOf({ rule_name: "x" }), null);
  assert.equal(accessRequestOf(null), null);
  assert.equal(isAccessGranted({ access_granted: true }), true);
  assert.equal(isAccessGranted({ access_request: true }), false);
});

test("owners can give their default role, Editor, Commenter, or Viewer (never Owner or Admin)", () => {
  for (const role of ["default", "editor", "commenter", "viewer"]) assert.ok(isAccessGrantRole(role), role);
  for (const role of ["owner", "admin", "", null]) assert.ok(!isAccessGrantRole(role), String(role));
});
