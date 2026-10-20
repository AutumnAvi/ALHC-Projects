// Automations V2, batch 3 — {{placeholders}}: rendering (mirrors render_rule_text_as), aliases, unknown
// keys, the preview's sample values, and safe HTML in rule emails (values and {{task.url}} markers).
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEmail } from "@/lib/email";
import type { OutboxRow } from "@/lib/email-layout";
import {
  PLACEHOLDERS,
  placeholderKey,
  renderPlaceholders,
  resolveTaskLinkMarkers,
  samplePlaceholderValues,
  unknownPlaceholders,
} from "@/lib/rule-placeholders";

const values = {
  "task.name": "Spring flyer",
  "task.assignee": "Dana Diaz",
  "task.due_date": "Oct 24, 2026",
  "task.section": "In review",
  "project.name": "Creative Requests",
  "field.request type": "Video",
  "form.field.budget": "$2,000",
};

test("{{placeholders}} render, with spaces, any case, and the spec's short forms", () => {
  assert.equal(renderPlaceholders("{{task.name}} is due {{ task.due_date }}", values), "Spring flyer is due Oct 24, 2026");
  assert.equal(renderPlaceholders("{{TASK.NAME}} / {{assignee}} / {{due_date}}", values), "Spring flyer / Dana Diaz / Oct 24, 2026");
  assert.equal(renderPlaceholders("Type: {{field:Request type}} or {{field.request type}}", values), "Type: Video or Video");
  assert.equal(renderPlaceholders("Budget {{form.field.Budget}} / {{form.answer.budget}}", values), "Budget $2,000 / $2,000");
  assert.equal(placeholderKey("  Project  "), "project.name");
  assert.equal(placeholderKey("field:Request   Type"), "field.request type");
});

test("unknown placeholders render empty; the original single-brace tokens still work", () => {
  assert.equal(renderPlaceholders("A{{nope}}B{{field.missing}}C", values), "ABC");
  assert.equal(renderPlaceholders("@{assignee}: {task} moved to {section} in {project}", values), "@@Dana Diaz: Spring flyer moved to In review in Creative Requests");
  assert.equal(renderPlaceholders("{due}", values), "Oct 24");
  assert.equal(renderPlaceholders("{due} / {section}", {}), "no due date / No section");
  assert.equal(renderPlaceholders("See {task_link}", values), "See {task_link}", "a Slack-only token stays as typed");
});

test("substituted values are never scanned again (a title can't inject a token)", () => {
  const sneaky = { ...values, "task.name": "{{task.assignee}} {section} {{task.url}}" };
  assert.equal(renderPlaceholders("{{task.name}}", sneaky), "{{task.assignee}} {section} {{task.url}}");
});

test("typos are flagged, field and form keys are allowed", () => {
  const known = new Set(PLACEHOLDERS.map((p) => p.key));
  assert.deepEqual(unknownPlaceholders("{{task.nmae}} {{field.Anything}} {{form.field.Q}} {{assignee}}", known), ["task.nmae"]);
});

test("the preview's samples cover fields and form questions", () => {
  const sample = samplePlaceholderValues({
    projectName: "Marketing",
    fields: [
      { name: "Priority", fieldType: "single_select", options: [{ name: "High" }] },
      { name: "Budget", fieldType: "number" },
    ],
    questions: [{ label: "What do you need?" }],
  });
  assert.equal(renderPlaceholders("{{project.name}} · {{field.Priority}} · {{field.budget}}", sample), "Marketing · High · 1500");
  assert.match(renderPlaceholders("{{form.field.What do you need?}}", sample), /Sample answer/);
});

test("{{task.url}} markers become absolute links in emails, or disappear without an origin", () => {
  const path = "/projects/00000000-0000-4000-8000-0000000000a1?task=00000000-0000-4000-8000-0000000000b1";
  assert.equal(resolveTaskLinkMarkers(`Open alhc-link:${path} now`, "https://app.example.com"), `Open https://app.example.com${path} now`);
  assert.equal(resolveTaskLinkMarkers(`Open alhc-link:${path} now`, null), "Open  now");
  assert.equal(resolveTaskLinkMarkers("alhc-link:/projects/not-a-uuid?task=x", "https://a.example"), "alhc-link:/projects/not-a-uuid?task=x");
});

function row(extra: Partial<OutboxRow>): OutboxRow {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    task_id: "00000000-0000-4000-8000-0000000000a1",
    rule_id: "00000000-0000-4000-8000-0000000000c1",
    to_email: "someone@example.net",
    template: "custom",
    subject: null,
    payload: {},
    status: "sending",
    attempts: 1,
    last_error: null,
    provider_message_id: null,
    send_after: "2026-10-14T00:00:00Z",
    sent_at: null,
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
    deleted_at: null,
    to_profile_id: null,
    comment_id: null,
    max_attempts: 5,
    delivery_status: null,
    delivery_event_at: null,
    delivery_detail: null,
    ...extra,
  };
}

test("a rule email escapes placeholder values in HTML and resolves the task link", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  const path = "/projects/00000000-0000-4000-8000-0000000000a1?task=00000000-0000-4000-8000-0000000000b1";
  // What render_rule_text_as(…, 'email') stores: the values as plain text, the link as a marker.
  const message = renderPlaceholders("Hi! “{{task.name}}” is ready: ", { "task.name": `<img src=x onerror=alert(1)> & "Co"` }) + ` alhc-link:${path}`;
  const email = renderEmail(
    row({ subject: `Re: <b>flyer</b> alhc-link:${path}`, payload: { task_title: "<b>flyer</b>", message, project_name: "P" } }),
  );
  assert.ok(!email.html.includes("<img src=x"), "no raw HTML from a value");
  assert.ok(email.html.includes("&#60;img src=x onerror=alert(1)&#62; &#38; &#34;Co&#34;"), "escaped");
  assert.ok(email.html.includes(`https://app.example.com${path.replace(/\?/, "?")}`), "the marker is now a link");
  assert.ok(!email.html.includes("alhc-link:") && !email.text.includes("alhc-link:") && !email.subject.includes("alhc-link:"), "no markers left");
  assert.ok(email.text.includes(`<img src=x onerror=alert(1)> & "Co"`), "the text part keeps the words");
  assert.ok(email.subject.startsWith("Re: <b>flyer</b> https://app.example.com/projects/"), "subject (plain text) resolved too");
});
