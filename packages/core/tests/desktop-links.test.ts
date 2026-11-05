// Big move 3 (docs/design/desktop.md): the alhc:// links the desktop app opens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_LINK_SECTIONS, desktopLinkFor, desktopLinkPath, sameOriginPath } from "@alhc/core/desktop-links";

const P = "0b6f5c3e-8f4e-4a1b-9d0e-1f2a3b4c5d6e";
const T = "7a1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b";

test("a link's path and query are the app's path and query", () => {
  assert.equal(desktopLinkPath(`alhc://projects/${P}`), `/projects/${P}`);
  assert.equal(desktopLinkPath(`alhc://projects/${P}?task=${T}`), `/projects/${P}?task=${T}`);
  assert.equal(desktopLinkPath(`alhc://projects/${P}/views/${T}?f=abc&task=${T}`), `/projects/${P}/views/${T}?f=abc&task=${T}`);
  assert.equal(desktopLinkPath(`alhc://projects/${P}/messages/${T}#message-${T}`), `/projects/${P}/messages/${T}#message-${T}`);
  assert.equal(desktopLinkPath("alhc://inbox?tab=mentioned"), "/inbox?tab=mentioned");
  assert.equal(desktopLinkPath("alhc://search?q=spring%20flyer"), "/search?q=spring+flyer");
  assert.equal(desktopLinkPath("alhc://my-tasks/"), "/my-tasks");
  assert.equal(desktopLinkPath(`alhc://approve/${T}`), `/approve/${T}`);
  assert.equal(desktopLinkPath("alhc://admin/users?tab=invited"), "/admin/users?tab=invited");
});

test("every way of writing the scheme means the same page", () => {
  for (const link of [`alhc://projects/${P}`, `alhc:///projects/${P}`, `alhc:projects/${P}`, `ALHC://projects/${P}`, ` alhc://projects/${P} `]) {
    assert.equal(desktopLinkPath(link), `/projects/${P}`, link);
  }
});

test("short forms: Home, a task by id, Settings", () => {
  assert.equal(desktopLinkPath("alhc://"), "/");
  assert.equal(desktopLinkPath("alhc://home"), "/");
  assert.equal(desktopLinkPath(`alhc://task/${T}`), `/my-tasks?task=${T}`);
  assert.equal(desktopLinkPath("alhc://task"), "/");
  assert.equal(desktopLinkPath(`alhc://task/${T}/more`), "/");
  assert.equal(desktopLinkPath("alhc://settings"), "/?settings=profile");
  assert.equal(desktopLinkPath("alhc://settings/notifications"), "/?settings=notifications");
  assert.equal(desktopLinkPath("alhc://settings/nonsense"), "/?settings=profile");
});

test("anything else opens Home, and other schemes aren't desktop links", () => {
  for (const link of [
    "alhc://login",
    "alhc://auth/callback?code=x",
    "alhc://api/task-pane/x",
    "alhc://attachments/x?download",
    "alhc://export/list",
    "alhc://projects/../api",
    "alhc://projects/%2e%2e/api",
    "alhc://projects/a.b",
    "alhc://projects\\evil",
    "alhc://projects/x\u0000",
    "alhc://" + "projects/".repeat(9),
    "alhc://projects/" + "x".repeat(5000),
    "alhc://_next/static/x.js",
  ]) {
    assert.equal(desktopLinkPath(link), "/", link);
  }
  for (const value of ["https://alhc-projects.vercel.app/projects/x", "alhcx://projects/x", "javascript:alert(1)", "", "projects/x"]) {
    assert.equal(desktopLinkPath(value), null, value);
  }
});

test("a fragment survives only when it's an anchor id; the query is re-encoded", () => {
  assert.equal(desktopLinkPath("alhc://inbox#<script>"), "/inbox");
  assert.equal(desktopLinkPath("alhc://inbox?tab=archive&tab=x"), "/inbox?tab=archive&tab=x");
  assert.equal(desktopLinkPath('alhc://search?q="><img src=x>'), "/search?q=%22%3E%3Cimg+src%3Dx%3E");
});

test("every section opens; one with no page of its own needs something after it", () => {
  const needsMore = new Set(["projects", "people", "approve", "help", "project-access", "team-access"]);
  for (const section of DESKTOP_LINK_SECTIONS) {
    assert.equal(desktopLinkPath(`alhc://${section}`), needsMore.has(section) ? "/" : `/${section}`, section);
    assert.equal(desktopLinkPath(`alhc://${section}/${P}`), `/${section}/${P}`, section);
  }
  assert.equal(desktopLinkPath("alhc://help/roles"), "/help/roles");
  assert.equal(desktopLinkFor("/projects"), null);
});

test("desktopLinkFor builds the link back", () => {
  assert.equal(desktopLinkFor(`/projects/${P}?task=${T}`), `alhc://projects/${P}?task=${T}`);
  assert.equal(desktopLinkFor("/"), "alhc://");
  assert.equal(desktopLinkFor("/?settings=display"), "alhc://?settings=display");
  assert.equal(desktopLinkFor("/search?q=spring%20flyer"), "alhc://search?q=spring+flyer");
  assert.equal(desktopLinkFor("/inbox#message-1"), "alhc://inbox#message-1");
  assert.equal(desktopLinkFor("/inbox#a.b"), "alhc://inbox");
  assert.equal(desktopLinkFor("/login"), null);
  assert.equal(desktopLinkFor("//evil.example/x"), null);
  assert.equal(desktopLinkFor("projects/x"), null);
  for (const path of [`/projects/${P}`, `/my-tasks?task=${T}`, "/inbox?tab=mentioned", `/teams/${P}/calendar`, `/projects/${P}/messages/${T}#message-${T}`]) {
    const link = desktopLinkFor(path);
    assert.ok(link, path);
    assert.equal(desktopLinkPath(link), path);
  }
});

test("sameOriginPath keeps relative paths on the app's own origin only (as safeNextPath)", () => {
  assert.equal(sameOriginPath(`/projects/${P}?task=${T}#x`), `/projects/${P}?task=${T}#x`);
  assert.equal(sameOriginPath("/login?next=%2Finbox"), "/login?next=%2Finbox");
  for (const value of [null, undefined, "", "projects/x", "//evil.example", "/\\evil.example", "/x\u0007", "https://evil.example/"]) {
    assert.equal(sameOriginPath(value), "/", String(value));
  }
});
