// Email designs: override resolution (form → project → workspace → default), fill-in fields (unknown
// ones blank, {task_link} internal only), and rendering (escaped, table-based HTML with a plain-text
// part, the design's logo, colors, header, intro, sign-off, and button).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESIGN_DEFAULTS,
  EMPTY_SETTINGS,
  applyDesign,
  designProblem,
  fillIn,
  resolveEmailDesign,
  textColorOn,
} from "@/lib/email-design";
import { renderDesignSample, renderEmail } from "@/lib/email";
import type { OutboxRow } from "@/lib/email-layout";

test("resolution: form beats project beats workspace beats the default, setting by setting", () => {
  const { design, sources } = resolveEmailDesign("requester", {
    form: { ...EMPTY_SETTINGS, buttonLabel: "Submit another" },
    project: { ...EMPTY_SETTINGS, headerText: "Project header", buttonLabel: "Project button" },
    workspace: { ...EMPTY_SETTINGS, headerText: "Workspace header", accentColor: "#aa0000" },
  });
  assert.equal(design.buttonLabel, "Submit another");
  assert.equal(sources.buttonLabel, "form");
  assert.equal(design.headerText, "Project header");
  assert.equal(sources.headerText, "project");
  assert.equal(design.accentColor, "#aa0000");
  assert.equal(sources.accentColor, "workspace");
  assert.equal(design.footerText, DESIGN_DEFAULTS.requester.footerText);
  assert.equal(sources.footerText, "default");
});

test("resolution: an empty value is set (none here), and internal emails ignore form overrides", () => {
  const empty = resolveEmailDesign("requester", { project: { ...EMPTY_SETTINGS, footerText: "" }, workspace: { footerText: "Bye" } });
  assert.equal(empty.design.footerText, "");
  const internal = resolveEmailDesign("internal", { form: { headerText: "Form" }, workspace: { headerText: "WS" } });
  assert.equal(internal.design.headerText, "WS");
});

test("fill-ins: known fields fill, unknown and missing ones render blank, never braces", () => {
  const values = { requester_name: "Jordan", project_name: "Creative", task_link: "https://x/t" };
  assert.equal(fillIn("Hi {requester_name}, about {project_name}.", values, "requester"), "Hi Jordan, about Creative.");
  assert.equal(fillIn("Hello {nonsense}{due_date}!", values, "requester"), "Hello !");
  assert.equal(fillIn("{ Requester_Name }", values, "requester"), "Jordan");
  assert.equal(fillIn("Open {task_link}", values, "requester"), "Open", "task_link is internal only");
  assert.equal(fillIn("Open {task_link}", values, "internal"), "Open https://x/t");
});

test("colors and limits are checked; button text stays readable", () => {
  assert.equal(designProblem({ ...EMPTY_SETTINGS, accentColor: "red" }), "The accent color must look like #4573d2");
  assert.equal(designProblem({ ...EMPTY_SETTINGS, buttonLabel: "x".repeat(61) }), "Keep it under 60 characters");
  assert.equal(designProblem({ ...EMPTY_SETTINGS, accentColor: "#123abc" }), null);
  assert.equal(textColorOn("#ffff00"), "#18181b");
  assert.equal(textColorOn("#1d4ed8"), "#ffffff");
});

function row(extra: Partial<OutboxRow>): OutboxRow {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    task_id: "00000000-0000-4000-8000-0000000000a1",
    rule_id: null,
    to_email: "someone@example.net",
    template: "form_confirmation",
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

test("rendering: the design is applied and every user-provided text is escaped", () => {
  const design = applyDesign(
    "requester",
    {
      ...DESIGN_DEFAULTS.requester,
      accentColor: "#aa0000",
      headerText: "<b>{project_name}</b>",
      introMessage: "Hi {requester_name} & co",
      footerText: "Thanks,\nThe team",
      buttonLabel: "Submit another",
      buttonColor: "#00aa00",
    },
    { project_name: "Creative <Studio>", requester_name: "Jo \"J\"" },
    { buttonHref: "https://app.example.com/forms/abc" },
  );
  const email = renderEmail(
    row({ payload: { form_title: "Brief <form>", task_title: "<script>alert(1)</script>", message: "Thanks!" } }),
    { design },
  );
  assert.ok(email.html.includes("&#60;b&#62;Creative &#60;Studio&#62;&#60;/b&#62;"), "header text escaped");
  assert.ok(email.html.includes("Hi Jo &#34;J&#34; &#38; co"), "intro escaped");
  assert.ok(!email.html.includes("<script>"), "no raw script");
  assert.ok(email.html.includes("#aa0000"), "accent used");
  assert.ok(email.html.includes('bgcolor="#00aa00"') && email.html.includes("Submit another"), "button with its color");
  assert.ok(email.html.includes("Thanks,<br>The team"), "sign-off keeps its lines");
  assert.ok(email.html.includes('role="presentation"'), "table-based layout");
  assert.ok(email.text.includes("Hi Jo \"J\" & co") && email.text.includes("Thanks,\nThe team"), "plain-text part");
  assert.ok(email.text.includes("Submit another: https://app.example.com/forms/abc"));
  assert.ok(!/\{[a-z_]+\}/.test(email.html + email.text), "no raw fill-in braces");
});

test("rendering: internal button labels replace the email's own; empty keeps it", () => {
  const comment = row({
    template: "custom",
    comment_id: "00000000-0000-4000-8000-0000000000c1",
    payload: { task_title: "Flyer", author_name: "Avery", comment_body: "Looks good", project_id: null },
  });
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  const plain = renderEmail(comment, { design: applyDesign("internal", DESIGN_DEFAULTS.internal, {}) });
  assert.ok(plain.html.includes(">Open task</a>"));
  const custom = renderEmail(comment, {
    design: applyDesign("internal", { ...DESIGN_DEFAULTS.internal, buttonLabel: "View {task_name}" }, { task_name: "Flyer" }),
  });
  assert.ok(custom.html.includes(">View Flyer</a>"));
});

test("samples render both kinds for the preview", () => {
  const internal = renderDesignSample("internal", DESIGN_DEFAULTS.internal);
  const requester = renderDesignSample("requester", { ...DESIGN_DEFAULTS.requester, introMessage: "Hello {requester_name}" });
  assert.ok(internal.subject.length > 0 && internal.html.includes("Open task"));
  assert.ok(requester.html.includes("Hello Jordan Lee") && requester.html.includes("Creative Requests"));
  assert.ok(!requester.text.includes("{"), "fill-ins replaced in the sample");
});
