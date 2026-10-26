import "server-only";
import { applyDesign, defaultAppliedDesign, designFromJson, type AppliedDesign } from "@/lib/email-design";
import { emailLogoUrl } from "@/lib/email";
import { escapeHtml, layout, type Rendered } from "@/lib/email-layout";
import { REVIEW_LINK_DAYS, reviewMediaKind } from "@/lib/review-checks";

// Oct 26 notes (batch 3): the review check email. The project's (or the request form's) requester design —
// logo, accent, header, sign-off — then the sender's message, a thumbnail of the first image, and exactly
// two buttons: Approve and Leave feedback (both open the review page; nothing is decided by the click
// alone, so link scanners can't approve anything). The link's token is in the URLs only.

export type ReviewEmailInput = {
  origin: string;
  token: string;
  round: number;
  recipientName: string | null;
  senderName: string;
  taskTitle: string;
  projectName: string | null;
  message: string | null;
  assets: { assetId: string; name: string; contentType: string | null }[];
  // resolve_email_design("requester", project, form) as the database returned it (null: the default look).
  design: unknown;
};

export function reviewUrls(origin: string, token: string) {
  const page = `${origin}/review/${token}`;
  return { page, approve: `${page}?action=approve`, feedback: `${page}?action=feedback` };
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
  const intro = `${input.senderName} would like your review of ${input.assets.length === 1 ? "a file" : `${input.assets.length} files`}${
    input.round > 1 ? ` (version ${input.round})` : ""
  }. Open it to see everything in full quality, pin comments right on the files, and approve or leave feedback.`;
  const paragraphs = [greeting, input.message?.trim() || "", intro].filter(Boolean);

  const thumbnail = input.assets.find((a) => reviewMediaKind(a.name, a.contentType) === "image");
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const fileList = input.assets.map((a) => escapeHtml(a.name)).join(" · ");
  const preview = thumbnail
    ? `<a href="${escapeHtml(urls.page)}" target="_blank" style="display:block;margin:4px 0 8px 0"><img src="${escapeHtml(
        `${urls.page}/file/${thumbnail.assetId}`,
      )}" alt="${escapeHtml(thumbnail.name)}" width="504" style="display:block;width:100%;max-width:504px;height:auto;border:1px solid #e4e4e7;border-radius:8px"></a>`
    : "";
  const buttons = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0 0"><tr><td bgcolor="${escapeHtml(
    design.buttonColor,
  )}" style="border-radius:8px;background:${escapeHtml(design.buttonColor)}"><a href="${escapeHtml(
    urls.approve,
  )}" target="_blank" style="display:inline-block;padding:10px 18px;font-size:14px;font-weight:600;line-height:20px;color:${
    design.buttonTextColor
  };text-decoration:none;border-radius:8px;${font}">Approve</a></td><td width="10" style="width:10px">&nbsp;</td><td style="border-radius:8px;border:1px solid #d4d4d8;background:#ffffff"><a href="${escapeHtml(
    urls.feedback,
  )}" target="_blank" style="display:inline-block;padding:9px 17px;font-size:14px;font-weight:600;line-height:20px;color:#18181b;text-decoration:none;border-radius:8px;${font}">Leave feedback</a></td></tr></table>`;
  const html = `${preview}<p style="margin:0;font-size:13px;line-height:1.5;color:#52525b;${font}">${fileList}</p>${buttons}`;
  const text = [`Files: ${input.assets.map((a) => a.name).join(", ")}`, `Approve: ${urls.approve}`, `Leave feedback: ${urls.feedback}`].join(
    "\n",
  );

  return layout(heading, paragraphs, input.projectName ? [{ label: "Project", value: input.projectName }] : [], {
    subject: `Review requested: ${input.taskTitle}${input.round > 1 ? ` (v${input.round})` : ""}`,
    alwaysBody: true,
    blocks: [{ html, text }],
    footer: [
      `This link is just for you and works for ${REVIEW_LINK_DAYS} days. Don’t forward it: anyone with it can respond.`,
    ],
    design,
  });
}
