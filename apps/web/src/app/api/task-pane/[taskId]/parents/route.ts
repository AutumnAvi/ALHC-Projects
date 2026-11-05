import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@alhc/core/api/auth/queries";
import { listSubtaskParents } from "@alhc/core/api/tasks/queries";
import { isUuid } from "@alhc/core/ids";
import { routeContext } from "@/lib/server/context";

// Nov 2 notes (batch 16, 124): "Make a subtask of…"'s picker. A GET route rather than a Server Action:
// actions run one at a time per tab, so each keystroke's search queued behind the last one (and behind any
// write's refresh) and the list seemed never to load. Read with the person's own client (RLS decides);
// the browser aborts a search that a newer one replaced.
//   GET /api/task-pane/<id>/parents?q=<text>   { data: ParentCandidate[] } | { error }
export async function GET(request: NextRequest, { params }: RouteContext<"/api/task-pane/[taskId]/parents">) {
  const { taskId } = await params;
  const ctx = await routeContext();
  const { user, allowlisted } = await getViewer(ctx);
  if (!user) return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  if (!allowlisted) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!isUuid(taskId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const headers = { "Cache-Control": "private, no-store" };
  const started = performance.now();
  const result = await listSubtaskParents(ctx, taskId, request.nextUrl.searchParams.get("q") ?? "");
  if (result.error) {
    console.error("[parent picker] couldn't search", result.error.slice(0, 80));
    return NextResponse.json({ error: "Couldn’t load tasks. Try again." }, { status: 500, headers });
  }
  return NextResponse.json(
    { data: result.data ?? [] },
    { headers: { ...headers, "Server-Timing": `parents;dur=${Math.round(performance.now() - started)}` } },
  );
}
