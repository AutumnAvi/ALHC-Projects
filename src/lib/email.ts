import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/database.types";

// Email delivery for the outbox the database fills (form confirmations, rule emails). Uses Resend's
// HTTP API when RESEND_API_KEY and EMAIL_FROM are set; otherwise rows are marked "mocked" and logged.

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

function layout(heading: string, paragraphs: string[], rows: { label: string; value: string }[]) {
  const text = [heading, "", ...paragraphs, ...(rows.length ? ["", ...rows.map((r) => `${r.label}: ${r.value}`)] : [])].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:ui-sans-serif,system-ui,sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
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
</div>
<p style="font-size:12px;color:#a1a1aa;margin:16px 0 0;text-align:center">Sent by ALHC Projects</p>
</div></body></html>`;
  return { text, html };
}

export function renderEmail(row: OutboxRow): Rendered {
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

async function deliver(row: OutboxRow): Promise<{ outcome: "sent" | "mocked" | "error"; id?: string; error?: string }> {
  const email = renderEmail(row);
  if (!isEmailConfigured()) {
    console.info(`[email:mocked] to=${row.to_email} subject="${email.subject}"`);
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
      ...(process.env.EMAIL_REPLY_TO ? { reply_to: process.env.EMAIL_REPLY_TO } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) return { outcome: "error", error: body.message ?? `Resend responded ${response.status}` };
  return { outcome: "sent", id: body.id };
}

// Claims queued emails with the service role and delivers them. Without SUPABASE_SERVICE_ROLE_KEY
// nothing is claimed and rows stay pending for a later run.
export async function drainOutbox(options: { onlyId?: string | null; max?: number } = {}) {
  const admin = createAdminClient();
  if (!admin) return { claimed: 0, sent: 0, mocked: 0, failed: 0, skipped: "no service role key" as const };
  const { data, error } = await admin.rpc("claim_email_outbox", {
    max_items: options.max ?? 20,
    only_id: options.onlyId ?? null,
  });
  if (error) throw new Error(`Failed to claim emails: ${error.message}`);
  const counts = { claimed: data?.length ?? 0, sent: 0, mocked: 0, failed: 0 };
  for (const row of data ?? []) {
    let result: Awaited<ReturnType<typeof deliver>>;
    try {
      result = await deliver(row);
    } catch (e) {
      result = { outcome: "error", error: e instanceof Error ? e.message : String(e) };
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
