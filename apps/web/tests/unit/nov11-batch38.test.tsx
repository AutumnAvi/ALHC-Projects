// Nov 11 batch 38: Enter sends a comment (188), Edit only for 15 minutes (189), the automation toasts link
// the run and its history (190), and the restyled emails (191).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { isComposingKey, submitsOnEnter } from "@/components/task/mention-textarea";
import { RunLinks } from "@/components/rules/rule-feedback";
import { rulesPageHref } from "@/lib/rules-page";
import { BRAND_FOOTER, brandLogoUrl } from "@/lib/email-design";
import { renderEmail } from "@/lib/email";
import { NO_REPLY_NOTE, layout, type OutboxRow } from "@/lib/email-layout";
import { renderReviewEmail } from "@/lib/review-email";
import { renderDigestEmail, renderReportEmail } from "@/lib/email-scheduled";

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

// ---- 191: the restyled email layout -----------------------------------------------------------------


function outboxRow(extra: Partial<OutboxRow>): OutboxRow {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    task_id: "00000000-0000-4000-8000-0000000000a1",
    rule_id: null,
    to_email: "someone@example.net",
    template: "custom",
    subject: null,
    payload: {},
    status: "sending",
    attempts: 1,
    last_error: null,
    provider_message_id: null,
    send_after: "2026-11-11T00:00:00Z",
    sent_at: null,
    created_at: "2026-11-11T00:00:00Z",
    updated_at: "2026-11-11T00:00:00Z",
    deleted_at: null,
    to_profile_id: null,
    comment_id: null,
    max_attempts: 5,
    delivery_status: null,
    delivery_event_at: null,
    delivery_detail: null,
    ...extra,
  } as OutboxRow;
}

test("191: the shared layout — logo, a clear button with its link written out, footer, preview line, phone styles", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  const email = layout("Avery assigned you “Flyer”", ["Please send the print file by Friday."], [{ label: "Project", value: "Brand" }], {
    action: { label: "Open task", href: "https://app.example.com/projects/p?task=t" },
    footer: ["You get this email because it’s on in Settings."],
  });
  assert.ok(email.html.includes(`src="${brandLogoUrl()}"`), "the Autumn Lake logo");
  assert.match(email.html, /class="alhc-btn"[^>]*>[\s\S]*bgcolor="#ff6800"[\s\S]*>Open task<\/a>/, "the orange button");
  assert.match(email.html, /Or open this link: <a href="https:\/\/app\.example\.com\/projects\/p\?task=t"/, "the link written out");
  assert.match(email.html, /@media only screen and \(max-width:600px\)/, "phone styles");
  assert.match(email.html, /display:none;max-height:0[^>]*>Please send the print file by Friday\./, "the inbox preview line");
  assert.ok(email.html.includes(BRAND_FOOTER) && email.html.includes(NO_REPLY_NOTE), "sign-off and footnote");
  assert.ok(email.html.indexOf(BRAND_FOOTER) < email.html.lastIndexOf(NO_REPLY_NOTE));
  assert.doesNotMatch(email.html, /<div[^>]*display:\s*(flex|grid)/, "tables only");
  // The plain-text twin.
  assert.ok(email.text.includes("Avery assigned you “Flyer”\n--------------------------"), "the heading underlined");
  assert.ok(email.text.includes("Project: Brand"));
  assert.ok(email.text.includes("Open task: https://app.example.com/projects/p?task=t"));
  assert.ok(email.text.includes(`—\n${BRAND_FOOTER}`));
  assert.ok(email.text.endsWith(NO_REPLY_NOTE), "the footnote last");
});

test("191: a comment reads as a quote, in HTML and text", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  const email = renderEmail(
    outboxRow({
      comment_id: "00000000-0000-4000-8000-0000000000c1",
      payload: { kind: "comment", task_title: "Flyer", author_name: "Avery", comment_body: "Line one\nLine two", project_id: "00000000-0000-4000-8000-0000000000b1", project_name: "Brand" },
    }),
  );
  assert.match(email.html, /border-left:3px solid #ff6800/);
  assert.ok(email.text.includes("> Line one\n> Line two"));
});

test("191: no email body says the old product name", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  const invites = [
    renderEmail(outboxRow({ task_id: null, subject: "You've been invited", payload: { kind: "invite", inviter_name: "Avery", workspace_name: "ALHC" } })),
    renderEmail(
      outboxRow({
        task_id: null,
        payload: { kind: "invite", inviter_name: "Avery", target_kind: "project", target_name: "Brand", target_path: "/projects/00000000-0000-4000-8000-0000000000b1", role: "editor" },
      }),
    ),
  ];
  for (const invite of invites) {
    const body = invite.html.replace(/<title>[\s\S]*?<\/title>/, "");
    assert.doesNotMatch(body + invite.text.split("\n").slice(1).join("\n"), /ALHC Projects/);
    assert.match(invite.text, /Autumn Lake Marketing plans and tracks its work/);
  }
});

test("191: the review, digest, and report emails share the layout's blocks", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  const review = renderReviewEmail({
    origin: "https://app.example.com",
    token: `alhc_rev_${"ab".repeat(32)}`,
    round: 1,
    recipientName: "Cara",
    senderName: "Avery",
    taskTitle: "Flyer",
    projectName: "Brand",
    message: null,
    assets: [{ assetId: "a1", name: "flyer.pdf", contentType: "application/pdf" }],
  });
  assert.match(review.html, /File to review<\/h2>/);
  const digest = renderDigestEmail(
    outboxRow({ task_id: null, payload: { kind: "digest", frequency: "daily", total: 1, unsubscribe_token: "a".repeat(64) } }),
    [{ item_id: "i1", kind: "assigned", data: {}, created_at: "2026-11-11T09:00:00Z", parts: { actor_name: "Rhona", title: "Flyer", group_key: "p1", group_label: "Brand", path: "/my-tasks" } }],
  );
  assert.match(digest.html, /Brand<\/h2>/);
  assert.doesNotMatch(digest.html, /<ul|<li/, "lists are tables");
  const report = renderReportEmail(
    outboxRow({ task_id: null, payload: { kind: "report", name: "Weekly", report: "overview", projects: [{ name: "Brand", open: 2 }], project_count: 1 } }),
  );
  assert.match(report.html, /By project<\/h2><table role="presentation"/);
});
