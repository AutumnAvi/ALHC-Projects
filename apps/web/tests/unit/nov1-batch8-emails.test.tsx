// Nov 1 notes (batch 8), items 56 and 62: a no-reply sender with a "Do not reply to this email." footnote
// on every email that can't be answered by email (a response to a form's submitter says "You can reply to
// this email to respond." instead and comes from EMAIL_FROM), and the review check email's big previews.
import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredSender, fromFor, fromHeader, renderDesignSample, renderEmail, senderAddress } from "@/lib/email";
import { DESIGN_DEFAULTS, DESIGN_SAMPLES, previewFromLabel } from "@/lib/email-design";
import { CAN_REPLY_NOTE, layout, NO_REPLY_NOTE, type OutboxRow, type Rendered } from "@/lib/email-layout";
import { SUBMITTER_REPLY_MARKER } from "@/lib/email-reply";
import { renderDigestEmail, renderReportEmail } from "@/lib/email-scheduled";
import { EMAIL_IMAGE_WIDTH, emailImageWidth, renderReviewEmail, reviewUrls } from "@/lib/review-email";
import { encodeWithinCap, jpegSize, THUMB_MAX_BYTES, THUMB_QUALITIES } from "@/lib/review-thumbnails";
import { senderPreview } from "@alhc/core/workspace";

process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

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
    send_after: "2026-11-01T00:00:00Z",
    sent_at: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
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

function assertNoReply(email: Rendered, what: string) {
  assert.equal(email.replyable, false, `${what}: not replyable`);
  assert.ok(email.text.includes(NO_REPLY_NOTE), `${what}: the footnote in the text part`);
  assert.ok(email.html.includes(NO_REPLY_NOTE), `${what}: the footnote in the HTML`);
  assert.ok(!email.text.includes(CAN_REPLY_NOTE) && !email.html.includes(CAN_REPLY_NOTE), `${what}: never says it can be answered`);
  assert.equal(email.text.split(NO_REPLY_NOTE).length, 2, `${what}: said once`);
}

const TOKEN = `alhc_rev_${"b2".repeat(32)}`;

function review(assets: Parameters<typeof renderReviewEmail>[0]["assets"]) {
  return renderReviewEmail({
    origin: "https://app.example.com",
    token: TOKEN,
    round: 1,
    recipientName: "Cara Client",
    senderName: "Avi",
    taskTitle: "Spring poster",
    projectName: "Creative requests",
    message: null,
    assets,
  });
}

test("every email that can't be answered by email ends with “Do not reply to this email.”", () => {
  const emails: [string, Rendered][] = [
    [
      "comment",
      renderEmail(
        row({
          comment_id: "00000000-0000-4000-8000-0000000000c1",
          to_profile_id: "00000000-0000-4000-8000-0000000000b1",
          payload: { kind: "comment", task_title: "Poster", author_name: "Ann", comment_body: "Looks good" },
        }),
      ),
    ],
    ["notification", renderEmail(row({ task_id: null, payload: { kind: "notification", item_kind: "assigned", title: "Poster" } }))],
    ["workspace invite", renderEmail(row({ task_id: null, payload: { kind: "invite", inviter_name: "Avi" } }))],
    [
      "project invite",
      renderEmail(
        row({
          task_id: null,
          payload: {
            kind: "invite",
            inviter_name: "Avi",
            target_kind: "project",
            target_name: "Brand",
            target_path: "/projects/00000000-0000-4000-8000-000000000004",
          },
        }),
      ),
    ],
    ["form confirmation", renderEmail(row({ template: "form_confirmation", payload: { form_title: "Logo form", task_title: "Logo" } }))],
    ["due tomorrow", renderEmail(row({ template: "due_tomorrow", payload: { task_title: "Poster" } }))],
    ["requester update", renderEmail(row({ template: "requester_update", payload: { task_title: "Poster", section_name: "Done" } }))],
    ["rule email", renderEmail(row({ template: "custom", payload: { task_title: "Poster", message: "Hi" } }))],
    [
      "response without replies",
      renderEmail(row({ payload: { kind: "submitter_response", author_name: "Dan", message: "Hi Terry" }, subject: "Re: x" }), { canReply: false }),
    ],
    [
      "digest",
      renderDigestEmail(row({ task_id: null, payload: { kind: "digest", frequency: "daily", total: 1, time_zone: "UTC" } }), [
        {
          item_id: "i1",
          kind: "assigned",
          data: {},
          created_at: "2026-11-01T09:00:00Z",
          parts: { actor_name: "Rhona", title: "Flyer", group_key: "p1", group_label: "Brand", path: "/my-tasks" },
        },
      ]),
    ],
    ["report", renderReportEmail(row({ task_id: null, payload: { kind: "report", name: "Weekly", frequency: "weekly", report: "overview" } }))],
    ["review check", review([{ assetId: "a1", name: "notes.docx", contentType: null }])],
  ];
  for (const [what, email] of emails) assertNoReply(email, what);
});

test("comment emails: the old “Replies aren’t read” line merged into the footnote (said once)", () => {
  const email = renderEmail(
    row({
      comment_id: "00000000-0000-4000-8000-0000000000c1",
      to_profile_id: "00000000-0000-4000-8000-0000000000b1",
      payload: { kind: "comment", task_title: "Poster", author_name: "Ann", comment_body: "Looks good" },
    }),
  );
  assert.ok(email.text.endsWith("Do not reply to this email. Open the task to answer."), "the last line");
  assert.doesNotMatch(email.text + email.html, /aren’t read|Open the task to reply/);
});

test("a response with replies on: the reply line near the top, no footnote, from EMAIL_FROM", () => {
  const email = renderEmail(
    row({ payload: { kind: "submitter_response", author_name: "Dan", message: "Hi Terry" }, subject: 'Re: "Logo form" submission received' }),
    { canReply: true },
  );
  assert.equal(email.replyable, true);
  const lines = email.text.split("\n").filter(Boolean);
  assert.deepEqual(lines.slice(0, 2), [SUBMITTER_REPLY_MARKER, CAN_REPLY_NOTE], "right under the reply marker");
  // The hidden preview line (Nov 11 notes, 191) quotes the message first; the card shows the line above it.
  assert.ok(email.html.indexOf(CAN_REPLY_NOTE) < email.html.lastIndexOf("Hi Terry"), "above the message in the HTML");
  assert.match(email.html, /bgcolor="#fff2e6"[^>]*>You can reply to this email to respond\./, "a highlighted box");
  assert.ok(!email.text.includes(NO_REPLY_NOTE) && !email.html.includes(NO_REPLY_NOTE));
  assert.equal(email.text.split(CAN_REPLY_NOTE).length, 2, "said once");
});

test("the layout: the design can't hide either line; a hint follows the footnote", () => {
  const hidden = { ...DESIGN_DEFAULTS.internal, showNotice: false, showFooter: false, showBody: false, showDetails: false };
  const sample = renderDesignSample("internal", hidden, { sample: "comment" });
  assert.ok(sample.text.includes(NO_REPLY_NOTE) && sample.html.includes(NO_REPLY_NOTE), "small print and sign-off hidden, footnote stays");
  const replyable = renderDesignSample("requester", { ...DESIGN_DEFAULTS.requester, showNotice: false, showHeading: false }, { sample: "response", canReply: true });
  assert.ok(replyable.text.includes(CAN_REPLY_NOTE) && replyable.html.includes(CAN_REPLY_NOTE));
  const plain = layout("Heading", ["Body"], [], { noReplyHint: "Open the task to answer." });
  assert.ok(plain.text.endsWith(`${NO_REPLY_NOTE} Open the task to answer.`));
  assert.equal(layout("Heading", [], [], { replyable: true }).replyable, true);
});

test("previews: every sample says what the real email says, and which sender it'd use", () => {
  for (const kind of ["internal", "requester"] as const) {
    for (const { key } of DESIGN_SAMPLES[kind]) {
      for (const canReply of [false, true]) {
        const email = renderDesignSample(kind, DESIGN_DEFAULTS[kind], { sample: key, canReply });
        const replyable = kind === "requester" && key === "response" && canReply;
        assert.equal(email.replyable, replyable, `${kind}/${key}/${canReply}`);
        if (replyable) assert.ok(email.text.includes(CAN_REPLY_NOTE));
        else assertNoReply(email, `${kind}/${key}`);
      }
    }
  }
  assert.equal(previewFromLabel('"Studio" <no-reply@ex.com>'), '"Studio" <no-reply@ex.com>');
  assert.match(previewFromLabel(null), /No sending address is set up here/);
});

test("senders: EMAIL_FROM_NOREPLY for no-reply emails, EMAIL_FROM for replyable ones, the sender name in front", () => {
  const saved = { from: process.env.EMAIL_FROM, noReply: process.env.EMAIL_FROM_NOREPLY };
  try {
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_FROM_NOREPLY;
    assert.equal(configuredSender(false), null, "nothing without EMAIL_FROM");
    assert.equal(fromFor(true, "Studio"), null);

    process.env.EMAIL_FROM = "ALHC Projects <requests@mail.example.com>";
    assert.equal(configuredSender(false), "ALHC Projects <requests@mail.example.com>", "falls back to EMAIL_FROM");
    assert.equal(fromFor(false, null), "ALHC Projects <requests@mail.example.com>");
    process.env.EMAIL_FROM_NOREPLY = "  ";
    assert.equal(configuredSender(false), "ALHC Projects <requests@mail.example.com>", "a blank value is unset");

    process.env.EMAIL_FROM_NOREPLY = "no-reply@mail.example.com";
    assert.equal(configuredSender(false), "no-reply@mail.example.com");
    assert.equal(configuredSender(true), "ALHC Projects <requests@mail.example.com>");
    assert.equal(fromFor(false, "Autumn Lake"), '"Autumn Lake" <no-reply@mail.example.com>', "the sender name in front, like fromHeader");
    assert.equal(fromFor(true, "Autumn Lake"), '"Autumn Lake" <requests@mail.example.com>');
    assert.equal(fromFor(false, null), "no-reply@mail.example.com");

    process.env.EMAIL_FROM_NOREPLY = "Do Not Reply <no-reply@mail.example.com>";
    assert.equal(fromFor(false, null), "Do Not Reply <no-reply@mail.example.com>", "its own name without a sender name");
    assert.equal(fromFor(false, "Studio"), fromHeader("Do Not Reply <no-reply@mail.example.com>", "Studio"));
    assert.equal(senderAddress("Do Not Reply <no-reply@mail.example.com>"), "no-reply@mail.example.com");
    assert.equal(senderAddress("plain@example.com"), "plain@example.com");
    assert.equal(senderAddress(null), null);
  } finally {
    if (saved.from === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = saved.from;
    if (saved.noReply === undefined) delete process.env.EMAIL_FROM_NOREPLY;
    else process.env.EMAIL_FROM_NOREPLY = saved.noReply;
  }
});

test("the sender name setting's preview names both senders when they differ", () => {
  assert.equal(senderPreview("", "req@ex.com", null), "req@ex.com");
  assert.equal(senderPreview("Studio", "req@ex.com", "req@ex.com"), "Studio <req@ex.com>");
  assert.equal(
    senderPreview("Studio", "req@ex.com", "no-reply@ex.com"),
    "Studio <no-reply@ex.com>; responses to a form’s submitter from Studio <req@ex.com>",
  );
});

test("review email (62): one big preview per row, never upscaled, Outlook-safe; tiles for the rest", () => {
  const signed = "https://db.example.supabase.co/storage/v1/object/sign/task-attachments/t/thumb-1.jpg?token=x";
  const email = review([
    { assetId: "big", name: "poster.png", contentType: "image/png", thumbnailUrl: signed, thumbnailWidth: 1200 },
    { assetId: "small", name: "icon.png", contentType: "image/png", thumbnailUrl: signed, thumbnailWidth: 300 },
    { assetId: "unknown", name: "proof.pdf", contentType: "application/pdf", thumbnailUrl: signed },
    { assetId: "failed", name: "flyer.pdf", contentType: "application/pdf", thumbnailUrl: null },
    { assetId: "doc", name: "brief.docx", contentType: null },
  ]);
  const urls = reviewUrls("https://app.example.com", TOKEN);
  const imgs = (email.html.match(/<img [^>]*>/g) ?? []).filter((img) => !img.includes("/brand/logo-horizontal.png"));
  assert.equal(imgs.length, 3, "a picture for each thumbnail");
  assert.equal(EMAIL_IMAGE_WIDTH, 504, "the email's content width");
  assert.match(imgs[0], /width="504" style="display:block;width:100%;max-width:504px;height:auto;/, "the content width, height auto");
  assert.match(imgs[1], /width="300" [^>]*max-width:300px/, "a small image keeps its own width");
  assert.match(imgs[2], /width="504"/, "an unknown width fills the content");
  for (const img of imgs) assert.match(img, /alt="[^"]+"/);
  assert.match(email.html, /<table role="presentation" width="504"[^>]*max-width:504px/, "the list is a table as wide as the content");
  assert.equal(email.html.match(/<tr><td valign="top" style="padding:0 0 16px 0">/g)?.length, 5, "one file per row");
  assert.match(email.html, />PDF<\/span>/, "the failed thumbnail's tile");
  assert.match(email.html, />DOCX<\/span>/, "the document's tile");
  assert.match(email.html, /height="96"[^>]*bgcolor="#f1f5f9"/, "tiles are tables with a set height");
  for (const id of ["big", "small", "unknown", "failed", "doc"]) {
    assert.ok(email.html.includes(`href="${urls.file(id).replace(/&/g, "&#38;")}"`), `${id} opens its file`);
  }
  assert.doesNotMatch(email.html, /display:\s*(grid|flex)|background-image|background:\s*url/i, "nothing Outlook / Gmail drop");
  assert.equal(email.html.match(/<a [^>]*>(Approve|Leave feedback)<\/a>/g)?.length, 2, "still the two buttons");
  assert.equal(emailImageWidth(null), 504);
  assert.equal(emailImageWidth(0), 504);
  assert.equal(emailImageWidth(2000), 504);
  assert.equal(emailImageWidth(320.4), 320);
});

test("thumbnails (62): drawn sharper, kept under a size cap, and their size read from the JPEG", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(640, 360);
  const jpeg = canvas.toBuffer("image/jpeg", 80);
  assert.deepEqual(jpegSize(new Uint8Array(jpeg)), { width: 640, height: 360 });
  assert.equal(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null, "not a JPEG");
  assert.equal(jpegSize(new Uint8Array([0xff, 0xd8, 0xff])), null, "cut short");

  const tried: number[] = [];
  const fits = encodeWithinCap((q) => {
    tried.push(q);
    return Buffer.alloc(q >= 72 ? THUMB_MAX_BYTES + 1 : 10);
  });
  assert.equal(fits.length, 10);
  assert.deepEqual(tried, [82, 72, 62], "lower quality until it fits");
  const never = encodeWithinCap(() => Buffer.alloc(THUMB_MAX_BYTES + 1));
  assert.equal(never.length, THUMB_MAX_BYTES + 1, "the last try is kept");
  assert.equal(THUMB_QUALITIES[0], 82);
});
