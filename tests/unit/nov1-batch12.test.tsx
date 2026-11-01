// Nov 1 notes, batch 12: email-in activity (83) and automation comments / run markers (84).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MentionText } from "@/components/task/comment-parts";
import { ACTIVITY_RANK, compareActivity, isEmailCreatedStory, runIsProblem, runVerb } from "@/lib/automation-activity";
import { mentionName, personEmailSegments } from "@/lib/mentions";
import { emailActivityText, sortActivity, type ProjectActivityItem } from "@/lib/project-page";

const ann = { id: "p-ann", full_name: null, email: "ann@example.com" };
const bo = { id: "p-bo", full_name: "Bo Owner", email: "bo@example.com" };
const emailName = { id: "p-em", full_name: "em@example.com", email: "em@example.com" };

test("83: email-in lines say who sent it and the subject", () => {
  assert.equal(emailActivityText("task_created", "Ann Lee", "Spring flyer"), "Created by email from Ann Lee · Spring flyer");
  assert.equal(emailActivityText("comment_added", "client@example.org", null), "Comment added by email from client@example.org");
  assert.equal(
    emailActivityText("comment_added", "client@example.org", 'Re: "Brief" submission received'),
    'Comment added by email from client@example.org · Re: "Brief" submission received',
  );
});

test("83: the older forwarding line gives way to the email line", () => {
  assert.equal(isEmailCreatedStory({ kind: "created", data: { via: "email" } }), true);
  assert.equal(isEmailCreatedStory({ kind: "created", data: {} }), false);
  assert.equal(isEmailCreatedStory({ kind: "renamed", data: { via: "email" } }), false);
});

test("83: the project Overview lists email-in between stories and joins at the same moment", () => {
  const at = "2026-11-01T10:00:00Z";
  const email: ProjectActivityItem = {
    kind: "email",
    id: "email-1",
    at,
    email: "task_created",
    projectId: "p",
    taskId: "t",
    taskTitle: "Flyer",
    sender: "Ann",
    subject: "Flyer",
  };
  const sorted = sortActivity([
    { kind: "created", id: "created", at, by: null },
    { kind: "joined", id: "joined-1", at, name: "Bo" },
    email,
    { kind: "status", id: "s", at: "2026-11-01T09:00:00Z", status: "on_track", title: null, note: null, by: null },
  ]);
  assert.deepEqual(
    sorted.map((i) => i.kind),
    ["email", "joined", "created", "status"],
  );
});

test("84: run markers say what happened", () => {
  assert.equal(runVerb({ status: "succeeded", reason: null }), "ran");
  assert.equal(runVerb({ status: "scheduled", reason: null }), "ran and is waiting to continue");
  assert.equal(runVerb({ status: "failed", reason: "boom" }), "failed");
  assert.equal(runVerb({ status: "skipped", reason: "loop" }), "was stopped by loop protection");
  assert.equal(runVerb({ status: "skipped", reason: "depth_limit" }), "was stopped by loop protection");
  assert.equal(runVerb({ status: "skipped", reason: "throttled" }), "hit its limit and didn’t run");
  assert.equal(runIsProblem({ status: "succeeded", reason: null }), false);
  assert.equal(runIsProblem({ status: "skipped", reason: "loop" }), true);
  assert.equal(runIsProblem({ status: "failed", reason: null }), true);
});

test("84: at the same moment, the person's change, then the marker, then what the automation did", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const entries = [
    { id: "automation-comment", at, rank: ACTIVITY_RANK.automation },
    { id: "marker", at, rank: ACTIVITY_RANK.run },
    { id: "person-move", at, rank: ACTIVITY_RANK.person },
    { id: "earlier", at: "2026-11-01T09:00:00.000Z", rank: ACTIVITY_RANK.automation },
  ].sort(compareActivity);
  assert.deepEqual(
    entries.map((e) => e.id),
    ["earlier", "person-move", "marker", "automation-comment"],
  );
});

test("84: a mention is a name, never a whole email address", () => {
  assert.equal(mentionName(bo), "Bo Owner");
  assert.equal(mentionName(ann), "ann");
  assert.equal(mentionName(emailName), "em");
});

test("84: known people's email addresses in an automation's comment become chips", () => {
  assert.deepEqual(personEmailSegments("hi ann@example.com, and BO@example.com.", [ann, bo]), [
    { type: "text", text: "hi " },
    { type: "mention", profileId: "p-ann", raw: "ann@example.com" },
    { type: "text", text: ", and " },
    { type: "mention", profileId: "p-bo", raw: "BO@example.com" },
    { type: "text", text: "." },
  ]);
  // Not part of a longer address, and unknown addresses stay text.
  assert.deepEqual(personEmailSegments("xann@example.com ann@example.com.au stranger@example.com", [ann]), [
    { type: "text", text: "xann@example.com ann@example.com.au stranger@example.com" },
  ]);
  assert.deepEqual(personEmailSegments("", [ann]), []);
});

test("84: an automation's comment shows a chip, not the raw address", () => {
  const html = renderToStaticMarkup(
    <MentionText body="hi avi@example.com and @ann" people={[ann]} emailPeople={[{ id: "p-avi", full_name: null, email: "avi@example.com" }, ann]} />,
  );
  assert.match(html, /data-mention="p-avi"/);
  assert.match(html, /data-mention="p-ann"/);
  assert.match(html, />@avi</);
  assert.match(html, />@ann</);
  assert.doesNotMatch(html, />[^<]*avi@example\.com[^<]*</, "the address isn't shown as text");
  // A person's own comment keeps addresses as typed.
  const plain = renderToStaticMarkup(<MentionText body="mail avi@example.com" people={[]} />);
  assert.match(plain, /mail avi@example\.com/);
});

test("84: the pane draws automation comments, run markers, and email-in lines distinctly", () => {
  const source = fs.readFileSync("src/components/task/task-activity.tsx", "utf8");
  assert.match(source, /data-automation-comment/);
  assert.match(source, /function AutomationAvatar/);
  assert.match(source, /Automation ·/);
  assert.match(source, /function RunMarker/);
  assert.match(source, /data-automation-run/);
  assert.match(source, /function EmailInLine/);
  // Automation comments no longer use the letter avatar.
  assert.doesNotMatch(source, /profileId=\{comment\.ruleName \? null/);
});

test("84: comments carry their automation for the link", () => {
  const data = fs.readFileSync("src/lib/data.ts", "utf8");
  assert.match(data, /ruleProjectId\?: string \| null/);
  assert.match(data, /withRuleProjects/);
  assert.match(data, /\.from\("rule_runs"\)[\s\S]{0,200}\.eq\("task_id", taskId\)/);
});
