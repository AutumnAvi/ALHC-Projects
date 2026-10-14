// Part 2 — reply by email: only a response to a form's submitter gets a Reply-To; every other email is
// no-reply, and the inbound address parsing still finds r- / f- tokens on the reply domain.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutboxRow } from "@/lib/email-layout";
import { renderEmail, replyToFor } from "@/lib/email";
import { forwardTokenFrom, replyTokenFrom, stripQuotedReply, SUBMITTER_REPLY_MARKER } from "@/lib/email-reply";

process.env.RESEND_WEBHOOK_SECRET = "whsec_dGVzdA==";
const TOKEN = "0123456789abcdef0123456789abcdef01234567";

function row(extra: Partial<OutboxRow>): OutboxRow {
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
    send_after: "2026-10-14T00:00:00Z",
    sent_at: null,
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
    deleted_at: null,
    ...extra,
  } as OutboxRow;
}

const lookups: string[] = [];
const token = async (id: string) => {
  lookups.push(id);
  return TOKEN;
};

const response = row({
  to_email: "tjones@autumnhc.net",
  subject: 'Re: "CREATIVE REQUEST FORM" submission received',
  payload: { kind: "submitter_response", comment_id: "c1", thread_id: "t1", author_name: "Daniel Holczer", message: "Hi Terry", task_title: "Poster" },
});

test("a response to the submitter gets the thread's reply address", async () => {
  assert.equal(await replyToFor(response, token), `r-${TOKEN}@reply.mail.autumnlakemarketing.com`);
  const email = renderEmail(response, { canReply: true });
  assert.equal(email.subject, 'Re: "CREATIVE REQUEST FORM" submission received');
  assert.ok(email.text.startsWith(SUBMITTER_REPLY_MARKER), "the reply-above line comes first");
  assert.match(email.text, /Hi Terry/);
  assert.doesNotMatch(email.text, /https?:\/\//, "no app links for someone outside the workspace");
});

test("follower comment emails and notifications are no-reply", async () => {
  lookups.length = 0;
  const comment = row({
    comment_id: "00000000-0000-4000-8000-0000000000c1",
    to_profile_id: "00000000-0000-4000-8000-0000000000b1",
    payload: { kind: "comment", task_title: "Poster", author_name: "Ann", comment_body: "Looks good" },
  } as Partial<OutboxRow>);
  const notification = row({ task_id: null, payload: { kind: "notification", item_kind: "assigned", title: "Poster" } });
  const ruleEmail = row({ template: "due_tomorrow", payload: { task_title: "Poster" } });
  for (const r of [comment, notification, ruleEmail]) assert.equal(await replyToFor(r, token), null);
  assert.equal(lookups.length, 0, "no token is even looked up");
  const text = renderEmail(comment).text;
  assert.doesNotMatch(text, /Reply above this line|Reply to this email/);
  assert.match(text, /Replies to this email aren’t read/);
});

test("without the inbound webhook secret even a response carries no Reply-To", async () => {
  const saved = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  assert.equal(await replyToFor(response, token), null);
  process.env.RESEND_WEBHOOK_SECRET = saved;
  assert.match(renderEmail(response, { canReply: false }).text, /Replies to this email aren’t read/);
});

test("inbound addresses: r- and f- tokens on the reply domain only", () => {
  assert.equal(replyTokenFrom([`Reply <r-${TOKEN}@reply.mail.autumnlakemarketing.com>`]), TOKEN);
  assert.equal(replyTokenFrom([`r-${TOKEN}@elsewhere.example.com`]), null);
  assert.equal(forwardTokenFrom([`f-${TOKEN}@reply.mail.autumnlakemarketing.com`]), TOKEN);
  assert.equal(stripQuotedReply(`Perfect!\n\n${SUBMITTER_REPLY_MARKER}\nquoted`), "Perfect!");
});
