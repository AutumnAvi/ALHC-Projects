import { NextResponse, type NextRequest } from "next/server";
import { signedFileUrl } from "@alhc/core/api/attachments/queries";
import { getViewer } from "@alhc/core/api/auth/queries";
import { getReturnedReviewFile } from "@alhc/core/api/reviews/queries";
import { isUuid } from "@alhc/core/ids";
import { routeContext } from "@/lib/server/context";

// Oct 26 notes (batch 3): a file a reviewer sent back, for the task's Reviews tab. The row is read with the
// viewer's own client (RLS: Viewer+ on the task, finished uploads only), then a signed link to the
// private bucket (Storage's own policy checks the task too). Images, PDFs, and videos play in the browser
// when name and stored type agree; anything else downloads. An hour, so a video keeps playing.
const TTL_SECONDS = 3600;

export async function GET(request: NextRequest, ctx: RouteContext<"/review-files/[id]">) {
  const { id } = await ctx.params;
  const api = await routeContext();
  const { user, allowlisted } = await getViewer(api);
  if (!user) return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  if (!allowlisted) return new NextResponse("Forbidden", { status: 403 });
  if (!isUuid(id)) return new NextResponse("Not found", { status: 404 });
  const file = await getReturnedReviewFile(api, id);
  if (!file) return new NextResponse("Not found", { status: 404 });
  const signedUrl = await signedFileUrl(
    api,
    { storagePath: file.storage_path, fileName: file.file_name, contentType: file.content_type },
    { download: request.nextUrl.searchParams.has("download"), media: true, seconds: TTL_SECONDS },
  );
  if (!signedUrl) return noStore(new NextResponse("File unavailable", { status: 502 }));
  return noStore(NextResponse.redirect(signedUrl));
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
