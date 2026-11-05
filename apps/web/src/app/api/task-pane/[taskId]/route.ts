import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@alhc/core/api/auth/queries";
import { getTaskExtras, loadTaskPanePayload } from "@alhc/core/api/task-pane/queries";
import { isUuid } from "@alhc/core/ids";
import { routeContext } from "@/lib/server/context";

// The task pane's data for the client cache (Oct 19 notes: opening a task must feel instant). Read with
// the signed-in person's own Supabase client (cookies; never the service role), so RLS decides exactly as
// for the page: an unreadable task is the same 404 as a missing one. A GET route rather than a Server
// Action: actions run one at a time per tab, so hover prefetches would queue behind (or ahead of) writes.
//   GET /api/task-pane/<id>              { task, context: null, loadedAt }
//   GET /api/task-pane/<id>?context=1    plus the pane's context (viewer, projects, people, tags)
//   GET /api/task-pane/<id>?part=schedule|candidates  { dependencyCandidates, schedule }: the slack, or the
//                                        Dependencies picker's / Convert's tasks (loaded when needed)
export async function GET(request: NextRequest, { params }: RouteContext<"/api/task-pane/[taskId]">) {
  const { taskId } = await params;
  const ctx = await routeContext();
  const { user, allowlisted } = await getViewer(ctx);
  if (!user) return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  if (!allowlisted) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!isUuid(taskId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const headers = { "Cache-Control": "private, no-store" };

  const started = performance.now();
  const part = request.nextUrl.searchParams.get("part");
  if (part === "schedule" || part === "candidates") {
    const extras = await getTaskExtras(ctx, taskId, part);
    if (!extras) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
    return NextResponse.json(extras, {
      headers: { ...headers, "Server-Timing": `extras;dur=${Math.round(performance.now() - started)}` },
    });
  }

  const payload = await loadTaskPanePayload(ctx, taskId, request.nextUrl.searchParams.get("context") === "1");
  if (!payload.task) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  return NextResponse.json(payload, {
    headers: { ...headers, "Server-Timing": `pane;dur=${Math.round(performance.now() - started)}` },
  });
}
