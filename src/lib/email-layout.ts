import "server-only";
import { defaultAppliedDesign, type AppliedDesign } from "@/lib/email-design";
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

// Paragraph text as HTML: escaped, line breaks kept (email clients ignore pre-wrap inconsistently).
function textHtml(value: string) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
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
    // The email's design (Email designs): logo, accent, header, intro, sign-off, button. Without one,
    // the built-in internal look.
    design?: AppliedDesign | null;
  } = {},
) {
  const { preface, footer = [], blocks = [], footerLink } = options;
  const design = options.design ?? defaultAppliedDesign("internal");
  // The button: the email's own action, with the design's label when it sets one; a requester email
  // gets one only when its design names a label and there's a form to link to.
  let action: Action | null = options.action ?? null;
  if (action && design.buttonLabel) action = { ...action, label: design.buttonLabel };
  if (!action && design.kind === "requester" && design.buttonLabel && design.buttonHref) {
    action = { label: design.buttonLabel, href: design.buttonHref };
  }
  const text = [
    ...(preface ? [preface, ""] : []),
    ...(design.headerText ? [design.headerText, ""] : []),
    heading,
    "",
    ...(design.introMessage ? [design.introMessage, ""] : []),
    ...paragraphs,
    ...(rows.length ? ["", ...rows.map((r) => `${r.label}: ${r.value}`)] : []),
    ...blocks.flatMap((b) => ["", b.text]),
    ...(action ? ["", `${action.label}: ${action.href}`] : []),
    ...(footer.length ? ["", ...footer] : []),
    ...(footerLink ? ["", `${footerLink.label}: ${footerLink.href}`] : []),
    ...(design.footerText ? ["", "—", design.footerText] : []),
  ].join("\n");

  const accent = escapeHtml(design.accentColor);
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const headerRow =
    design.logoUrl || design.headerText
      ? `<tr><td style="padding:20px 28px 0 28px">${
          design.logoUrl
            ? `<img src="${escapeHtml(design.logoUrl)}" alt="${escapeHtml(design.headerText || "Logo")}" height="32" style="display:block;height:32px;max-width:200px;border:0;outline:none;text-decoration:none">`
            : ""
        }${
          design.headerText
            ? `<p style="margin:${design.logoUrl ? "10px" : "0"} 0 0 0;font-size:13px;font-weight:600;letter-spacing:0.2px;color:${accent}">${textHtml(design.headerText)}</p>`
            : ""
        }</td></tr>`
      : "";
  const button = action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0"><tr><td bgcolor="${escapeHtml(design.buttonColor)}" style="border-radius:8px;background:${escapeHtml(design.buttonColor)}"><a href="${escapeHtml(action.href)}" target="_blank" style="display:inline-block;padding:10px 18px;font-size:14px;font-weight:600;line-height:20px;color:${design.buttonTextColor};text-decoration:none;border-radius:8px;${font}">${escapeHtml(action.label)}</a></td></tr></table>`
    : "";
  const rowsHtml = rows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0;font-size:14px">${rows
        .map(
          (r) =>
            `<tr><td valign="top" width="1%" style="width:1%;padding:6px 16px 6px 0;color:#71717a;white-space:nowrap;${font}">${escapeHtml(r.label)}</td><td valign="top" style="padding:6px 0;color:#18181b;${font}">${textHtml(r.value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const p = (value: string, extra = "") =>
    `<p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#18181b;${extra}">${textHtml(value)}</p>`;
  const small = (value: string) =>
    `<p style="margin:12px 0 0 0;font-size:12px;line-height:1.5;color:#71717a;text-align:center;${font}">${textHtml(value)}</p>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;${font}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f5" style="background:#f4f4f5"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px">
${preface ? `<tr><td style="padding:0 4px 12px 4px;font-size:12px;color:#a1a1aa;${font}">${escapeHtml(preface)}</td></tr>` : ""}
<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td height="4" bgcolor="${accent}" style="height:4px;line-height:4px;font-size:0;background:${accent};border-radius:12px 12px 0 0">&nbsp;</td></tr>
${headerRow}
<tr><td style="padding:20px 28px 28px 28px;${font}">
<h1 style="margin:0 0 14px 0;font-size:19px;line-height:1.35;font-weight:700;color:#18181b">${escapeHtml(heading)}</h1>
${design.introMessage ? p(design.introMessage, "color:#3f3f46") : ""}
${paragraphs.map((x) => p(x)).join("")}
${rowsHtml}
${blocks.map((b) => b.html).join("\n")}
${button}
</td></tr>
</table>
</td></tr>
<tr><td style="padding:4px 8px 0 8px">
${footer.map(small).join("")}
${
  footerLink
    ? `<p style="margin:12px 0 0 0;font-size:12px;text-align:center;${font}"><a href="${escapeHtml(footerLink.href)}" style="color:#52525b">${escapeHtml(footerLink.label)}</a></p>`
    : ""
}
${design.footerText ? small(design.footerText) : ""}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { text, html };
}
