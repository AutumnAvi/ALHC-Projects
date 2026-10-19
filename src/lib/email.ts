import "server-only";
import {
  applyDesign,
  defaultAppliedDesign,
  designFromJson,
  formatDesignDate,
  isEmailDesignKind,
  SAMPLE_VALUES,
  type AppliedDesign,
  type EmailDesignKind,
  type ResolvedDesign,
} from "@/lib/email-design";
import { layout, payloadOf, str, type OutboxRow, type Rendered } from "@/lib/email-layout";
import { isInboundEmailConfigured, replyAddress, SUBMITTER_REPLY_MARKER } from "@/lib/email-reply";
import { renderDigestEmail, renderReportEmail, unsubscribeLinks } from "@/lib/email-scheduled";
import { backgroundOrigin } from "@/lib/origin";
import { settingsHref } from "@/lib/shell";
import { createAdminClient } from "@/lib/supabase/admin";
import { WORKSPACE_ASSETS_BUCKET } from "@/lib/workspace";

// Email delivery for the outbox the database fills (form confirmations, rule emails, comment emails to
// followers, responses to form submitters (the only emails with a Reply-To), invites, since Real features 2 the notification emails people turn on per kind in
// Settings → Notifications, and since Real features 3 Inbox digests and scheduled reports —
// email-scheduled.ts renders those). Uses Resend's HTTP API when RESEND_API_KEY and EMAIL_FROM are set; otherwise rows are
// marked "mocked" and logged (id and template only — never an address, subject, or body).

// The signed-in task link (never public or tokenized): the recipient's project, else My Tasks for a
// private task. Null without a known app origin.
function taskLink(row: OutboxRow, projectId: string | null): string | null {
  const origin = backgroundOrigin();
  if (!origin || !row.task_id) return null;
  return projectId ? `${origin}/projects/${projectId}?task=${row.task_id}` : `${origin}/my-tasks?task=${row.task_id}`;
}

// The request number in front of a task name, with the issuing project's "Wrap the label in brackets"
// setting (email_design_context's request_wrap, read at send time): "[Task #3] Logo" or "Task #3 · Logo".
// The label stays bare inside sentences ("We received your request (Task #3)").
export function labelPrefix(label: string | null, wrap: boolean): string {
  if (!label) return "";
  return wrap ? `[${label}] ` : `${label} · `;
}

// A follower's comment email: task, project, who commented, the comment, and an Open task link. No-reply
// (Comments and reply by email): workspace people answer in the app; only a form submitter's response
// email can be answered by email (renderSubmitterResponseEmail).
function renderCommentEmail(row: OutboxRow, design?: AppliedDesign | null, requestWrap = true): Rendered {
  const p = payloadOf(row);
  const taskTitle = str(p.task_title) ?? "a task";
  const author = str(p.author_name) ?? "Someone";
  const project = str(p.project_name);
  const label = str(p.request_label);
  const link = taskLink(row, str(p.project_id));
  const origin = backgroundOrigin();
  // Real features 2: a follower who is @mentioned in the comment (and wants mention emails).
  const verb = p.mentioned === true ? "mentioned you on" : "commented on";
  return {
    subject: row.subject ?? `${author} ${verb} “${taskTitle}”`,
    ...layout(
      `${author} ${verb} “${taskTitle}”`,
      [str(p.comment_body) ?? ""],
      [
        { label: "Task", value: `${labelPrefix(label, requestWrap)}${taskTitle}` },
        { label: "Project", value: project ?? "Private task (My tasks)" },
      ],
      {
        action: link ? { label: "Open task", href: link } : null,
        footer: [
          "Open the task to reply. Replies to this email aren’t read.",
          p.mentioned === true
            ? `You were @mentioned. Choose which emails you get in Settings → Notifications${origin ? ` (${origin}${settingsHref("notifications")})` : ""}.`
            : `You follow this task. Turn off comment emails in Settings → Notifications${origin ? ` (${origin}${settingsHref("notifications")})` : ""}.`,
        ],
        design,
      },
    ),
  };
}

export function isSubmitterResponse(row: OutboxRow): boolean {
  return Boolean(row.task_id) && !row.comment_id && payloadOf(row).kind === "submitter_response";
}

// A response to a form's submitter ("Send response to submitter" under the comment box): Asana's subject
// (Re: "<form>" submission received), the comment as written, and — when replies by email are on — a line
// to reply above. Someone outside the workspace reads it, so no app links, no names of other people.
export function renderSubmitterResponseEmail(
  row: OutboxRow,
  canReply: boolean,
  design?: AppliedDesign | null,
  requestWrap = true,
): Rendered {
  const p = payloadOf(row);
  const author = str(p.author_name) ?? "The team";
  const label = str(p.request_label);
  const taskTitle = str(p.task_title);
  const subject = row.subject ?? "Re: your request";
  return {
    subject,
    ...layout(
      subject,
      [str(p.message) ?? ""],
      [
        { label: "From", value: author },
        ...(taskTitle ? [{ label: "Request", value: `${labelPrefix(label, requestWrap)}${taskTitle}` }] : []),
      ],
      {
        preface: canReply ? SUBMITTER_REPLY_MARKER : null,
        footer: [
          canReply
            ? "Reply to this email to answer. Your reply is added to your request; only the text above the quoted message is kept."
            : "Replies to this email aren’t read.",
        ],
        design,
      },
    ),
  };
}

const INVITE_TARGET_PATH = /^\/(projects|portfolios|teams)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVITE_KINDS = { project: "project", portfolio: "portfolio", team: "team" } as const;

// "with Editor access" / "as a team lead" for the role a pending invite carries.
function inviteRolePhrase(kind: keyof typeof INVITE_KINDS, role: string | null): string {
  if (!role) return "";
  if (kind === "team") return role === "lead" ? " as a team lead" : " as a member";
  return ` with ${role.charAt(0).toUpperCase()}${role.slice(1)} access`;
}

// A project, portfolio, or team invite for someone who hasn't signed in yet (Real features 1): who
// invited them (a name), to what, and a sign-up link for their own address that lands on it once they've
// confirmed their email (the invite becomes a membership on that first sign-in).
function renderTargetInviteEmail(
  row: OutboxRow,
  kind: keyof typeof INVITE_KINDS,
  path: string,
  design?: AppliedDesign | null,
): Rendered {
  const p = payloadOf(row);
  const inviter = str(p.inviter_name) ?? "A teammate";
  const workspace = str(p.workspace_name) ?? "ALHC Projects";
  const target = str(p.target_name) ?? `a ${kind}`;
  const origin = backgroundOrigin();
  const next = encodeURIComponent(path);
  const signUp = origin ? `${origin}/signup?email=${encodeURIComponent(row.to_email)}&next=${next}` : null;
  return {
    subject: row.subject ?? `${inviter} invited you to ${target}`,
    ...layout(
      `${inviter} invited you to ${target}`,
      [
        `${inviter} added you to the ${INVITE_KINDS[kind]} “${target}”${inviteRolePhrase(kind, str(p.role))} in ${workspace} on ALHC Projects, where the team plans and tracks its work.`,
        `Create your account with this email address. Once you confirm it, you’ll land on the ${INVITE_KINDS[kind]}.`,
      ],
      [],
      {
        action: signUp ? { label: "Sign up", href: signUp } : null,
        footer: [
          // The path is /projects|portfolios|teams/<uuid> (checked above), fine unencoded in a query string.
          origin ? `Already have an account? Sign in at ${origin}/login?next=${path}` : "Already have an account? Sign in with this address.",
          "If you weren’t expecting this, you can ignore this email.",
        ],
        design,
      },
    ),
  };
}

// A workspace invite (Settings → Workspace → Members): who invited them (a name, never an address) and a
// sign-up link for the recipient's own address. A project / portfolio / team invite carries its target.
function renderInviteEmail(row: OutboxRow, design?: AppliedDesign | null): Rendered {
  const p = payloadOf(row);
  const kind = str(p.target_kind);
  const path = str(p.target_path);
  if (kind && kind in INVITE_KINDS && path && INVITE_TARGET_PATH.test(path)) {
    return renderTargetInviteEmail(row, kind as keyof typeof INVITE_KINDS, path, design);
  }
  const inviter = str(p.inviter_name) ?? "A workspace admin";
  const workspace = str(p.workspace_name) ?? "ALHC Projects";
  const origin = backgroundOrigin();
  const signUp = origin ? `${origin}/signup?email=${encodeURIComponent(row.to_email)}` : null;
  return {
    subject: row.subject ?? "You’ve been invited to ALHC Projects",
    ...layout(
      "You’ve been invited to ALHC Projects",
      [
        `${inviter} invited you to ${workspace} on ALHC Projects, where the team plans and tracks its work.`,
        "Create your account with this email address. Projects and teams you were added to are waiting for you after you confirm your email.",
      ],
      [],
      {
        action: signUp ? { label: "Sign up", href: signUp } : null,
        footer: [
          origin ? `Already have an account? Sign in at ${origin}/login` : "Already have an account? Sign in with this address.",
          "If you weren’t expecting this, you can ignore this email.",
        ],
        design,
      },
    ),
  };
}

function isInvite(row: OutboxRow) {
  return !row.task_id && payloadOf(row).kind === "invite";
}

function isNotification(row: OutboxRow) {
  return !row.task_id && payloadOf(row).kind === "notification";
}

const STATUS_LABELS: Record<string, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  on_hold: "On hold",
  complete: "Complete",
};

const DECISIONS: Record<string, string> = {
  approved: "approved",
  changes_requested: "requested changes on",
  rejected: "rejected",
};

// An Inbox notification the recipient asked to get by email too (Settings → Notifications, Real
// features 2): who did what where, the comment / message / note, and a link to it. The database stored
// the parts (payload) and checks again at send time that the recipient still wants it and can open it.
function renderNotificationEmail(row: OutboxRow, design?: AppliedDesign | null): Rendered {
  const p = payloadOf(row);
  const data = p.data && typeof p.data === "object" && !Array.isArray(p.data) ? p.data : {};
  const actor = str(p.actor_name) ?? "Someone";
  const title = str(p.title) ?? "a task";
  const context = str(p.context);
  const detail = str(p.detail);
  const quoted = `“${title}”`;
  const rows: { label: string; value: string }[] = [];
  let heading: string;
  let action = "Open task";
  switch (str(p.item_kind)) {
    case "assigned":
      heading = `${actor} assigned you ${quoted}`;
      rows.push({ label: "Project", value: context ?? "Private task (My tasks)" });
      break;
    case "completed":
      heading = `${actor} completed ${quoted}`;
      rows.push({ label: "Project", value: context ?? "Private task (My tasks)" });
      break;
    case "approval_requested":
      heading = data.resubmitted ? `${actor} resubmitted ${quoted} for your approval` : `${actor} asked for your approval on ${quoted}`;
      rows.push({ label: "Project", value: context ?? "Private task (My tasks)" });
      break;
    case "approval_decided":
      heading = `${actor} ${DECISIONS[str(data.status) ?? ""] ?? "decided an approval on"} ${quoted}`;
      rows.push({ label: "Project", value: context ?? "Private task (My tasks)" });
      break;
    case "mention":
      heading = `${actor} mentioned you in ${quoted}`;
      action = "Open message";
      if (context) rows.push({ label: p.team_message_id ? "Team" : "Project", value: context });
      break;
    case "message":
      heading = data.new_thread === true ? `${actor} posted ${quoted}${context ? ` in ${context}` : ""}` : `${actor} replied in ${quoted}`;
      action = "Open message";
      if (context && data.new_thread !== true) rows.push({ label: p.team_message_id ? "Team" : "Project", value: context });
      break;
    case "status_update": {
      heading = `${actor} posted a status update on ${title}`;
      action = "Open project";
      const status = STATUS_LABELS[str(data.status) ?? ""];
      if (status) rows.push({ label: "Status", value: status });
      if (context) rows.push({ label: "Update", value: context });
      break;
    }
    default: {
      const field = str(data.field_name);
      heading = field ? `${actor} changed ${field} on ${quoted}` : `${actor} notified you about ${quoted}`;
      if (context) rows.push({ label: "Project", value: context });
      break;
    }
  }
  const origin = backgroundOrigin();
  const path = str(p.path);
  const href = origin && path && path.startsWith("/") ? `${origin}${path}` : null;
  const field = str(data.field_name);
  const body =
    str(p.item_kind) === "rule" && field ? (detail ? `${field}: ${detail}` : `${field} was cleared`) : detail;
  return {
    subject: (row.subject ?? heading).slice(0, 300),
    ...layout(heading, body ? [body] : [], rows, {
      action: href ? { label: action, href } : null,
      footer: [
        `You get this email because it’s on in Settings → Notifications${origin ? ` (${origin}${settingsHref("notifications")})` : ""}. Your Inbox has it too unless you turned that off.`,
      ],
      design,
    }),
  };
}

export function renderEmail(
  row: OutboxRow,
  options: { canReply?: boolean; design?: AppliedDesign | null; requestWrap?: boolean } = {},
): Rendered {
  const design = options.design ?? defaultAppliedDesign(guessDesignKind(row));
  const wrap = options.requestWrap !== false;
  if (row.comment_id) return renderCommentEmail(row, design, wrap);
  if (isSubmitterResponse(row)) return renderSubmitterResponseEmail(row, Boolean(options.canReply), design, wrap);
  if (isInvite(row)) return renderInviteEmail(row, design);
  if (isNotification(row)) return renderNotificationEmail(row, design);
  const p = payloadOf(row);
  const label = str(p.request_label);
  const taskTitle = str(p.task_title) ?? "your request";
  const message = str(p.message);
  const reference = labelPrefix(label, wrap);

  switch (row.template) {
    case "form_confirmation": {
      const formTitle = str(p.form_title) ?? "request";
      const answers = Array.isArray(p.answers)
        ? p.answers.flatMap((a) => {
            const r = a && typeof a === "object" && !Array.isArray(a) ? a : {};
            return typeof r.label === "string" && typeof r.value === "string" ? [{ label: r.label, value: r.value }] : [];
          })
        : [];
      return {
        subject: row.subject ?? `${reference}We received your ${formTitle}`,
        ...layout(
          label ? `We received your request (${label})` : "We received your request",
          [message ?? "Thanks for your submission. We'll follow up by email as it moves along.", `Request: ${taskTitle}`],
          answers,
          { design },
        ),
      };
    }
    case "due_tomorrow":
      return {
        subject: row.subject ?? `${reference}Due tomorrow: ${taskTitle}`,
        ...layout("Due tomorrow", [message ?? `“${taskTitle}” is due tomorrow.`], [
          ...(str(p.project_name) ? [{ label: "Project", value: str(p.project_name)! }] : []),
          ...(str(p.due_on) ? [{ label: "Due", value: str(p.due_on)! }] : []),
        ], { design }),
      };
    case "requester_update":
    case "custom":
    default: {
      const field = p.field && typeof p.field === "object" && !Array.isArray(p.field) ? p.field : null;
      const rows = [
        ...(str(p.section_name) && row.template === "requester_update" ? [{ label: "Status", value: str(p.section_name)! }] : []),
        ...(field && str(field.name) && str(field.value) ? [{ label: str(field.name)!, value: str(field.value)! }] : []),
      ];
      return {
        subject: row.subject ?? `${reference}Update on ${taskTitle}`,
        ...layout(label ? `Update on ${label}` : "Update on your request", [message ?? `There's an update on “${taskTitle}”.`], rows, {
          design,
        }),
      };
    }
  }
}

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

// The From header: EMAIL_FROM, with the workspace's sender name (Settings → Workspace → Email) in front
// of its address when one is set. The name can't carry quotes or brackets (database CHECK).
export function fromHeader(configured: string, senderName: string | null): string {
  if (!senderName) return configured;
  const address = configured.match(/<([^<>]+)>\s*$/)?.[1]?.trim() ?? configured.trim();
  return `"${senderName}" <${address}>`;
}

async function workspaceSenderName(admin: NonNullable<ReturnType<typeof createAdminClient>>): Promise<string | null> {
  const { data } = await admin
    .from("workspaces")
    .select("email_sender_name")
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  return data?.email_sender_name ?? null;
}

// Reply-To (Comments and reply by email): only a response to a form's submitter gets one — its thread's
// r-<token>@<reply domain> address, while inbound replies are configured (RESEND_WEBHOOK_SECRET). Every
// other email is no-reply. `token` is the database lookup (submitter_reply_token, service role).
export async function replyToFor(
  row: OutboxRow,
  token: (emailId: string) => Promise<string | null>,
): Promise<string | null> {
  if (!isSubmitterResponse(row) || !isInboundEmailConfigured()) return null;
  const found = await token(row.id);
  return found && /^[0-9a-f]{40}$/.test(found) ? replyAddress(found) : null;
}

async function replyTo(row: OutboxRow, admin: NonNullable<ReturnType<typeof createAdminClient>>): Promise<string | null> {
  return replyToFor(row, async (emailId) => {
    const { data, error } = await admin.rpc("submitter_reply_token", { target_email: emailId });
    return error || typeof data !== "string" ? null : data;
  });
}

function scheduledKind(row: OutboxRow): "digest" | "report" | null {
  const kind = row.task_id ? null : payloadOf(row).kind;
  return kind === "digest" || kind === "report" ? kind : null;
}

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

// Digests and reports (Real features 3): a digest's items are read now, with the recipient's own access
// (digest_email_items); a report's numbers were built as the recipient when it was queued. Both carry
// List-Unsubscribe headers, so mail apps offer their own one-click "Unsubscribe" (it posts to the same
// narrow endpoint as the email's "Turn off" link).
async function renderScheduled(
  row: OutboxRow,
  kind: "digest" | "report",
  admin: Admin,
  design: AppliedDesign,
): Promise<{ email: Rendered; headers: Record<string, string> } | { error: string }> {
  let email: Rendered;
  if (kind === "digest") {
    const items = await admin.rpc("digest_email_items", { target_email: row.id });
    if (items.error) return { error: "Couldn’t read the digest’s items" };
    if (!items.data?.length) return { error: "Not sent: everything in it was read, archived, or can no longer be opened" };
    email = renderDigestEmail(row, items.data, design);
  } else {
    email = renderReportEmail(row, design);
  }
  const links = unsubscribeLinks(row, kind === "digest" ? "digest" : "reports");
  return {
    email,
    headers: links
      ? { "List-Unsubscribe": `<${links.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
      : {},
  };
}

// Which design an email uses when the database can't say (a database without the email designs
// update): emails to a form's submitter are requester emails, everything else internal.
export function guessDesignKind(row: OutboxRow): EmailDesignKind {
  if (isSubmitterResponse(row) || row.template === "form_confirmation") return "requester";
  if (row.template === "requester_update" && !row.to_profile_id) return "requester";
  return "internal";
}

// A logo in the public workspace-assets bucket, as a plain URL email clients can load.
export function emailLogoUrl(path: string): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
  if (!base || !/^[0-9a-f-]{36}\/[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) return null;
  return `${base}/storage/v1/object/public/${WORKSPACE_ASSETS_BUCKET}/${path}`;
}

// The email's design (Email designs): email_design_context (service role) says whether it's an internal
// or a requester email, which project and form it belongs to, the resolved design (form → project →
// workspace), and the fill-in values. Without the database update, the built-in look of the guessed kind.
async function designFor(row: OutboxRow, admin: Admin): Promise<{ design: AppliedDesign; requestWrap: boolean }> {
  const fallback = guessDesignKind(row);
  const { data, error } = await admin.rpc("email_design_context", { target_email: row.id });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    return { design: defaultAppliedDesign(fallback), requestWrap: true };
  }
  const ctx = data as Record<string, unknown>;
  const kind = isEmailDesignKind(ctx.kind) ? ctx.kind : fallback;
  const v = ctx.values && typeof ctx.values === "object" && !Array.isArray(ctx.values) ? (ctx.values as Record<string, unknown>) : {};
  const s = (key: string) => (typeof v[key] === "string" && (v[key] as string).trim() ? (v[key] as string) : null);
  const origin = backgroundOrigin();
  const taskId = s("task_id");
  const projectId = s("task_project_id");
  const formId = typeof ctx.form_id === "string" ? ctx.form_id : null;
  const design = applyDesign(
    kind,
    designFromJson(kind, ctx.design),
    {
      requester_name: s("requester_name"),
      request_number: s("request_number"),
      task_name: s("task_name"),
      project_name: s("project_name"),
      form_name: s("form_name"),
      commenter_name: s("commenter_name"),
      due_date: formatDesignDate(s("due_date")),
      task_link:
        kind === "internal" && origin && taskId
          ? projectId
            ? `${origin}/projects/${projectId}?task=${taskId}`
            : `${origin}/my-tasks?task=${taskId}`
          : null,
    },
    {
      logoUrl: emailLogoUrl,
      buttonHref: kind === "requester" && origin && formId ? `${origin}/forms/${formId}` : null,
    },
  );
  // The issuing project's bracket setting (absent before Oct 19's migration: brackets, as before).
  return { design, requestWrap: v.request_wrap !== false };
}

// A representative email of a kind with a design, for the editor's live preview and "Send me a test":
// a comment email for internal designs, a response to a submitter for requester designs.
export function renderDesignSample(kind: EmailDesignKind, design: ResolvedDesign): Rendered {
  const origin = backgroundOrigin() ?? "https://example.com";
  const applied = applyDesign(kind, design, SAMPLE_VALUES, {
    logoUrl: emailLogoUrl,
    buttonHref: kind === "requester" ? `${origin}/forms/example` : null,
  });
  const now = new Date().toISOString();
  const base: OutboxRow = {
    id: "00000000-0000-4000-8000-000000000000",
    task_id: "00000000-0000-4000-8000-000000000001",
    rule_id: null,
    to_email: "you@example.com",
    template: "custom",
    subject: null,
    payload: {},
    status: "pending",
    attempts: 0,
    last_error: null,
    provider_message_id: null,
    send_after: now,
    sent_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    to_profile_id: null,
    comment_id: null,
    max_attempts: 5,
    delivery_status: null,
    delivery_event_at: null,
    delivery_detail: null,
  };
  if (kind === "requester") {
    return renderSubmitterResponseEmail(
      {
        ...base,
        subject: `Re: "${SAMPLE_VALUES.form_name}" submission received`,
        payload: {
          kind: "submitter_response",
          author_name: SAMPLE_VALUES.commenter_name,
          task_title: SAMPLE_VALUES.task_name,
          request_label: SAMPLE_VALUES.request_number,
          message: `Hi ${SAMPLE_VALUES.requester_name},\n\nThanks for the details. We’ll have a first draft for you by ${SAMPLE_VALUES.due_date}.`,
        },
      },
      true,
      applied,
    );
  }
  return renderCommentEmail(
    {
      ...base,
      comment_id: "00000000-0000-4000-8000-000000000002",
      payload: {
        kind: "comment",
        task_title: SAMPLE_VALUES.task_name,
        author_name: SAMPLE_VALUES.commenter_name,
        comment_body: "The first draft is ready for review. Could you take a look before Friday?",
        project_name: SAMPLE_VALUES.project_name,
        request_label: SAMPLE_VALUES.request_number,
      },
    },
    applied,
  );
}

// "Send me a test": one email straight to the signed-in person (never another address). Mocked without
// an email provider, like the drain.
export async function sendTestEmail(to: string, email: Rendered): Promise<"sent" | "mocked"> {
  if (!isEmailConfigured()) {
    console.info("[email:mocked] design test");
    return "mocked";
  }
  const admin = createAdminClient();
  const senderName = admin ? await workspaceSenderName(admin) : null;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromHeader(process.env.EMAIL_FROM!, senderName),
      to: [to],
      subject: `[Test] ${email.subject}`.slice(0, 300),
      text: email.text,
      html: email.html,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Resend responded ${response.status}`);
  return "sent";
}

async function deliver(
  row: OutboxRow,
  admin: Admin,
  senderName: string | null,
): Promise<{ outcome: "sent" | "mocked" | "error"; id?: string; error?: string }> {
  const scheduled = scheduledKind(row);
  let email: Rendered;
  let headers: Record<string, string> = {};
  let reply: string | null = null;
  const { design, requestWrap } = await designFor(row, admin);
  if (scheduled) {
    const rendered = await renderScheduled(row, scheduled, admin, design);
    if ("error" in rendered) return { outcome: "error", error: rendered.error };
    email = rendered.email;
    headers = rendered.headers;
  } else {
    reply = await replyTo(row, admin);
    email = renderEmail(row, { canReply: Boolean(reply), design, requestWrap });
  }
  if (!isEmailConfigured()) {
    const template =
      scheduled ??
      (row.comment_id
        ? "comment"
        : isSubmitterResponse(row)
          ? "submitter_response"
          : isInvite(row)
            ? "invite"
            : isNotification(row)
              ? "notification"
              : row.template);
    console.info(`[email:mocked] id=${row.id} template=${template}`);
    return { outcome: "mocked" };
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `outbox-${row.id}`,
    },
    body: JSON.stringify({
      from: fromHeader(process.env.EMAIL_FROM!, senderName),
      to: [row.to_email],
      subject: email.subject,
      text: email.text,
      html: email.html,
      ...(reply ? { reply_to: reply } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) {
    const reason = typeof body.message === "string" ? body.message.slice(0, 300) : "";
    return { outcome: "error", error: `Resend responded ${response.status}${reason ? `: ${reason}` : ""}` };
  }
  return { outcome: "sent", id: body.id };
}

// Claims queued emails with the service role and delivers them. Without SUPABASE_SERVICE_ROLE_KEY
// nothing is claimed and rows stay pending for a later run.
export async function drainOutbox(options: { onlyId?: string | null; max?: number } = {}) {
  const admin = createAdminClient();
  if (!admin) return { claimed: 0, sent: 0, mocked: 0, failed: 0, skipped: "no service role key" as const };
  const { data, error } = await admin.rpc("claim_email_deliveries", {
    max_items: options.max ?? 20,
    only_id: options.onlyId ?? null,
  });
  if (error) throw new Error(`Failed to claim emails: ${error.message}`);
  // Notification emails (Real features 2) have their own claim, so the release before them never takes
  // one; a database without the migration doesn't have it yet (PGRST202 → none). Digests and scheduled
  // reports (Real features 3) likewise. These two only log a failure: the rows the claims before them
  // already marked "sending" must still go out now, not wait out the 10-minute reclaim.
  const notifications = await admin.rpc("claim_notification_emails", {
    max_items: options.max ?? 20,
    only_id: options.onlyId ?? null,
  });
  if (notifications.error && notifications.error.code !== "PGRST202") {
    console.error("Failed to claim notification emails", notifications.error.code);
  }
  const scheduled = await admin.rpc("claim_scheduled_emails", {
    max_items: options.max ?? 20,
    only_id: options.onlyId ?? null,
  });
  if (scheduled.error && scheduled.error.code !== "PGRST202") {
    console.error("Failed to claim digest and report emails", scheduled.error.code);
  }
  const claimed = [
    ...(data ?? []),
    ...(notifications.error ? [] : (notifications.data ?? [])),
    ...(scheduled.error ? [] : (scheduled.data ?? [])),
  ];
  const counts = { claimed: claimed.length, sent: 0, mocked: 0, failed: 0 };
  const senderName = claimed.length ? await workspaceSenderName(admin) : null;
  for (const row of claimed) {
    let result: Awaited<ReturnType<typeof deliver>>;
    try {
      result = await deliver(row, admin, senderName);
    } catch (e) {
      // Network errors keep only their kind (a message could carry request details).
      result = { outcome: "error", error: e instanceof Error && e.name === "TimeoutError" ? "Resend timed out" : "Couldn’t reach Resend" };
    }
    if (result.outcome === "error") counts.failed += 1;
    else counts[result.outcome] += 1;
    await admin.rpc("complete_email_outbox", {
      target_email: row.id,
      outcome: result.outcome === "error" ? "error" : result.outcome,
      message_id: result.id ?? null,
      error_message: result.error ?? null,
    });
  }
  return counts;
}
