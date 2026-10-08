import "server-only";
import { isInboundEmailConfigured, replyAddress, REPLY_MARKER } from "@/lib/email-reply";
import { backgroundOrigin } from "@/lib/origin";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/database.types";

// Email delivery for the outbox the database fills (form confirmations, rule emails, comment emails to
// followers). Uses Resend's HTTP API when RESEND_API_KEY and EMAIL_FROM are set; otherwise rows are
// marked "mocked" and logged (id and template only — never an address, subject, or body).

type OutboxRow = Tables<"email_outbox">;
type Rendered = { subject: string; text: string; html: string };

function payloadOf(row: OutboxRow): Record<string, Json | undefined> {
  const p = row.payload;
  return p && typeof p === "object" && !Array.isArray(p) ? p : {};
}

function str(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

type Action = { label: string; href: string };

function layout(
  heading: string,
  paragraphs: string[],
  rows: { label: string; value: string }[],
  options: { action?: Action | null; preface?: string | null; footer?: string[] } = {},
) {
  const { action, preface, footer = [] } = options;
  const text = [
    ...(preface ? [preface, ""] : []),
    heading,
    "",
    ...paragraphs,
    ...(rows.length ? ["", ...rows.map((r) => `${r.label}: ${r.value}`)] : []),
    ...(action ? ["", `${action.label}: ${action.href}`] : []),
    ...(footer.length ? ["", ...footer] : []),
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:ui-sans-serif,system-ui,sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
${preface ? `<p style="margin:0 0 12px;font-size:12px;color:#a1a1aa">${escapeHtml(preface)}</p>` : ""}
<div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px">
<h1 style="margin:0 0 12px;font-size:18px">${escapeHtml(heading)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(p)}</p>`).join("")}
${
  rows.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px">${rows
        .map(
          (r) =>
            `<tr><td style="padding:6px 8px 6px 0;color:#71717a;vertical-align:top;white-space:nowrap">${escapeHtml(r.label)}</td><td style="padding:6px 0;white-space:pre-wrap">${escapeHtml(r.value)}</td></tr>`,
        )
        .join("")}</table>`
    : ""
}
${
  action
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(action.href)}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:8px 14px;border-radius:8px">${escapeHtml(action.label)}</a></p>`
    : ""
}
</div>
${footer.map((line) => `<p style="font-size:12px;color:#a1a1aa;margin:12px 0 0;text-align:center">${escapeHtml(line)}</p>`).join("")}
<p style="font-size:12px;color:#a1a1aa;margin:16px 0 0;text-align:center">Sent by ALHC Projects</p>
</div></body></html>`;
  return { text, html };
}

// The signed-in task link (never public or tokenized): the recipient's project, else My Tasks for a
// private task. Null without a known app origin.
function taskLink(row: OutboxRow, projectId: string | null): string | null {
  const origin = backgroundOrigin();
  if (!origin || !row.task_id) return null;
  return projectId ? `${origin}/projects/${projectId}?task=${row.task_id}` : `${origin}/my-tasks?task=${row.task_id}`;
}

// A follower's comment email: task, project, who commented, the comment, and an Open task link. With
// inbound replies on, a marker line tells the reader where to type (the inbound route cuts everything
// below it).
function renderCommentEmail(row: OutboxRow, canReply: boolean): Rendered {
  const p = payloadOf(row);
  const taskTitle = str(p.task_title) ?? "a task";
  const author = str(p.author_name) ?? "Someone";
  const project = str(p.project_name);
  const label = str(p.request_label);
  const link = taskLink(row, str(p.project_id));
  const origin = backgroundOrigin();
  return {
    subject: row.subject ?? `${author} commented on “${taskTitle}”`,
    ...layout(
      `${author} commented on “${taskTitle}”`,
      [str(p.comment_body) ?? ""],
      [
        { label: "Task", value: label ? `${label} · ${taskTitle}` : taskTitle },
        { label: "Project", value: project ?? "Private task (My Tasks)" },
      ],
      {
        action: link ? { label: "Open task", href: link } : null,
        preface: canReply ? REPLY_MARKER : null,
        footer: [
          canReply
            ? "Reply to this email to add a comment as you. Only the text above the quoted message is posted."
            : "Open the task to reply.",
          `You follow this task. Turn off comment emails in Settings → Profile${origin ? ` (${origin}/settings/profile)` : ""}.`,
        ],
      },
    ),
  };
}

export function renderEmail(row: OutboxRow, options: { canReply?: boolean } = {}): Rendered {
  if (row.comment_id) return renderCommentEmail(row, Boolean(options.canReply));
  const p = payloadOf(row);
  const label = str(p.request_label);
  const taskTitle = str(p.task_title) ?? "your request";
  const message = str(p.message);
  const reference = label ? `${label} · ` : "";

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
        ),
      };
    }
    case "due_tomorrow":
      return {
        subject: row.subject ?? `${reference}Due tomorrow: ${taskTitle}`,
        ...layout("Due tomorrow", [message ?? `“${taskTitle}” is due tomorrow.`], [
          ...(str(p.project_name) ? [{ label: "Project", value: str(p.project_name)! }] : []),
          ...(str(p.due_on) ? [{ label: "Due", value: str(p.due_on)! }] : []),
        ]),
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
        ...layout(label ? `Update on ${label}` : "Update on your request", [message ?? `There's an update on “${taskTitle}”.`], rows),
      };
    }
  }
}

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

// Reply-To for comment emails: the follower's per-task reply address, only when inbound replies are
// configured (RESEND_WEBHOOK_SECRET). Other emails keep the optional EMAIL_REPLY_TO.
async function replyTo(row: OutboxRow, admin: NonNullable<ReturnType<typeof createAdminClient>>): Promise<string | null> {
  if (!row.comment_id) return process.env.EMAIL_REPLY_TO?.trim() || null;
  if (!isInboundEmailConfigured()) return null;
  const { data, error } = await admin.rpc("email_reply_token", { target_email: row.id });
  if (error || typeof data !== "string") return null;
  return replyAddress(data);
}

async function deliver(
  row: OutboxRow,
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
): Promise<{ outcome: "sent" | "mocked" | "error"; id?: string; error?: string }> {
  const reply = await replyTo(row, admin);
  const email = renderEmail(row, { canReply: Boolean(reply && row.comment_id) });
  if (!isEmailConfigured()) {
    console.info(`[email:mocked] id=${row.id} template=${row.comment_id ? "comment" : row.template}`);
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
      from: process.env.EMAIL_FROM,
      to: [row.to_email],
      subject: email.subject,
      text: email.text,
      html: email.html,
      ...(reply ? { reply_to: reply } : {}),
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
  const counts = { claimed: data?.length ?? 0, sent: 0, mocked: 0, failed: 0 };
  for (const row of data ?? []) {
    let result: Awaited<ReturnType<typeof deliver>>;
    try {
      result = await deliver(row, admin);
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
