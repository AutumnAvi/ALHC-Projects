// Nov 11 batch 38: Enter sends a comment (188), the automation toasts link the run and its history (190).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { isComposingKey, submitsOnEnter } from "@/components/task/mention-textarea";
import { RunLinks } from "@/components/rules/rule-feedback";
import { rulesPageHref } from "@/lib/rules-page";

const key = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

test("188: plain Enter sends a comment, Shift+Enter adds a line", () => {
  assert.equal(submitsOnEnter(key(), true), true);
  assert.equal(submitsOnEnter(key({ shiftKey: true }), true), false);
  assert.equal(submitsOnEnter(key({ altKey: true }), true), false);
  assert.equal(submitsOnEnter(key({ metaKey: true }), true), true, "⌘+Enter still sends");
  assert.equal(submitsOnEnter(key({ ctrlKey: true }), true), true, "Ctrl+Enter still sends");
  assert.equal(submitsOnEnter(key({ key: "a" }), true), false);
});

test("188: boxes that don't ask for it keep plain Enter as a new line (descriptions, messages)", () => {
  assert.equal(submitsOnEnter(key(), false), false);
  assert.equal(submitsOnEnter(key({ metaKey: true }), false), true);
});

test("188: an IME composition's Enter never sends", () => {
  assert.equal(isComposingKey({ nativeEvent: { isComposing: true } }), true);
  assert.equal(isComposingKey({ nativeEvent: { isComposing: false, keyCode: 229 } }), true, "Safari's last composition key");
  assert.equal(isComposingKey({ nativeEvent: { isComposing: false }, keyCode: 229 }), true);
  assert.equal(isComposingKey({ nativeEvent: { isComposing: false, keyCode: 13 } }), false);
});

test("188: the picker's Enter picks before anything sends, and an open # search swallows Enter", () => {
  const source = readFileSync(new URL("../../src/components/task/mention-textarea.tsx", import.meta.url), "utf8");
  const pick = source.indexOf("choose(suggestions[activeIndex])");
  const swallow = source.indexOf("if (open && submitOnEnter && e.key === \"Enter\"");
  const send = source.indexOf("submitsOnEnter(e, submitOnEnter)) {");
  const ime = source.indexOf("if (isComposingKey(e))");
  assert.ok(ime > 0 && pick > ime && swallow > pick && send > swallow, "IME first, then the picker, then sending");
});

test("188: the comment box sends on Enter and says so", () => {
  const source = readFileSync(new URL("../../src/components/task/task-activity.tsx", import.meta.url), "utf8");
  assert.equal(source.match(/submitOnEnter\n/g)?.length, 2, "the new comment box and the edit box");
  assert.match(source, /@ for people · # for tasks and projects · Enter to send · Shift\+Enter for a new line/);
  assert.doesNotMatch(source, /⌘\/Ctrl\+Enter to send/);
});

test("189: Edit shows only inside the 15-minute window", () => {
  const source = readFileSync(new URL("../../src/components/task/task-activity.tsx", import.meta.url), "utf8");
  assert.match(source, /const editable = useCommentEditWindow\(comment\.createdAt, mayEdit\);/);
  assert.match(source, /const removable = mine && canComment && !comment\.deleted && !sending;/, "delete keeps no time limit");
});

test("190: the toast's run links", () => {
  const html = renderToStaticMarkup(<RunLinks projectId="p1" ruleId="r1" runId="run1" runCount={1} />);
  assert.match(html, /href="\/projects\/p1\/rules\?view=history&amp;rule=r1&amp;run=run1"[^>]*>View this run</);
  assert.match(html, /href="\/projects\/p1\/rules\?view=history&amp;rule=r1"[^>]*>Run history</);
  const several = renderToStaticMarkup(<RunLinks projectId="p1" ruleId="r1" runId="run3" runCount={3} />);
  assert.match(several, />View latest run</);
  const noRun = renderToStaticMarkup(<RunLinks projectId="p1" ruleId="r1" runId={null} runCount={1} />);
  assert.doesNotMatch(noRun, /View this run/);
  assert.match(noRun, />Run history</);
});

test("190: the History tab's run link", () => {
  assert.equal(rulesPageHref("p1", "history", "r1", "run1"), "/projects/p1/rules?view=history&rule=r1&run=run1");
  assert.equal(rulesPageHref("p1", "history", "r1"), "/projects/p1/rules?view=history&rule=r1");
  assert.equal(rulesPageHref("p1", "templates", null, "run1"), "/projects/p1/rules?view=templates");
});
