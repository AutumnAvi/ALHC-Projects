// Nov 11 notes (191): renders every email the app sends, with realistic made-up data, to
// docs/email-previews/ (one .html and one .txt per email, plus index.html). Nothing is sent and nothing
// is read from the database; the renderers are the drain's own.
//   cd apps/web && node --import ./tests/unit/register.mjs scripts/email-previews.tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.NEXT_PUBLIC_APP_URL = "https://alhc-projects.vercel.app";
process.env.RESEND_WEBHOOK_SECRET ??= "preview-only";

const { renderEmail, renderDesignSample } = await import("@/lib/email");
const { renderReviewEmail } = await import("@/lib/review-email");
const { renderDigestEmail, renderReportEmail } = await import("@/lib/email-scheduled");
const { DESIGN_DEFAULTS } = await import("@/lib/email-design");
type OutboxRow = import("@/lib/email-layout").OutboxRow;
type Rendered = import("@/lib/email-layout").Rendered;

const TASK = "6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b";
const PROJECT = "0b7e8f9a-1c2d-4e3f-9a8b-7c6d5e4f3a2b";
const TEAM = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const TOKEN = "f".repeat(64);
const FLYER = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1008" height="640" viewBox="0 0 1008 640"><rect width="1008" height="640" fill="#fff7ef"/><rect y="0" width="1008" height="120" fill="#751c1b"/><text x="60" y="80" font-family="Georgia,serif" font-size="48" fill="#fff">Spring Open House</text><text x="60" y="230" font-family="Helvetica,Arial,sans-serif" font-size="34" fill="#0f172a">Saturday, April 18 · 10 AM – 2 PM</text><text x="60" y="290" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="#475569">Tours, refreshments, and meet the care team</text><rect x="60" y="360" width="300" height="72" rx="10" fill="#ff6800"/><text x="98" y="407" font-family="Helvetica,Arial,sans-serif" font-size="28" font-weight="700" fill="#fff">RSVP today</text></svg>',
)}`;

function row(extra: Partial<OutboxRow>): OutboxRow {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    task_id: TASK,
    rule_id: null,
    to_email: "jordan.lee@example.com",
    template: "custom",
    subject: null,
    payload: {},
    status: "sending",
    attempts: 1,
    last_error: null,
    provider_message_id: null,
    send_after: "2026-11-11T14:00:00Z",
    sent_at: null,
    created_at: "2026-11-11T14:00:00Z",
    updated_at: "2026-11-11T14:00:00Z",
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

const notification = (payload: Record<string, unknown>) =>
  row({ task_id: null, to_profile_id: "00000000-0000-4000-8000-0000000000b1", payload: { kind: "notification", ...payload } as never });

const projectPath = `/projects/${PROJECT}?task=${TASK}`;

const emails: { key: string; title: string; group: string; email: Rendered }[] = [];
const add = (group: string, key: string, title: string, email: Rendered) => emails.push({ group, key, title, email });

// --- Teammate emails --------------------------------------------------------------------------------
add(
  "Teammate emails",
  "comment",
  "Comment on a task you follow",
  renderEmail(
    row({
      comment_id: "00000000-0000-4000-8000-0000000000c1",
      to_profile_id: "00000000-0000-4000-8000-0000000000b1",
      subject: "Avery Kim commented on “Spring flyer”",
      payload: {
        kind: "comment",
        task_title: "Spring flyer",
        author_name: "Avery Kim",
        comment_body: "The new photos look great. Can we try the headline in the maroon from the brand guide?\n\nI'll send the print vendor the final PDF on Friday.",
        project_id: PROJECT,
        project_name: "Creative Requests",
        request_label: "Req #042",
      },
    }),
  ),
);
add(
  "Teammate emails",
  "mention",
  "@mention in a comment",
  renderEmail(
    row({
      comment_id: "00000000-0000-4000-8000-0000000000c2",
      to_profile_id: "00000000-0000-4000-8000-0000000000b1",
      payload: {
        kind: "comment",
        mentioned: true,
        task_title: "Fall open house invitation",
        author_name: "Morgan Diaz",
        comment_body: "@Jordan Lee can you check the RSVP link before this goes out?",
        project_id: PROJECT,
        project_name: "Events",
      },
    }),
  ),
);
const items: [string, string, Record<string, unknown>][] = [
  ["assigned", "Assigned to you", { item_kind: "assigned", actor_name: "Avery Kim", title: "Spring flyer", context: "Creative Requests", path: projectPath }],
  ["completed", "Task completed", { item_kind: "completed", actor_name: "Morgan Diaz", title: "Spring flyer", context: "Creative Requests", path: projectPath }],
  [
    "approval-requested",
    "Approval requested",
    { item_kind: "approval_requested", actor_name: "Avery Kim", title: "Spring flyer", context: "Creative Requests", task_id: TASK, path: projectPath, detail: "Final version with the new photos." },
  ],
  [
    "approval-due-soon",
    "Approval due tomorrow (reminder)",
    { item_kind: "approval_requested", actor_name: "Avery Kim", title: "Spring flyer", context: "Creative Requests", task_id: TASK, path: projectPath, data: { reminder: "due_soon" } },
  ],
  [
    "approval-overdue",
    "Approval overdue (reminder)",
    { item_kind: "approval_requested", actor_name: "Avery Kim", title: "Spring flyer", context: "Creative Requests", task_id: TASK, path: projectPath, data: { reminder: "overdue" } },
  ],
  [
    "approval-decided",
    "Approval decided (changes requested)",
    {
      item_kind: "approval_decided",
      actor_name: "Sam Rivera",
      title: "Spring flyer",
      context: "Creative Requests",
      path: projectPath,
      detail: "The logo needs more room at the top. Everything else is ready.",
      data: { status: "changes_requested" },
    },
  ],
  [
    "approval-external",
    "External reviewer approved",
    {
      item_kind: "approval_decided",
      actor_name: "Jordan Lee (external reviewer)",
      title: "Spring flyer",
      context: "Creative Requests",
      path: projectPath,
      data: { status: "approved", review_check_id: "00000000-0000-4000-8000-0000000000d1", external: true },
    },
  ],
  ["mention-message", "@mention in a message", { item_kind: "mention", actor_name: "Morgan Diaz", title: "Holiday campaign kickoff", context: "Marketing", path: `/projects/${PROJECT}/messages`, detail: "@Jordan Lee could you share last year's numbers?" }],
  [
    "message",
    "New message thread",
    { item_kind: "message", actor_name: "Morgan Diaz", title: "Holiday campaign kickoff", context: "Marketing", path: `/teams/${TEAM}`, detail: "Here's the plan for the next six weeks.", data: { new_thread: true } },
  ],
  [
    "status-update",
    "Project status update",
    { item_kind: "status_update", actor_name: "Avery Kim", title: "Creative Requests", context: "Status update — Nov 11", path: `/projects/${PROJECT}/overview`, detail: "Two flyers shipped this week; the brochure is waiting on photos.", data: { status: "at_risk" } },
  ],
  [
    "field-change",
    "Field changed",
    { item_kind: "rule", actor_name: "Avery Kim", title: "Spring flyer", context: "Creative Requests", path: projectPath, detail: "High", data: { field_change: true, field_name: "Priority" } },
  ],
  ["automation", "Automation notification", { item_kind: "rule", actor_name: "Automation “Triage”", title: "Spring flyer", context: "Creative Requests", path: projectPath, detail: "Please add the print size before Thursday." }],
];
for (const [key, title, payload] of items) add("Inbox notification emails", key, title, renderEmail(notification(payload)));
add(
  "Teammate emails",
  "due-tomorrow",
  "Due tomorrow",
  renderEmail(row({ template: "due_tomorrow", to_profile_id: "00000000-0000-4000-8000-0000000000b1", payload: { task_title: "Spring flyer", project_name: "Creative Requests", due_on: "2026-11-12" } }), {
    design: undefined,
    taskHref: `https://alhc-projects.vercel.app${projectPath}`,
  }),
);
add(
  "Teammate emails",
  "automation-email-teammate",
  "Automation “Send email” to a teammate",
  renderEmail(
    row({ to_profile_id: "00000000-0000-4000-8000-0000000000b1", payload: { task_title: "Spring flyer", message: "Spring flyer moved to Review. Please take a look today." } }),
    { taskHref: `https://alhc-projects.vercel.app${projectPath}` },
  ),
);

// --- Invites -----------------------------------------------------------------------------------------
add(
  "Invites",
  "invite-workspace",
  "Workspace invite",
  renderEmail(row({ task_id: null, subject: "You've been invited to ALHC Projects", payload: { kind: "invite", inviter_name: "Avery Kim", workspace_name: "ALHC" } })),
);
add(
  "Invites",
  "invite-project",
  "Project invite",
  renderEmail(
    row({
      task_id: null,
      payload: { kind: "invite", inviter_name: "Avery Kim", workspace_name: "ALHC", target_kind: "project", target_name: "Creative Requests", target_path: `/projects/${PROJECT}`, role: "editor" },
    }),
  ),
);
add(
  "Invites",
  "invite-team",
  "Team invite",
  renderEmail(
    row({ task_id: null, payload: { kind: "invite", inviter_name: "Avery Kim", workspace_name: "ALHC", target_kind: "team", target_name: "Marketing", target_path: `/teams/${TEAM}`, role: "member" } }),
  ),
);

// --- Requester emails --------------------------------------------------------------------------------
const requester = { design: undefined };
add(
  "Requester emails",
  "form-confirmation",
  "Form confirmation",
  renderEmail(
    row({
      template: "form_confirmation",
      payload: {
        form_title: "Design request",
        task_title: "Spring open house flyer",
        request_label: "Req #042",
        message: "Thanks, Jordan! The creative team will look at your request within one business day.",
        answers: [
          { label: "Your name", value: "Jordan Lee" },
          { label: "What do you need?", value: "Spring open house flyer" },
          { label: "Due date", value: "Nov 20, 2026" },
        ],
      },
    }),
    requester,
  ),
);
add(
  "Requester emails",
  "submitter-response",
  "Response to a form’s submitter (replies on)",
  renderEmail(
    row({
      subject: 'Re: "Design request" submission received',
      payload: { kind: "submitter_response", author_name: "Avery Kim", task_title: "Spring open house flyer", request_label: "Req #042", message: "Hi Jordan,\n\nHere's the first draft. Let us know if the date and address look right." },
    }),
    { canReply: true },
  ),
);
add(
  "Requester emails",
  "submitter-response-no-reply",
  "Response to a form’s submitter (replies off)",
  renderEmail(
    row({ subject: 'Re: "Design request" submission received', payload: { kind: "submitter_response", author_name: "Avery Kim", task_title: "Spring open house flyer", message: "Your flyer is printed and on its way." } }),
    { canReply: false },
  ),
);
add(
  "Requester emails",
  "requester-update",
  "Requester update (automation)",
  renderEmail(
    row({ template: "requester_update", payload: { task_title: "Spring open house flyer", request_label: "Req #042", message: "Your request moved to Review.", section_name: "Review" } }),
    requester,
  ),
);
add(
  "Requester emails",
  "automation-email-requester",
  "Automation “Send email” to the requester",
  renderEmail(row({ template: "custom", payload: { task_title: "Spring open house flyer", message: "We have a question about your request: what size should the flyer be?" } }), requester),
);

// --- External review ---------------------------------------------------------------------------------
const review = {
  origin: "https://alhc-projects.vercel.app",
  token: `alhc_rev_${"ab".repeat(32)}`,
  round: 2,
  recipientName: "Jordan Lee",
  senderName: "Avery Kim",
  taskTitle: "Spring open house flyer",
  projectName: "Creative Requests",
  message: "We moved the date up and used the photos you sent. Thanks for your patience!",
  assets: [
    // A stand-in for the PDF's first page (the drain signs a stored thumbnail; previews draw this instead).
    { assetId: "00000000-0000-4000-8000-0000000000f1", name: "open-house-flyer-v2.pdf", contentType: "application/pdf", thumbnailUrl: FLYER, thumbnailWidth: 504 },
    { assetId: "00000000-0000-4000-8000-0000000000f2", name: "instagram-square.mp4", contentType: "video/mp4", thumbnailUrl: null },
  ],
};
add("External review", "review-request", "External review request (with the approver’s message)", renderReviewEmail(review));
add("External review", "review-reminder", "External review reminder (24 hours later)", renderReviewEmail({ ...review, reminder: true }));

// --- Digest and report ------------------------------------------------------------------------------
add(
  "Digest and reports",
  "digest",
  "Daily digest",
  renderDigestEmail(
    row({ task_id: null, to_profile_id: "00000000-0000-4000-8000-0000000000b1", payload: { kind: "digest", frequency: "daily", total: 3, task_total: 2, today: "2026-11-11", time_zone: "America/New_York", unsubscribe_token: TOKEN } }),
    [
      { item_id: "i1", kind: "assigned", data: {}, created_at: "2026-11-11T13:05:00Z", parts: { actor_name: "Avery Kim", title: "Brochure copy", group_key: PROJECT, group_label: "Creative Requests", path: projectPath } },
      { item_id: "i2", kind: "comment", data: {}, created_at: "2026-11-11T15:42:00Z", parts: { actor_name: "Morgan Diaz", title: "Spring flyer", group_key: PROJECT, group_label: "Creative Requests", path: projectPath, detail: "Looks good to me." } },
      { item_id: "i3", kind: "mention", data: {}, created_at: "2026-11-11T16:10:00Z", parts: { actor_name: "Sam Rivera", title: "Holiday campaign kickoff", group_key: TEAM, group_label: "Team: Marketing", path: `/teams/${TEAM}` } },
    ],
    null,
    [
      { task_id: "t1", title: "Submit print order", due_on: "2026-11-09", overdue: true, project_name: "Creative Requests", path: projectPath },
      { task_id: "t2", title: "Review the brochure proof", due_on: "2026-11-11", overdue: false, project_name: null, path: "/my-tasks" },
    ],
  ),
);
add(
  "Digest and reports",
  "report",
  "Scheduled report",
  renderReportEmail(
    row({
      task_id: null,
      payload: {
        kind: "report",
        name: "Weekly creative report",
        owner_name: "Avery Kim",
        report: "overview",
        frequency: "weekly",
        time_zone: "America/New_York",
        generated_at: "2026-11-11T13:00:00Z",
        unsubscribe_token: TOKEN,
        totals: { tasks: 128, completed: 96, open: 32, overdue: 4, completed_recent: 11 },
        project_count: 3,
        projects: [
          { name: "Creative Requests", open: 18, overdue: 3, completed_recent: 7, tasks: 70, completed: 52 },
          { name: "Events", open: 9, overdue: 1, completed_recent: 3, tasks: 38, completed: 29 },
          { name: "Website", open: 5, overdue: 0, completed_recent: 1, tasks: 20, completed: 15 },
        ],
        overdue: [
          { title: "Submit print order", project: "Creative Requests", due_on: "2026-11-04", days: 7, path: projectPath },
          { title: "Book the photographer", project: "Events", due_on: "2026-11-08", days: 3, path: projectPath },
        ],
        filters_summary: ["Projects: Creative Requests, Events, Website"],
      },
    }),
  ),
);

// --- The design sample (the old editor's preview path) ----------------------------------------------
add("Design samples", "sample-internal-assigned", "Design sample: assignment", renderDesignSample("internal", DESIGN_DEFAULTS.internal, { sample: "assigned" }));

// --- Write -------------------------------------------------------------------------------------------
const out = join(process.cwd(), "..", "..", "docs", "email-previews");
mkdirSync(out, { recursive: true });
const escape = (v: string) => v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const groups = [...new Set(emails.map((e) => e.group))];
for (const { key, email } of emails) {
  writeFileSync(join(out, `${key}.html`), email.html);
  writeFileSync(join(out, `${key}.txt`), `Subject: ${email.subject}\n\n${email.text}\n`);
}
const index = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email previews</title>
<style>body{margin:0;padding:32px 16px;background:#f1f5f9;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a}main{max-width:760px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}p{color:#475569;margin:0 0 24px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.4px;color:#64748b;margin:28px 0 8px}ul{list-style:none;margin:0;padding:0;background:#fff;border:1px solid #e2e8f0;border-radius:12px}li{display:flex;gap:12px;align-items:baseline;padding:10px 16px;border-top:1px solid #e2e8f0}li:first-child{border-top:0}a{color:#b34a00;font-weight:600;text-decoration:none}span{color:#64748b;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style></head>
<body><main><h1>ALHC Projects email previews</h1><p>Every email the app sends, rendered by the app's own email code with made-up data (Nov 11 notes, 191). Each has an HTML file and its plain-text twin. Regenerate with <code>cd apps/web && node --import ./tests/unit/register.mjs scripts/email-previews.tsx</code>.</p>
${groups
  .map(
    (group) =>
      `<h2>${escape(group)}</h2><ul>${emails
        .filter((e) => e.group === group)
        .map((e) => `<li><a href="${e.key}.html">${escape(e.title)}</a><span>${escape(e.email.subject)}</span><a href="${e.key}.txt">text</a></li>`)
        .join("")}</ul>`,
  )
  .join("\n")}
</main></body></html>
`;
writeFileSync(join(out, "index.html"), index);
console.log(`wrote ${emails.length} emails to ${out}`);
