// Nov 9 notes (180, 181): the task menu no longer offers "Request approval…", and requester emails
// (form confirmation, a message to the submitter, a rule update, a review check) plus teammate emails
// render the Autumn Lake brand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BRAND_FOOTER, BRAND_SENDER_NAME, brandLogoUrl, publicSiteUrl } from "@/lib/email-design";
import { fromFor, guessDesignKind, renderEmail } from "@/lib/email";
import type { OutboxRow } from "@/lib/email-layout";
import { renderReviewEmail } from "@/lib/review-email";

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
    send_after: "2026-11-09T00:00:00Z",
    sent_at: null,
    created_at: "2026-11-09T00:00:00Z",
    updated_at: "2026-11-09T00:00:00Z",
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

function withSite<T>(url: string | undefined, run: () => T): T {
  const saved = process.env.NEXT_PUBLIC_APP_URL;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (url === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = url;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = saved;
    if (vercel === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    else process.env.VERCEL_PROJECT_PRODUCTION_URL = vercel;
  }
}

function assertBrand(html: string, text: string, what: string) {
  const logo = brandLogoUrl();
  assert.ok(html.includes(`src="${logo}"`), `${what}: logo src ${logo}`);
  assert.ok(html.includes('alt="Autumn Lake Healthcare"'), `${what}: logo alt`);
  assert.ok(html.includes('width="170"') && html.includes("height:auto"), `${what}: logo size`);
  assert.ok(html.includes('height="6"') && html.includes('bgcolor="#751c1b"'), `${what}: maroon bar`);
  assert.ok(html.includes("background:#f1f5f9"), `${what}: page background`);
  assert.ok(html.includes("border:1px solid #e2e8f0") && html.includes("border-radius:12px"), `${what}: card`);
  assert.ok(html.includes("max-width:560px"), `${what}: width`);
  assert.ok(html.includes(BRAND_FOOTER) && text.includes(BRAND_FOOTER), `${what}: footer`);
  assert.ok(html.includes('role="presentation"'), `${what}: table layout`);
}

test("the task menu no longer lists Request approval", () => {
  const menu = readFileSync(new URL("../../src/components/task/task-more-menu.tsx", import.meta.url), "utf8");
  assert.equal(menu.includes("Request approval"), false);
  assert.ok(menu.includes("Send review check"));
});

test("requester emails and a teammate approval email share the brand", () => {
  withSite("https://alhc-projects.example", () => {
    const confirmation = renderEmail(
      row({
        template: "form_confirmation",
        payload: { form_title: "Design request", task_title: "Spring flyer", message: "Thanks!" },
      }),
    );
    const response = renderEmail(
      row({
        subject: 'Re: "Design request" submission received',
        payload: { kind: "submitter_response", author_name: "Avery", task_title: "Spring flyer", message: "Here is the draft." },
      }),
    );
    const update = renderEmail(
      row({
        template: "requester_update",
        payload: { task_title: "Spring flyer", message: "It moved to review.", section_name: "Review" },
      }),
    );
    const custom = renderEmail(
      row({
        template: "custom",
        payload: { task_title: "Spring flyer", message: "A note from the team." },
      }),
    );
    const approval = renderEmail(
      row({
        task_id: null,
        to_profile_id: "00000000-0000-4000-8000-0000000000b1",
        payload: {
          kind: "notification",
          item_kind: "approval_requested",
          actor_name: "Avery",
          title: "Spring flyer",
          task_id: "00000000-0000-4000-8000-0000000000a1",
          path: "/approve/00000000-0000-4000-8000-0000000000a1",
        },
      }),
    );
    const review = renderReviewEmail({
      origin: "https://alhc-projects.example",
      token: `alhc_rev_${"ab".repeat(32)}`,
      round: 1,
      recipientName: "Cara Client",
      senderName: "Avery",
      taskTitle: "Spring flyer",
      projectName: "Creative Requests",
      message: "Please take a look.",
      assets: [],
    });

    for (const [what, email] of [
      ["form confirmation", confirmation],
      ["submitter response", response],
      ["requester update", update],
      ["custom rule email", custom],
      ["approval request", approval],
      ["review check", review],
    ] as const) {
      assertBrand(email.html, email.text, what);
      assert.ok(!email.html.includes("Sent by ALHC Projects"), `${what}: old sign-off is gone`);
    }

    assert.ok(approval.html.includes('bgcolor="#ff6800"') && approval.html.includes("color:#ffffff"), "orange button, white text");
    assert.ok(approval.html.includes(">Open review</a>"));
    assert.ok(review.html.includes('bgcolor="#ff6800"') && review.html.includes(">Approve</a>"));
    assert.ok(review.html.includes("color:#b34a00"), "review link uses the brand link color");
    assert.equal(guessDesignKind(row({ template: "custom" })), "requester");
    assert.equal(guessDesignKind(row({ template: "requester_update" })), "requester");
    assert.equal(
      guessDesignKind(row({ template: "custom", to_profile_id: "00000000-0000-4000-8000-0000000000b1", comment_id: "00000000-0000-4000-8000-0000000000c1" })),
      "internal",
    );
  });
});

test("the logo falls back to the hosted app, and a set workspace sender name wins", () => {
  withSite(undefined, () => {
    assert.equal(publicSiteUrl(), "https://alhc-projects.vercel.app");
    assert.equal(brandLogoUrl(), "https://alhc-projects.vercel.app/brand/logo-horizontal.png");
    const email = renderEmail(row({ template: "form_confirmation", payload: { form_title: "Brief", task_title: "Logo" } }));
    assert.ok(email.html.includes('src="https://alhc-projects.vercel.app/brand/logo-horizontal.png"'));
  });

  const saved = { from: process.env.EMAIL_FROM, noReply: process.env.EMAIL_FROM_NOREPLY };
  process.env.EMAIL_FROM = "ALHC Projects <requests@mail.example.com>";
  process.env.EMAIL_FROM_NOREPLY = "no-reply@mail.example.com";
  try {
    assert.equal(fromFor(false, null, true), `"${BRAND_SENDER_NAME}" <no-reply@mail.example.com>`);
    assert.equal(fromFor(true, null, true), `"${BRAND_SENDER_NAME}" <requests@mail.example.com>`);
    assert.equal(fromFor(true, "Studio Creative", true), '"Studio Creative" <requests@mail.example.com>');
    assert.equal(fromFor(false, null), "no-reply@mail.example.com", "internal emails keep the configured sender");
    assert.equal(fromFor(false, "Studio Creative"), '"Studio Creative" <no-reply@mail.example.com>');
  } finally {
    if (saved.from === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = saved.from;
    if (saved.noReply === undefined) delete process.env.EMAIL_FROM_NOREPLY;
    else process.env.EMAIL_FROM_NOREPLY = saved.noReply;
  }
});
