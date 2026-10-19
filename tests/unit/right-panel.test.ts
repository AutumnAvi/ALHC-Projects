// One right-side panel at a time: the task pane (?task=), Customize, the status update sheet.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closePanel,
  hrefWithTask,
  initialRightPanel,
  openPanel,
  syncTask,
  taskPaneVisible,
} from "@/lib/right-panel";

test("opening a task closes an open panel", () => {
  let s = openPanel(initialRightPanel(null), "customize:p", null);
  assert.equal(s.panel, "customize:p");
  assert.equal(taskPaneVisible(s, null), false);
  s = syncTask(s, "t1");
  assert.equal(s.panel, null);
  assert.equal(taskPaneVisible(s, "t1"), true);
});

test("opening a panel hides the task at once, before the URL drops it", () => {
  let s = initialRightPanel("t1");
  assert.equal(taskPaneVisible(s, "t1"), true);
  s = openPanel(s, "customize:p", "t1");
  // The URL still says t1 while ?task= is being removed: the pane is already hidden.
  assert.equal(taskPaneVisible(s, "t1"), false);
  assert.equal(syncTask(s, "t1"), s);
  s = syncTask(s, null);
  assert.equal(s.panel, "customize:p");
  assert.equal(s.suppressedTask, null);
  assert.equal(taskPaneVisible(s, null), false);
});

test("reopening the same task after the strip landed closes the panel", () => {
  let s = openPanel(initialRightPanel("t1"), "customize:p", "t1");
  s = syncTask(s, null);
  s = syncTask(s, "t1");
  assert.equal(s.panel, null);
  assert.equal(taskPaneVisible(s, "t1"), true);
});

test("another task while the strip is in flight wins", () => {
  let s = openPanel(initialRightPanel("t1"), "customize:p", "t1");
  s = syncTask(s, "t2");
  assert.equal(s.panel, null);
  assert.equal(taskPaneVisible(s, "t2"), true);
});

test("panels replace each other, and closing only closes your own", () => {
  let s = openPanel(initialRightPanel(null), "customize:p", null);
  s = openPanel(s, "status:p", null);
  assert.equal(s.panel, "status:p");
  assert.equal(closePanel(s, "customize:p"), s);
  s = closePanel(s, "status:p");
  assert.equal(s.panel, null);
});

test("Back to a task URL closes the panel opened after it", () => {
  let s = openPanel(initialRightPanel(null), "status:p", null);
  s = syncTask(s, "t9");
  assert.equal(s.panel, null);
  assert.equal(taskPaneVisible(s, "t9"), true);
});

test("a strip overtaken by another navigation never leaves the pane hidden after the panel closes", () => {
  // Customize opened over t1; a filter change built from the old URL kept ?task=t1, so the URL never
  // changed and syncTask saw nothing new.
  let s = openPanel(initialRightPanel("t1"), "customize:p", "t1");
  assert.equal(syncTask(s, "t1"), s);
  s = closePanel(s, "customize:p");
  assert.equal(taskPaneVisible(s, "t1"), true);
});

test("hrefWithTask sets or removes ?task= and keeps the rest", () => {
  assert.equal(hrefWithTask("http://x.test/projects/p/views/v?f=abc#top", "t1"), "/projects/p/views/v?f=abc&task=t1#top");
  assert.equal(hrefWithTask("http://x.test/projects/p/views/v?task=t1&f=abc", null), "/projects/p/views/v?f=abc");
  assert.equal(hrefWithTask("http://x.test/inbox?task=t1", null), "/inbox");
  assert.equal(hrefWithTask("/my-tasks", "t2"), "/my-tasks?task=t2");
});
