import "server-only";
import {
  BRAND_BAR,
  BRAND_BORDER,
  BRAND_HIGHLIGHT,
  BRAND_LOGO_ALT,
  BRAND_LOGO_WIDTH,
  BRAND_PAGE,
  brandLogoUrl,
  defaultAppliedDesign,
  designedHeading,
  designedSubject,
  type AppliedDesign,
} from "@/lib/email-design";
import type { Json, Tables } from "@alhc/core/supabase/database.types";

// The HTML / text shell every outbox email uses (Real features 3 moved it out of email.ts so the digest
// and report emails share it): a heading, paragraphs, label / value rows, optional extra blocks (the
// digest's groups, a report's tables), one button, and footer lines. Every value is escaped. Since Oct 19
// notes it also makes the subject: the email's own, or the design's subject template filled in; and the
// design can hide any block (the reply marker, the reply / no-reply lines, and the "Turn off" links
// always stay).

export type OutboxRow = Tables<"email_outbox">;
// `replyable`: the email carries a Reply-To the app reads (a response to a form's submitter while replies
// by email are on). The senders pick the From address by it: EMAIL_FROM for replyable emails, the no-reply
// sender (EMAIL_FROM_NOREPLY) for every other one (Nov 1 notes, batch 8).
export type Rendered = { subject: string; text: string; html: string; replyable?: boolean };

// Nov 1 notes (batch 8): every email that isn't replyable ends with this footnote, and a replyable one says
// so at the top. Neither can be hidden by the design's block switches (like the reply marker).
export const NO_REPLY_NOTE = "Do not reply to this email.";
export const CAN_REPLY_NOTE = "You can reply to this email to respond.";
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

// Nov 11 notes (191): the shared type and colors every email's blocks use (the digest's lists, a report's
// tables, the review email's files), so nothing looks bolted on. The brand colors stay in email-design.ts.
export const EMAIL_FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const EMAIL_INK = "#0f172a";
export const EMAIL_BODY_TEXT = "#334155";
export const EMAIL_MUTED = "#64748b";
export const EMAIL_PANEL = "#f8fafc";
// The content's width: the 560 px card less 28 px of padding on each side.
export const EMAIL_CONTENT_WIDTH = 504;

// A section title inside an email (a digest's "Your tasks due today", a report's "By project").
export function emailSectionHeading(label: string, first = false): string {
  return `<h2 style="margin:${first ? "8px" : "28px"} 0 10px 0;padding:0 0 8px 0;border-bottom:1px solid ${escapeHtml(
    BRAND_BORDER,
  )};font-size:13px;line-height:18px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:${EMAIL_MUTED};${EMAIL_FONT}">${escapeHtml(
    label,
  )}</h2>`;
}

// A group's title under a section ("Creative Requests" under "Unread in your Inbox").
export function emailSubheading(label: string, first = false): string {
  return `<h3 style="margin:${first ? "4px" : "20px"} 0 2px 0;font-size:14px;line-height:20px;font-weight:700;color:${EMAIL_INK};${EMAIL_FONT}">${escapeHtml(
    label,
  )}</h3>`;
}

// The call to action: a table cell with the brand color (Outlook draws a cell's bgcolor, never a link's
// padding), 44 px tall, full width on a phone (the `alhc-btn` class).
export function emailButton(action: Action, color: string, textColor: string, margin = "28px 0 0 0"): string {
  const bg = escapeHtml(color);
  return `<table role="presentation" class="alhc-btn" cellpadding="0" cellspacing="0" border="0" style="margin:${margin}"><tr><td align="center" bgcolor="${bg}" style="border-radius:8px;background:${bg}"><a href="${escapeHtml(
    action.href,
  )}" target="_blank" style="display:inline-block;padding:12px 26px;font-size:15px;font-weight:600;line-height:20px;color:${escapeHtml(
    textColor,
  )};text-decoration:none;border-radius:8px;${EMAIL_FONT}">${escapeHtml(action.label)}</a></td></tr></table>`;
}

// The hidden first line inbox lists show next to the subject (never the subject itself again).
function preheaderText(candidates: string[]): string {
  const first = candidates.map((c) => c.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return first.length > 140 ? `${first.slice(0, 137).trimEnd()}…` : first;
}

export function layout(
  heading: string,
  paragraphs: string[],
  rows: { label: string; value: string }[],
  options: {
    // The email's own subject (default: its heading). The design's subject template may replace it.
    subject?: string | null;
    // A subject the database already designed (responses to a form's submitter): kept as is.
    subjectFixed?: boolean;
    // The paragraphs are the email itself (a response's message): shown even when the design hides
    // the message block.
    alwaysBody?: boolean;
    // Nov 11 notes (191): the paragraphs are someone's words (a comment, a message, a note): drawn as a
    // quote in a soft panel with the brand edge.
    quoteBody?: boolean;
    action?: Action | null;
    preface?: string | null;
    // The email carries a Reply-To the app reads: "You can reply to this email to respond." at the top
    // instead of the "Do not reply to this email." footnote.
    replyable?: boolean;
    // Said right after the no-reply footnote ("Do not reply to this email. Open the task to answer.").
    noReplyHint?: string | null;
    footer?: string[];
    blocks?: Block[];
    // A small link under the footer lines (the digest's and report's "Turn off" links).
    footerLink?: Action | null;
    // The email's design (Email designs): logo, accent, header, heading, intro, small print, sign-off,
    // button, and which blocks show. Without one, the built-in internal look.
    design?: AppliedDesign | null;
  } = {},
): Rendered {
  const { preface, blocks = [], footerLink } = options;
  const replyable = options.replyable === true;
  const replyLine = replyable ? CAN_REPLY_NOTE : "";
  const noReply = replyable ? "" : [NO_REPLY_NOTE, options.noReplyHint?.trim() ?? ""].filter(Boolean).join(" ");
  const design = options.design ?? defaultAppliedDesign("internal");
  const { show } = design;
  const ownSubject = (options.subject ?? heading).slice(0, 300);
  const subject = options.subjectFixed ? ownSubject : designedSubject(design, ownSubject);
  const shownHeading = show.heading ? designedHeading(design, heading, ownSubject) : "";
  const headerText = show.header ? design.headerText : "";
  const logoUrl = show.logo ? design.logoUrl : null;
  const intro = show.intro ? design.introMessage : "";
  const body = show.body || options.alwaysBody ? paragraphs.filter((x) => x !== "") : [];
  const shownRows = show.details ? rows : [];
  const footer = show.notice ? (design.noticeText ? [design.noticeText] : (options.footer ?? [])) : [];
  const signOff = show.footer ? design.footerText : "";
  // The button: the email's own action, with the design's label when it sets one; a requester email
  // gets one only when its design names a label and there's a form to link to.
  let action: Action | null = options.action ?? null;
  if (action && design.buttonLabel) action = { ...action, label: design.buttonLabel };
  if (!action && design.kind === "requester" && design.buttonLabel && design.buttonHref) {
    action = { label: design.buttonLabel, href: design.buttonHref };
  }
  if (!show.button) action = null;

  // The plain-text part: the same content in the same order, the heading underlined, the details
  // aligned, the button as "Label: link", the sign-off after a rule, and the footnote last.
  const labelWidth = Math.min(16, Math.max(0, ...shownRows.map((r) => r.label.length)));
  const sections: string[][] = [
    preface ? [preface] : [],
    replyLine ? [replyLine] : [],
    headerText ? [headerText] : [],
    shownHeading ? [shownHeading, "-".repeat(Math.min(60, Math.max(3, shownHeading.length)))] : [],
    intro ? [intro] : [],
    options.quoteBody ? body.map((x) => x.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">")).join("\n")) : body,
    shownRows.map((r) => `${`${r.label}:`.padEnd(labelWidth + 2)}${r.value}`),
    ...blocks.map((b) => [b.text]),
    action ? [`${action.label}: ${action.href}`] : [],
    footer,
    footerLink ? [`${footerLink.label}: ${footerLink.href}`] : [],
    signOff ? ["—", signOff] : [],
    noReply ? [noReply] : [],
  ];
  const text = sections
    .filter((section) => section.length)
    .map((section) => section.join("\n"))
    .join("\n\n");

  const accent = escapeHtml(design.accentColor);
  // Nov 9 notes (181): no stored logo means the public Autumn Lake logo. A design that names its own
  // path still uses that URL (the old editor path); hiding the logo block hides both.
  const shownLogo = logoUrl ?? (show.logo ? brandLogoUrl() : null);
  const font = EMAIL_FONT;
  const cardBorder = escapeHtml(BRAND_BORDER);
  const headerRow =
    shownLogo || headerText
      ? `<tr><td class="alhc-pad" style="padding:24px 28px 20px 28px;border-bottom:1px solid ${cardBorder}">${
          shownLogo
            ? logoUrl
              ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(headerText || design.headerText || "Logo")}" height="32" style="display:block;height:32px;max-width:200px;border:0;outline:none;text-decoration:none">`
              : `<img src="${escapeHtml(shownLogo)}" alt="${BRAND_LOGO_ALT}" width="${BRAND_LOGO_WIDTH}" style="display:block;width:${BRAND_LOGO_WIDTH}px;max-width:${BRAND_LOGO_WIDTH}px;height:auto;border:0;outline:none;text-decoration:none">`
            : ""
        }${
          headerText
            ? `<p style="margin:${shownLogo ? "14px" : "0"} 0 0 0;font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${accent};${font}">${textHtml(headerText)}</p>`
            : ""
        }</td></tr>`
      : "";
  const button = action ? emailButton(action, design.buttonColor, design.buttonTextColor) : "";
  // Under the button, the same link written out (buttons that don't render, and people who copy links).
  const linkLine = action
    ? `<p style="margin:14px 0 0 0;font-size:12px;line-height:18px;color:${EMAIL_MUTED};word-break:break-all;${font}">Or open this link: <a href="${escapeHtml(
        action.href,
      )}" target="_blank" style="color:${accent};text-decoration:underline">${escapeHtml(action.href)}</a></p>`
    : "";
  const rowsHtml = shownRows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${EMAIL_PANEL}" style="margin:20px 0 0 0;background:${EMAIL_PANEL};border:1px solid ${cardBorder};border-radius:8px;font-size:14px">${shownRows
        .map(
          (r, i) =>
            `<tr><td valign="top" width="1%" style="width:1%;padding:${i ? "0" : "12px"} 16px 12px 16px;font-size:13px;line-height:20px;color:${EMAIL_MUTED};white-space:nowrap;${font}">${escapeHtml(r.label)}</td><td valign="top" style="padding:${i ? "0" : "12px"} 16px 12px 0;font-size:14px;line-height:20px;font-weight:600;color:${EMAIL_INK};${font}">${textHtml(r.value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const p = (value: string, extra = "") =>
    `<p style="margin:0 0 14px 0;font-size:15px;line-height:24px;color:${EMAIL_BODY_TEXT};${font};${extra}">${textHtml(value)}</p>`;
  const bodyHtml = options.quoteBody && body.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 6px 0"><tr><td bgcolor="${EMAIL_PANEL}" style="padding:14px 18px 2px 18px;background:${EMAIL_PANEL};border-left:3px solid ${escapeHtml(
        design.buttonColor,
      )};border-radius:0 8px 8px 0">${body.map((x) => p(x, `color:${EMAIL_INK}`)).join("")}</td></tr></table>`
    : body.map((x) => p(x)).join("");
  const small = (value: string) =>
    `<p style="margin:0 0 10px 0;font-size:12px;line-height:18px;color:${EMAIL_MUTED};text-align:center;${font}">${textHtml(value)}</p>`;

  const bar = escapeHtml(BRAND_BAR);
  const page = escapeHtml(BRAND_PAGE);
  const highlight = escapeHtml(BRAND_HIGHLIGHT);
  const link = accent;
  const preheader = preheaderText([intro, ...body, shownHeading]);
  const html = `<!doctype html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="format-detection" content="telephone=no,address=no,email=no,date=no"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(shownHeading || subject)}</title>
<style>
@media only screen and (max-width:600px){
  .alhc-outer{padding:16px 8px !important}
  .alhc-pad{padding-left:20px !important;padding-right:20px !important}
  .alhc-h1{font-size:20px !important;line-height:28px !important}
  .alhc-btn{width:100% !important}
  .alhc-btn a{display:block !important;text-align:center !important}
}
</style></head>
<body style="margin:0;padding:0;background:${page};-webkit-text-size-adjust:100%;${font}">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${page};opacity:0">${escapeHtml(preheader)}${"&#847;&zwnj;&nbsp;".repeat(30)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${page}" style="background:${page}"><tr><td align="center" class="alhc-outer" style="padding:32px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px">
${preface ? `<tr><td style="padding:0 4px 12px 4px;font-size:12px;line-height:18px;color:#94a3b8;${font}">${escapeHtml(preface)}</td></tr>` : ""}
<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${cardBorder};border-radius:12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td height="6" bgcolor="${bar}" style="height:6px;line-height:6px;font-size:0;background:${bar};border-radius:12px 12px 0 0">&nbsp;</td></tr>
${headerRow}
${
  replyLine
    ? `<tr><td class="alhc-pad" style="padding:20px 28px 0 28px;${font}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${highlight}" style="padding:12px 16px;background:${highlight};border:1px solid #ffd7b5;border-radius:8px;font-size:14px;line-height:20px;font-weight:600;color:${link};${font}">${escapeHtml(replyLine)}</td></tr></table></td></tr>`
    : ""
}
<tr><td class="alhc-pad" style="padding:28px 28px 32px 28px;${font}">
${shownHeading ? `<h1 class="alhc-h1" style="margin:0 0 16px 0;font-size:22px;line-height:30px;font-weight:700;letter-spacing:-0.2px;color:${EMAIL_INK};${font}">${escapeHtml(shownHeading)}</h1>` : ""}
${intro ? p(intro) : ""}
${bodyHtml}
${rowsHtml}
${blocks.map((b) => b.html).join("\n")}
${button}
${linkLine}
</td></tr>
</table>
</td></tr>
<tr><td style="padding:24px 16px 8px 16px">
${footer.map(small).join("")}
${
  footerLink
    ? `<p style="margin:0 0 10px 0;font-size:12px;line-height:18px;text-align:center;${font}"><a href="${escapeHtml(footerLink.href)}" style="color:${link};text-decoration:underline">${escapeHtml(footerLink.label)}</a></p>`
    : ""
}
${
  signOff || noReply
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 0 0"><tr><td style="padding:14px 0 0 0;border-top:1px solid ${cardBorder}">${
        signOff ? `<p style="margin:0 0 6px 0;font-size:13px;line-height:18px;font-weight:600;color:#475569;text-align:center;${font}">${textHtml(signOff)}</p>` : ""
      }${noReply ? small(noReply) : ""}</td></tr></table>`
    : ""
}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { subject, text, html, replyable };
}
