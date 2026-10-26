import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { ATTACHMENTS_BUCKET } from "@/lib/attachments";
import { isUuid } from "@/lib/ids";
import { reviewMediaKind } from "@/lib/review-checks";
import { createClient } from "@/lib/supabase/server";

// Oct 26 notes (batch 3): a file a reviewer sent back, for the task's Reviews tab. The row is read with the
// viewer's own client (RLS: Viewer+ on the task, finished uploads only), then a signed link to the
// private bucket (Storage's own policy checks the task too). Images, PDFs, and videos play in the browser
// when name and stored type agree; anything else downloads. An hour, so a video keeps playing.
const TTL_SECONDS = 3600;

export async function GET(request: NextRequest, ctx: RouteContext<"/review-files/[id]">) {
  const { id } = await ctx.params;
  const { user, allowlisted } = await getViewer();
  if (!user) return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  if (!allowlisted) return new NextResponse("Forbidden", { status: 403 });
  if (!isUuid(id)) return new NextResponse("Not found", { status: 404 });
  const supabase = await createClient();
  const { data: file } = await supabase
    .from("review_check_files")
    .select("storage_path, file_name, content_type")
    .eq("id", id)
    .maybeSingle();
  if (!file) return new NextResponse("Not found", { status: 404 });
  const bucket = supabase.storage.from(ATTACHMENTS_BUCKET);
  let inline = false;
  if (!request.nextUrl.searchParams.has("download")) {
    const kind = reviewMediaKind(file.file_name, file.content_type);
    if (kind && reviewMediaKind(file.storage_path, file.content_type) === kind) {
      const { data: info } = await bucket.info(file.storage_path);
      inline = Boolean(info?.contentType) && reviewMediaKind(file.storage_path, info!.contentType) === kind;
    }
  }
  const { data: signed, error } = await bucket.createSignedUrl(file.storage_path, TTL_SECONDS, {
    download: inline ? undefined : file.file_name,
  });
  if (error || !signed) return noStore(new NextResponse("File unavailable", { status: 502 }));
  return noStore(NextResponse.redirect(signed.signedUrl));
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
