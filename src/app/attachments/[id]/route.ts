import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { ATTACHMENTS_BUCKET } from "@/lib/attachments";
import { createClient } from "@/lib/supabase/server";

const SIGNED_URL_TTL_SECONDS = 60;

export async function GET(request: NextRequest, ctx: RouteContext<"/attachments/[id]">) {
  const { id } = await ctx.params;
  const { user, allowlisted } = await getViewer();
  if (!user) return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  if (!allowlisted) return new NextResponse("Forbidden", { status: 403 });

  const supabase = await createClient();
  const { data: attachment, error } = await supabase
    .from("task_attachments")
    .select("storage_path, file_name")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !attachment) return new NextResponse("Not found", { status: 404 });

  const download = request.nextUrl.searchParams.has("download") ? attachment.file_name : undefined;
  const { data: signed, error: signError } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .createSignedUrl(attachment.storage_path, SIGNED_URL_TTL_SECONDS, { download });
  if (signError || !signed) return new NextResponse("Attachment unavailable", { status: 502 });

  return NextResponse.redirect(signed.signedUrl);
}
