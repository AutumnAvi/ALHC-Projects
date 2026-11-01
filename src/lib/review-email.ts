import "server-only";
import { applyDesign, defaultAppliedDesign, designFromJson, type AppliedDesign } from "@/lib/email-design";
import { emailLogoUrl } from "@/lib/email";
import { escapeHtml, layout, type Rendered } from "@/lib/email-layout";
import { REVIEW_LINK_DAYS, reviewMediaKind, roundLabel } from "@/lib/review-checks";

// Oct 26 notes (batch 3) / Oct 27 notes (batch 5): the review check email. The project's (or the request
// form's) requester design — logo, accent, header, sign-off — then the sender's message, the files (a
// thumbnail of each image and each PDF's first page, drawn on the server and linked through a signed link
// that lasts as long as the review link; a file tile for anything else), each opening that file on the
// review page, and two buttons: Approve and Leave feedback (both open the review page; nothing is decided
// by the click alone, so link scanners can't approve anything), plus an "Open the review" link. The link's
// token is in the review page's URLs only, never in an image's address. Since Nov 1 notes (batch 8) each
// file is one row, its preview near the full width of the email (EMAIL_IMAGE_WIDTH), built only from
// tables and inline styles (width attributes for Outlook, no grid / flex / background images).

export type ReviewEmailAsset = {
  assetId: string;
  name: string;
  contentType: string | null;
  // A signed link to its stored thumbnail (review-thumbnails.ts), or none: the email shows a file tile.
  thumbnailUrl?: string | null;
  // The thumbnail's width in pixels when known: it's drawn at min(this, EMAIL_IMAGE_WIDTH), never upscaled.
  thumbnailWidth?: number | null;
};

export type ReviewEmailInput = {
  origin: string;
  token: string;
  round: number;
  recipientName: string | null;
  senderName: string;
  taskTitle: string;
  projectName: string | null;
  message: string | null;
  assets: ReviewEmailAsset[];
  // resolve_email_design("requester", project, form) as the database returned it (null: the default look).
  design: unknown;
};

// The email lists this many files; the rest are counted ("and 3 more files").
export const EMAIL_GRID_FILES = 9;
// The width of the email's content (layout(): a 560 px card with 28 px padding on each side): a preview
// fills it, one per row.
export const EMAIL_IMAGE_WIDTH = 504;

// The width a thumbnail is drawn at: the content width, or its own width when it's narrower (an image
// smaller than that is never blown up).
export function emailImageWidth(thumbnailWidth: number | null | undefined): number {
  return thumbnailWidth && thumbnailWidth > 0 ? Math.min(EMAIL_IMAGE_WIDTH, Math.round(thumbnailWidth)) : EMAIL_IMAGE_WIDTH;
}

export function reviewUrls(origin: string, token: string) {
  const page = `${origin}/review/${token}`;
  return {
    page,
    approve: `${page}?action=approve`,
    feedback: `${page}?action=feedback`,
    // One file of the round, opened first on the review page.
    file: (assetId: string) => `${page}?file=${encodeURIComponent(assetId)}`,
  };
}

// "PDF", "PNG", "DOCX" … for a file tile.
function extensionLabel(name: string) {
  const ext = name.match(/\.([A-Za-z0-9]{1,6})$/)?.[1];
  return ext ? ext.toUpperCase() : "FILE";
}

function kindWord(asset: ReviewEmailAsset) {
  const kind = reviewMediaKind(asset.name, asset.contentType);
  return kind === "image" ? "Image" : kind === "pdf" ? "PDF" : kind === "video" ? "Video" : "File";
}

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// One file: its preview (or a file tile) and its name under it, the whole row a link to that file on the
// review page.
function fileRow(asset: ReviewEmailAsset, href: string) {
  const name = escapeHtml(asset.name);
  const link = escapeHtml(href);
  const width = emailImageWidth(asset.thumbnailWidth);
  const picture = asset.thumbnailUrl
    ? `<a href="${link}" target="_blank" style="display:block;text-decoration:none"><img src="${escapeHtml(asset.thumbnailUrl)}" alt="${name}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:1px solid #e4e4e7;border-radius:8px;outline:none;text-decoration:none"></a>`
    : `<a href="${link}" target="_blank" style="display:block;text-decoration:none;color:#18181b"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="96" align="center" valign="middle" bgcolor="#f4f4f5" style="height:96px;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;${FONT}"><span style="display:block;font-size:18px;font-weight:700;letter-spacing:0.5px;color:#52525b">${escapeHtml(
        extensionLabel(asset.name),
      )}</span><span style="display:block;margin-top:2px;font-size:12px;color:#71717a">${kindWord(asset)}</span></td></tr></table></a>`;
  return `<tr><td valign="top" style="padding:0 0 16px 0">${picture}<a href="${link}" target="_blank" style="display:block;margin-top:6px;font-size:13px;line-height:18px;color:#3f3f46;text-decoration:none;word-break:break-word;${FONT}">${name}</a></td></tr>`;
}

export function renderReviewEmail(input: ReviewEmailInput): Rendered {
  const urls = reviewUrls(input.origin, input.token);
  const design: AppliedDesign = input.design
    ? applyDesign(
        "requester",
        designFromJson("requester", input.design),
        { requester_name: input.recipientName, task_name: input.taskTitle, project_name: input.projectName },
        { logoUrl: emailLogoUrl, buttonHref: null },
      )
    : defaultAppliedDesign("requester");
  const heading = `Please review: ${input.taskTitle}`;
  const greeting = input.recipientName ? `Hi ${input.recipientName.split(/\s+/)[0]},` : "Hi,";
  const count = input.assets.length === 1 ? "a file" : `${input.assets.length} files`;
  const intro = `${input.senderName} would like your review of ${count}${
    input.round > 1 ? ` (${roundLabel(input.round).toLowerCase()})` : ""
  }. Click a file to see it in full quality, pin comments right on it, and approve or leave feedback.`;
  const paragraphs = [greeting, input.message?.trim() || "", intro].filter(Boolean);

  const shown = input.assets.slice(0, EMAIL_GRID_FILES);
  const more = input.assets.length - shown.length;
  const grid = shown.length
    ? `<table role="presentation" width="${EMAIL_IMAGE_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0;width:100%;max-width:${EMAIL_IMAGE_WIDTH}px">${shown
        .map((a) => fileRow(a, urls.file(a.assetId)))
        .join("")}</table>${
        more > 0
          ? `<p style="margin:0 0 4px 0;font-size:12px;color:#71717a;${FONT}">And ${more} more file${more === 1 ? "" : "s"} on the review page.</p>`
          : ""
      }`
    : "";
  const buttons = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0 0"><tr><td bgcolor="${escapeHtml(
    design.buttonColor,
  )}" style="border-radius:8px;background:${escapeHtml(design.buttonColor)}"><a href="${escapeHtml(
    urls.approve,
  )}" target="_blank" style="display:inline-block;padding:10px 18px;font-size:14px;font-weight:600;line-height:20px;color:${
    design.buttonTextColor
  };text-decoration:none;border-radius:8px;${FONT}">Approve</a></td><td width="10" style="width:10px">&nbsp;</td><td style="border-radius:8px;border:1px solid #d4d4d8;background:#ffffff"><a href="${escapeHtml(
    urls.feedback,
  )}" target="_blank" style="display:inline-block;padding:9px 17px;font-size:14px;font-weight:600;line-height:20px;color:#18181b;text-decoration:none;border-radius:8px;${FONT}">Leave feedback</a></td></tr></table>`;
  const deepLink = `<p style="margin:12px 0 0 0;font-size:13px;line-height:20px;${FONT}"><a href="${escapeHtml(
    urls.page,
  )}" target="_blank" style="color:${escapeHtml(design.accentColor)};font-weight:600;text-decoration:none">Open the review &rarr;</a> <span style="color:#71717a">every file in full quality</span></p>`;
  const html = `${grid}${buttons}${deepLink}`;
  const text = [
    `Files:`,
    ...input.assets.map((a) => `- ${a.name}: ${urls.file(a.assetId)}`),
    "",
    `Approve: ${urls.approve}`,
    `Leave feedback: ${urls.feedback}`,
    `Open the review: ${urls.page}`,
  ].join("\n");

  return layout(heading, paragraphs, input.projectName ? [{ label: "Project", value: input.projectName }] : [], {
    subject: `Review requested: ${input.taskTitle}${input.round > 1 ? ` (${roundLabel(input.round)})` : ""}`,
    alwaysBody: true,
    blocks: [{ html, text }],
    footer: [
      `This link is just for you and works for ${REVIEW_LINK_DAYS} days. Don’t forward it: anyone with it can respond.`,
    ],
    design,
  });
}
