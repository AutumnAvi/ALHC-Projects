import "server-only";
import type { Json, Tables } from "@/lib/supabase/database.types";

// The HTML / text shell every outbox email uses (Real features 3 moved it out of email.ts so the digest
// and report emails share it): a heading, paragraphs, label / value rows, optional extra blocks (the
// digest's groups, a report's tables), one button, and footer lines. Every value is escaped.

export type OutboxRow = Tables<"email_outbox">;
export type Rendered = { subject: string; text: string; html: string };
export type Action = { label: string; href: string };
// Extra content between the rows and the button: HTML (already escaped by its builder) and its text twin.
export type Block = { html: string; text: string };

export function payloadOf(row: OutboxRow): Record<string, Json | undefined> {
  const p = row.payload;
  return p && typeof p === "object" && !Array.isArray(p) ? p : {};
}

export function str(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function layout(
  heading: string,
  paragraphs: string[],
  rows: { label: string; value: string }[],
  options: {
    action?: Action | null;
    preface?: string | null;
    footer?: string[];
    blocks?: Block[];
    // A small link under the footer lines (the digest's and report's "Turn off" links).
    footerLink?: Action | null;
  } = {},
) {
  const { action, preface, footer = [], blocks = [], footerLink } = options;
  const text = [
    ...(preface ? [preface, ""] : []),
    heading,
    "",
    ...paragraphs,
    ...(rows.length ? ["", ...rows.map((r) => `${r.label}: ${r.value}`)] : []),
    ...blocks.flatMap((b) => ["", b.text]),
    ...(action ? ["", `${action.label}: ${action.href}`] : []),
    ...(footer.length ? ["", ...footer] : []),
    ...(footerLink ? ["", `${footerLink.label}: ${footerLink.href}`] : []),
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
${blocks.map((b) => b.html).join("\n")}
${
  action
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(action.href)}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:8px 14px;border-radius:8px">${escapeHtml(action.label)}</a></p>`
    : ""
}
</div>
${footer.map((line) => `<p style="font-size:12px;color:#a1a1aa;margin:12px 0 0;text-align:center">${escapeHtml(line)}</p>`).join("")}
${
  footerLink
    ? `<p style="font-size:12px;margin:12px 0 0;text-align:center"><a href="${escapeHtml(footerLink.href)}" style="color:#52525b">${escapeHtml(footerLink.label)}</a></p>`
    : ""
}
<p style="font-size:12px;color:#a1a1aa;margin:16px 0 0;text-align:center">Sent by ALHC Projects</p>
</div></body></html>`;
  return { text, html };
}

