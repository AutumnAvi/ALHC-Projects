// Email control (Oct 19 notes): subject and heading templates with {email_subject} / {email_heading},
// show / hide per block, editable small print, the response heading that no longer repeats the subject,
// and the preview rendering what the drain sends. The subject vectors are the same as the SQL ones in
// supabase/tests/zz28_oct19_notes_smoke.sql (email_subject_fill_in), so the two can't drift apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESIGN_DEFAULTS,
  EMPTY_SETTINGS,
  RESPONSE_HEADING,
  applyDesign,
  designFromJson,
  designProblem,
  designedHeading,
  designedSubject,
  formatDesignDate,
  renderSubjectTemplate,
  resolveEmailDesign,
  type ResolvedDesign,
} from "@/lib/email-design";
import { renderDesignSample, renderEmail } from "@/lib/email";
import type { OutboxRow } from "@/lib/email-layout";
import { SUBMITTER_REPLY_MARKER } from "@/lib/email-reply";

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
    send_after: "2026-10-19T00:00:00Z",
    sent_at: null,
    created_at: "2026-10-19T00:00:00Z",
    updated_at: "2026-10-19T00:00:00Z",
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

const comment = row({
  comment_id: "00000000-0000-4000-8000-0000000000c1",
  payload: { task_title: "Flyer", author_name: "Avery", comment_body: "Looks good to me", project_name: "Creative" },
});
const response = row({
  subject: 'Re: "Logo form" submission received',
  payload: { kind: "submitter_response", author_name: "Avery", task_title: "Logo", request_label: "Req #7", message: "Here is the draft." },
});

function internal(overrides: Partial<ResolvedDesign>, values = {}) {
  return applyDesign("internal", { ...DESIGN_DEFAULTS.internal, ...overrides }, values);
}
function requester(overrides: Partial<ResolvedDesign>, values = {}) {
  return applyDesign("requester", { ...DESIGN_DEFAULTS.requester, ...overrides }, values);
}

test("resolution: a form's Hidden beats the workspace's Shown; an unset switch inherits", () => {
  const { design, sources } = resolveEmailDesign("requester", {
    form: { ...EMPTY_SETTINGS, showHeading: false },
    project: { ...EMPTY_SETTINGS, showDetails: false, subjectTemplate: "Re: {task_name}" },
    workspace: { ...EMPTY_SETTINGS, showHeading: true, showDetails: true },
  });
  assert.equal(design.showHeading, false);
  assert.equal(sources.showHeading, "form");
  assert.equal(design.showDetails, false);
  assert.equal(sources.showDetails, "project");
  assert.equal(design.showButton, true);
  assert.equal(sources.showButton, "default");
  assert.equal(design.subjectTemplate, "Re: {task_name}");
});

test("the database's resolved design: booleans and the new texts; an older database reads as defaults", () => {
  const design = designFromJson("requester", { show_heading: false, subject_template: "S {task_name}", heading_text: "H", notice_text: "" });
  assert.equal(design.showHeading, false);
  assert.equal(design.subjectTemplate, "S {task_name}");
  assert.equal(design.headingText, "H");
  assert.equal(design.noticeText, "");
  const old = designFromJson("internal", { header_text: "Old", show_heading: "yes" });
  assert.equal(old.headerText, "Old");
  assert.equal(old.showHeading, true, "a non-boolean switch is ignored");
  assert.equal(old.subjectTemplate, "");
});

test("limits: the subject stays on one line and under 300 characters", () => {
  assert.equal(designProblem({ ...EMPTY_SETTINGS, subjectTemplate: "Re:\n{task_name}" }), "Keep the subject on one line");
  assert.equal(designProblem({ ...EMPTY_SETTINGS, subjectTemplate: "x".repeat(301) }), "Keep it under 300 characters");
  assert.equal(designProblem({ ...EMPTY_SETTINGS, headingText: "x".repeat(301) }), "Keep it under 300 characters");
  assert.equal(designProblem({ ...EMPTY_SETTINGS, noticeText: "x".repeat(501) }), "Keep it under 500 characters");
  assert.equal(designProblem({ ...EMPTY_SETTINGS, subjectTemplate: "Re: {task_name}", showLogo: false }), null);
});

test("subject fill-in: the same vectors as the database's email_subject_fill_in()", () => {
  const vectors: [string, Record<string, string>, "internal" | "requester", string][] = [
    [
      "Re: {request_number} – {Task_Name} for { requester_name } {nonsense}{task_link}",
      { request_number: "Req #042", task_name: "  Spring\tflyer ", requester_name: "Jordan", task_link: "x" },
      "requester",
      "Re: Req #042 – Spring flyer for Jordan",
    ],
    ["[Creative]\n  {email_subject}  ", { email_subject: "{task_name} \\ back" }, "internal", "[Creative] {task_name} \\ back"],
    ["{task_link}", { task_link: "L" }, "internal", "L"],
    ["{task_link}", { task_link: "L" }, "requester", ""],
    ["Due {due_date}", { due_date: "Sep 5, 2026" }, "requester", "Due Sep 5, 2026"],
    ["é".repeat(310), {}, "requester", "é".repeat(300)],
    ["", {}, "requester", ""],
  ];
  for (const [template, values, kind, expected] of vectors) {
    // The database returns "" for an empty result and its caller falls back; here "own" is the
    // email_subject value (or "") so the two read the same.
    const { email_subject: own = "", ...rest } = values;
    assert.equal(renderSubjectTemplate(template, rest, kind, own), expected || own, template);
  }
  assert.equal(formatDesignDate("2026-09-05"), "Sep 5, 2026", "the due date reads like to_char 'Mon FMDD, YYYY'");
});

test("designed subjects: empty = the email's own, {email_subject} keeps it, a blank result falls back", () => {
  assert.equal(designedSubject(internal({}), "Avery commented on “Flyer”"), "Avery commented on “Flyer”");
  assert.equal(designedSubject(internal({ subjectTemplate: "[Creative] {email_subject}" }), "Own"), "[Creative] Own");
  assert.equal(
    designedSubject(requester({ subjectTemplate: "Re: {request_number} – {task_name}" }, { request_number: "Req #042", task_name: "Spring flyer" }), "Own"),
    "Re: Req #042 – Spring flyer",
  );
  assert.equal(designedSubject(requester({ subjectTemplate: "{nonsense} {task_link}" }, { task_link: "https://x" }), "Own"), "Own");
});

test("designed headings: {email_heading} is the email's own; empty = the email's own", () => {
  assert.equal(designedHeading(internal({}), "Own heading", "Subj"), "Own heading");
  assert.equal(designedHeading(internal({ headingText: "{commenter_name}: {email_heading}" }, { commenter_name: "Avery" }), "Own", "Subj"), "Avery: Own");
  assert.equal(designedHeading(internal({ headingText: "About {email_subject}" }), "Own", "Subj"), "About Subj");
});

test("every block hides from the HTML and the text part", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  const all = renderEmail(comment, { design: internal({ logoPath: "", headerText: "Studio", introMessage: "Hello there" }) });
  for (const piece of ["Studio", "Hello there", "Looks good to me", "Task: ", "Open task", "Replies to this email aren’t read", "Sent by ALHC Projects"]) {
    assert.ok(all.text.includes(piece), `shown by default: ${piece}`);
  }
  assert.ok(all.html.includes("<h1"));

  // [switch, what the text part loses, what the HTML loses]
  const cases: [Partial<ResolvedDesign>, string, string][] = [
    [{ showHeader: false }, "Studio", "Studio"],
    [{ showIntro: false }, "Hello there", "Hello there"],
    [{ showBody: false }, "Looks good to me", "Looks good to me"],
    [{ showDetails: false }, "Task: ", ">Task</td>"],
    [{ showButton: false }, "Open task", ">Open task</a>"],
    [{ showNotice: false }, "Replies to this email aren’t read", "Replies to this email aren’t read"],
    [{ showFooter: false }, "Sent by ALHC Projects", "Sent by ALHC Projects"],
  ];
  for (const [flag, text, html] of cases) {
    assert.ok(all.html.includes(html), `shown by default in the HTML: ${html}`);
    const email = renderEmail(comment, { design: internal({ headerText: "Studio", introMessage: "Hello there", ...flag }) });
    assert.ok(!email.text.includes(text), `hidden from the text: ${text}`);
    assert.ok(!email.html.includes(html), `hidden from the HTML: ${html}`);
  }

  const noHeading = renderEmail(comment, { design: internal({ showHeading: false }) });
  assert.ok(!noHeading.html.includes("<h1"), "no heading");
  assert.ok(noHeading.html.includes(`<title>${noHeading.subject}</title>`), "the subject is the page title");
  assert.ok(!noHeading.text.includes("Avery commented"), "and not in the text");

  const logo = applyDesign("internal", { ...DESIGN_DEFAULTS.internal, logoPath: "x/logo.png" }, {}, { logoUrl: () => "https://cdn.example.com/logo.png" });
  assert.ok(renderEmail(comment, { design: logo }).html.includes("<img"));
  assert.ok(!renderEmail(comment, { design: { ...logo, show: { ...logo.show, logo: false } } }).html.includes("<img"), "logo hidden");
});

test("small print: custom text replaces the email's own; the reply line always stays", () => {
  const custom = renderEmail(comment, { design: internal({ noticeText: "Questions? Ask {commenter_name}." }, { commenter_name: "Avery" }) });
  assert.ok(custom.text.includes("Questions? Ask Avery.") && !custom.text.includes("Replies to this email aren’t read"));
  const hidden = renderEmail(response, { canReply: true, design: requester({ showNotice: false, showBody: false }) });
  assert.ok(hidden.text.startsWith(SUBMITTER_REPLY_MARKER), "the reply marker stays (replies are cut at it)");
  assert.ok(!hidden.text.includes("Reply to this email to answer"), "the small print is gone");
  assert.ok(hidden.text.includes("Here is the draft."), "a response always carries its message");
});

test("responses: the heading no longer repeats the subject, and the stored subject is never re-templated", () => {
  const plain = renderEmail(response, { canReply: false, design: requester({}) });
  assert.equal(plain.subject, 'Re: "Logo form" submission received');
  assert.ok(plain.html.includes(`>${RESPONSE_HEADING}</h1>`), "the response heading");
  assert.ok(!plain.html.includes(">Re: &#34;Logo form&#34; submission received</h1>"), "not the subject");
  const templated = renderEmail(response, { canReply: false, design: requester({ subjectTemplate: "Other {task_name}", headingText: "Hi {requester_name}" }, { requester_name: "Rhea", task_name: "Logo" }) });
  assert.equal(templated.subject, 'Re: "Logo form" submission received', "the database's subject (the conversation's) is kept");
  assert.ok(templated.html.includes(">Hi Rhea</h1>"), "the designed heading");
});

test("the preview renders what the drain sends: real names, the reply rule, each sample", () => {
  const off = renderDesignSample("requester", DESIGN_DEFAULTS.requester, { sample: "response", values: { form_name: "Logo form" }, canReply: false });
  assert.equal(off.subject, 'Re: "Logo form" submission received');
  assert.ok(!off.text.includes(SUBMITTER_REPLY_MARKER) && off.text.includes("Replies to this email aren’t read."), "no reply line without inbound email");
  const on = renderDesignSample("requester", DESIGN_DEFAULTS.requester, { sample: "response", canReply: true });
  assert.ok(on.text.startsWith(SUBMITTER_REPLY_MARKER));
  const templated = renderDesignSample(
    "requester",
    { ...DESIGN_DEFAULTS.requester, subjectTemplate: "{request_number}: {email_subject}" },
    { sample: "response", values: { form_name: "Logo form" } },
  );
  assert.equal(templated.subject, 'Req #042: Re: "Logo form" submission received', "the subject the database would store");

  const confirmation = renderDesignSample("requester", DESIGN_DEFAULTS.requester, { sample: "confirmation", requestWrap: true });
  assert.equal(confirmation.subject, "[Req #042] We received your Design request form");
  const noBrackets = renderDesignSample("requester", DESIGN_DEFAULTS.requester, { sample: "confirmation", requestWrap: false });
  assert.equal(noBrackets.subject, "Req #042 · We received your Design request form");
  const update = renderDesignSample("requester", { ...DESIGN_DEFAULTS.requester, subjectTemplate: "[Studio] {email_subject}" }, { sample: "update" });
  assert.equal(update.subject, "[Studio] [Req #042] Update on Spring flyer");

  for (const sample of ["comment", "assigned", "invite"] as const) {
    const email = renderDesignSample("internal", { ...DESIGN_DEFAULTS.internal, subjectTemplate: "[Creative] {email_subject}" }, { sample });
    assert.ok(email.subject.startsWith("[Creative] ") && email.subject.length > "[Creative] ".length, sample);
    assert.ok(!/\{[a-z_]+\}/.test(email.html + email.text), `no raw fill-ins: ${sample}`);
  }
});
