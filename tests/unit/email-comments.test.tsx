// Part 3 — email comments: metadata parsing and Asana's "Sent to" / "Replied via" cards.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canRespondToSubmitter,
  commentEmailStatus,
  parseCommentEmail,
  submitterResponseSubject,
} from "@/lib/comment-email";
import { EmailCard, EmailCommentHeader, MailAvatar } from "@/components/task/comment-parts";

test("comment email metadata parses only complete rows", () => {
  assert.deepEqual(
    parseCommentEmail({ email_direction: "sent", email_address: "t@example.net", email_subject: "Re: x" }),
    { direction: "sent", address: "t@example.net", subject: "Re: x" },
  );
  assert.equal(parseCommentEmail({ email_direction: null, email_address: null, email_subject: null }), null);
  assert.equal(parseCommentEmail({ email_direction: "other", email_address: "a@b.c", email_subject: "x" }), null);
});

test("subject and status follow Asana and the outbox", () => {
  assert.equal(submitterResponseSubject("CREATIVE REQUEST FORM"), 'Re: "CREATIVE REQUEST FORM" submission received');
  assert.equal(submitterResponseSubject(null), 'Re: "Your request" submission received');
  assert.equal(commentEmailStatus({ status: "pending" }), "sending");
  assert.equal(commentEmailStatus({ status: "sent", delivery_status: "delivered" }), "delivered");
  assert.equal(commentEmailStatus({ status: "sent", delivery_status: "bounced" }), "bounced");
  assert.equal(commentEmailStatus({ status: "failed" }), "failed");
});

test("only form tasks (and their subtasks) with a submitter offer the checkbox, to Editors and above", () => {
  const base = {
    source: "form",
    isSubtask: false,
    submission: { email: "t@example.net" },
    submitterResponses: true,
    viewerRole: "editor",
  };
  assert.equal(canRespondToSubmitter(base), true);
  assert.equal(canRespondToSubmitter({ ...base, source: "manual" }), false);
  assert.equal(canRespondToSubmitter({ ...base, submission: null }), false);
  assert.equal(canRespondToSubmitter({ ...base, source: "manual", isSubtask: true }), true, "a subtask answers the request's submitter");
  assert.equal(canRespondToSubmitter({ ...base, viewerRole: "commenter" }), false, "Commenters can't send");
  assert.equal(canRespondToSubmitter({ ...base, viewerRole: "viewer" }), false);
  assert.equal(canRespondToSubmitter({ ...base, viewerRole: "owner" }), true);
  assert.equal(canRespondToSubmitter({ ...base, submitterResponses: false }), false, "not before the database update");
});

const subject = 'Re: "CREATIVE REQUEST FORM" submission received';

test("a sent response: author, Sent to <email link>, a card with the subject bar and the body", () => {
  const email = { direction: "sent" as const, address: "tjones@autumnhc.net", subject, status: "delivered" as const, error: null };
  const html = renderToStaticMarkup(
    <>
      <EmailCommentHeader email={email} authorName="Daniel Holczer" createdAt="2026-10-12T10:00:00Z" />
      <EmailCard email={email} createdAt="2026-10-12T10:00:00Z">
        Hi Terry
      </EmailCard>
    </>,
  );
  assert.match(html, /Daniel Holczer/);
  assert.match(html, /Sent to <a href="mailto:tjones@autumnhc.net"[^>]*>tjones@autumnhc.net<\/a>/);
  assert.match(html, /data-email-card="sent"/);
  assert.match(html, /bg-zinc-100[^>]*>Re: &quot;CREATIVE REQUEST FORM&quot; submission received</);
  assert.match(html, /Hi Terry/);
  assert.match(html, /Delivered/);
});

test("a received reply: the address as the name, Replied via <email link>, a mail avatar", () => {
  const email = { direction: "received" as const, address: "gperrin@autumnhc.net", subject, status: null, error: null };
  const html = renderToStaticMarkup(
    <>
      <MailAvatar />
      <EmailCommentHeader email={email} authorName="ignored" createdAt="2026-08-10T10:00:00Z" />
      <EmailCard email={email} createdAt="2026-08-10T10:00:00Z">
        Perfect! Its Printed
      </EmailCard>
    </>,
  );
  assert.match(html, /<svg[^>]*lucide-mail/);
  assert.match(html, /font-semibold text-zinc-900">gperrin@autumnhc.net</);
  assert.doesNotMatch(html, /ignored/);
  assert.match(html, /Replied via <a href="mailto:gperrin@autumnhc.net"/);
  assert.match(html, /data-email-card="received"/);
  assert.doesNotMatch(html, /Sending|Delivered/, "no delivery state on a received reply");
});
