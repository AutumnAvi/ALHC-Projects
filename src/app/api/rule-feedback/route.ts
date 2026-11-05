import { NextResponse, type NextRequest } from "next/server";
import { listMyRecentRuleRuns } from "@/lib/api/automations/queries";
import { getViewer } from "@/lib/api/auth/queries";
import { FEEDBACK_OVERLAP_SECONDS, type FeedbackResponse } from "@/lib/rule-feedback";
import { routeContext } from "@/lib/server/context";

// Nov 1 notes, batch 10 (77): the signed-in person's own automation runs since a cursor, for the live
// feedback toasts. Read with their own client (never the service role), so RLS decides. A GET route, not
// a Server Action: actions run one at a time per tab and this follows every write.
//   GET /api/rule-feedback?since=<ISO cursor>   runs from FEEDBACK_OVERLAP_SECONDS before the cursor
//   GET /api/rule-feedback?within=<seconds>     runs from the last N seconds (the first check; ≤ 600)
export async function GET(request: NextRequest) {
  const ctx = await routeContext();
  const { user, allowlisted } = await getViewer(ctx);
  const headers = { "Cache-Control": "private, no-store" };
  if (!user || !allowlisted) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  const now = new Date();
  const params = request.nextUrl.searchParams;
  const since = Date.parse(params.get("since") ?? "");
  const within = Number(params.get("within"));
  let from: Date;
  if (Number.isFinite(since)) {
    // Never further back than ten minutes, and never in the future.
    from = new Date(Math.max(now.getTime() - 600_000, Math.min(since, now.getTime()) - FEEDBACK_OVERLAP_SECONDS * 1000));
  } else if (Number.isFinite(within) && within > 0) {
    from = new Date(now.getTime() - Math.min(600, within) * 1000);
  } else {
    return NextResponse.json({ error: "Pass since or within" }, { status: 400, headers });
  }
  const body: FeedbackResponse = { cursor: now.toISOString(), runs: await listMyRecentRuleRuns(ctx, from) };
  return NextResponse.json(body, { headers });
}
