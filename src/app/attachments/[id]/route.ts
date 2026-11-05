import { NextResponse, type NextRequest } from "next/server";
import { getAttachmentFile, signedFileUrl } from "@/lib/api/attachments/queries";
import { getViewer } from "@/lib/api/auth/queries";
import { routeContext } from "@/lib/server/context";

const SIGNED_URL_TTL_SECONDS = 60;
const MEDIA_URL_TTL_SECONDS = 3600;

// GET /attachments/<id>            inline for previewable files (PNG, JPEG, GIF, WebP, PDF), else a download
// GET /attachments/<id>?preview=1  same rule; what thumbnails, the lightbox, and the PDF "Open" link use
// GET /attachments/<id>?download   always a download
// GET /attachments/<id>?media=1    the same, plus videos (MP4, WebM, MOV) in the browser's player, with an
//                                  hour-long link so a video keeps playing (Oct 26 notes, batch 3: Reviews)
// The metadata row is read with the viewer's client (RLS: Viewer+ on the task), then the browser is
// redirected to a 60-second signed URL of the private bucket. The redirect itself is never cached, so
// every <img> load gets a fresh URL. Inline only when the file name, the recorded type, the storage path,
// and the type Storage will actually serve all agree (signedFileUrl).
export async function GET(request: NextRequest, ctx: RouteContext<"/attachments/[id]">) {
  const { id } = await ctx.params;
  const api = await routeContext();
  const { user, allowlisted } = await getViewer(api);
  if (!user) return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  if (!allowlisted) return new NextResponse("Forbidden", { status: 403 });

  const attachment = await getAttachmentFile(api, id);
  if (!attachment) return new NextResponse("Not found", { status: 404 });

  const wantsDownload = request.nextUrl.searchParams.has("download");
  const media = request.nextUrl.searchParams.get("media") === "1";
  const signedUrl = await signedFileUrl(api, attachment, {
    download: wantsDownload,
    media,
    seconds: media ? MEDIA_URL_TTL_SECONDS : SIGNED_URL_TTL_SECONDS,
  });
  if (!signedUrl) return noStore(new NextResponse("Attachment unavailable", { status: 502 }));

  return noStore(NextResponse.redirect(signedUrl));
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
