import { NextResponse } from "next/server";
import { listAttachmentFiles } from "@/lib/api/attachments/queries";
import { getViewer } from "@/lib/api/auth/queries";
import { isUuid } from "@/lib/ids";
import { MAX_REVIEW_ASSETS } from "@/lib/review-checks";
import { reviewThumbnails } from "@/lib/review-thumbnails";
import { routeContext } from "@/lib/server/context";

// Nov 4 notes (batch 21, QW3): the one server function that draws review email thumbnails, so pdf.js and
// @napi-rs/canvas (Skia) ship with it alone (next.config.ts) instead of with every page. The review
// Server Actions call it (review-thumbnail-request.ts) with the sender's own session cookies; it reads and
// stores the files with that person's own Supabase client (RLS and Storage policies decide, as before:
// Viewers+ read a task's files, Editors+ store its thumbnails), never the service role.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  // Only this app's own server calls it; a browser sending an Origin must be on this host.
  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    try {
      if (new URL(origin).host !== host) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
    } catch {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
    }
  }
  const ctx = await routeContext();
  const { user, allowlisted } = await getViewer(ctx);
  if (!user || !allowlisted) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
  }
  const { taskId, expiresAt, assets } = (body ?? {}) as Record<string, unknown>;
  const expires = typeof expiresAt === "string" ? new Date(expiresAt) : null;
  if (typeof taskId !== "string" || !isUuid(taskId) || !expires || Number.isNaN(expires.getTime()) || !Array.isArray(assets)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
  }
  const wanted = assets
    .flatMap((a) => {
      const { assetId, attachmentId } = (a ?? {}) as Record<string, unknown>;
      return typeof assetId === "string" && isUuid(assetId) && typeof attachmentId === "string" && isUuid(attachmentId)
        ? [{ assetId, attachmentId }]
        : [];
    })
    .slice(0, MAX_REVIEW_ASSETS);
  if (wanted.length === 0) return NextResponse.json({ thumbnails: {} }, { headers: NO_STORE });

  // The files, read through RLS with the sender's own client (unreadable ones simply aren't drawn).
  const data = await listAttachmentFiles(ctx, wanted.map((a) => a.attachmentId));
  const byId = new Map(data.map((a) => [a.id, a] as const));
  const thumbnails = await reviewThumbnails(
    ctx,
    taskId,
    wanted.flatMap(({ assetId, attachmentId }) => {
      const a = byId.get(attachmentId);
      return a
        ? [{ assetId, attachmentId, name: a.file_name, contentType: a.content_type, storagePath: a.storage_path, size: a.size_bytes }]
        : [];
    }),
    expires,
  ).catch(() => new Map());
  return NextResponse.json({ thumbnails: Object.fromEntries(thumbnails) }, { headers: NO_STORE });
}
