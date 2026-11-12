import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@alhc/core/api/auth/queries";
import { listProjectTaskGroupNext } from "@alhc/core/api/tasks/queries";
import { isUuid } from "@alhc/core/ids";
import { decodeConfig, groupOf, ROW_PAGE, sortOf } from "@alhc/core/views";
import { routeContext } from "@/lib/server/context";
import { getViewerTimeZone } from "@/lib/timezone";

// Nov 12 notes (batch 40, item 4): List and Board's "Show more" — the next page of one group, with the
// signed-in person's own client (RLS decides exactly as for the page), instead of re-rendering the whole
// view with a bigger page. A GET route rather than a Server Action, so it never waits behind a save.
//   GET /api/projects/<id>/task-page?c=<the page's config>&key=<group>&after=<cards shown>
//     { group: { key, total, nextId, nextSortOrder, tasks } | null }
export async function GET(request: NextRequest, { params }: RouteContext<"/api/projects/[projectId]/task-page">) {
  const { projectId } = await params;
  const ctx = await routeContext();
  const { user, allowlisted } = await getViewer(ctx);
  if (!user) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  if (!allowlisted) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const search = request.nextUrl.searchParams;
  const key = search.get("key") ?? "";
  const after = Number(search.get("after"));
  if (!isUuid(projectId) || !key || key.length > 200 || !Number.isInteger(after) || after < 0 || after > 20_000) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const config = decodeConfig(search.get("c") ?? "{}") ?? {};
  const group = await listProjectTaskGroupNext(
    ctx,
    projectId,
    config.filters ?? {},
    await getViewerTimeZone(),
    groupOf(config),
    sortOf(config),
    key,
    after,
    ROW_PAGE,
  );
  return NextResponse.json({ group }, { headers: { "Cache-Control": "private, no-store" } });
}
