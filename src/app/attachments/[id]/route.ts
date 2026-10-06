import { NextResponse, type NextRequest } from "next/server";
import { previewKind } from "@/lib/attachment-preview";
import { getViewer } from "@/lib/auth";
import { ATTACHMENTS_BUCKET } from "@/lib/attachments";
import { createClient } from "@/lib/supabase/server";

const SIGNED_URL_TTL_SECONDS = 60;

// GET /attachments/<id>            inline for previewable files (PNG, JPEG, GIF, WebP, PDF), else a download
// GET /attachments/<id>?preview=1  same rule; what thumbnails, the lightbox, and the PDF "Open" link use
// GET /attachments/<id>?download   always a download
// The metadata row is read with the viewer's client (RLS: Viewer+ on the task), then the browser is
// redirected to a 60-second signed URL of the private bucket. The redirect itself is never cached, so
// every <img> load gets a fresh URL.
export async function GET(request: NextRequest, ctx: RouteContext<"/attachments/[id]">) {
  const { id } = await ctx.params;
  const { user, allowlisted } = await getViewer();
  if (!user) return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  if (!allowlisted) return new NextResponse("Forbidden", { status: 403 });

  const supabase = await createClient();
  const { data: attachment, error } = await supabase
    .from("task_attachments")
    .select("storage_path, file_name, content_type")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !attachment) return new NextResponse("Not found", { status: 404 });

  const bucket = supabase.storage.from(ATTACHMENTS_BUCKET);
  const wantsDownload = request.nextUrl.searchParams.has("download");
  const inline = !wantsDownload && (await servableInline(attachment, bucket));

  const { data: signed, error: signError } = await bucket.createSignedUrl(
    attachment.storage_path,
    SIGNED_URL_TTL_SECONDS,
    { download: inline ? undefined : attachment.file_name },
  );
  if (signError || !signed) return noStore(new NextResponse("Attachment unavailable", { status: 502 }));

  return noStore(NextResponse.redirect(signed.signedUrl));
}

// Inline only when the file name, the recorded content type, the storage path, and the content type
// Storage will actually serve all agree on a previewable kind. The name and recorded type come from
// the uploader's browser, so the stored object's own type is checked too; any doubt means download.
async function servableInline(
  attachment: { storage_path: string; file_name: string; content_type: string | null },
  bucket: ReturnType<Awaited<ReturnType<typeof createClient>>["storage"]["from"]>,
): Promise<boolean> {
  const kind = previewKind(attachment.file_name, attachment.content_type);
  if (!kind || previewKind(attachment.storage_path, attachment.content_type) !== kind) return false;
  const { data: info, error } = await bucket.info(attachment.storage_path);
  const storedType = info?.contentType;
  if (error || !storedType) return false;
  return previewKind(attachment.storage_path, storedType) === kind;
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
