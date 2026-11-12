import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@alhc/core/api/auth/queries";
import { quickSearchPeople, quickSearchTasks } from "@alhc/core/api/shell/queries";
import { isSearchKind } from "@alhc/core/shell";
import { routeContext } from "@/lib/server/context";

// Nov 12 speed batch 39 (item 5): the search palette's server half. A GET route rather than the old
// quickSearch Server Action: actions run one at a time per tab, so typing right after a save waited
// behind the save. Read with the person's own client (RLS decides; never the service role).
//   GET /api/quick-search?q=<text>&kind=<tasks|projects|people>   { tasks: QuickTask[] } (with their numbers)
//   GET /api/quick-search?people=1                                { people: QuickPerson[] } (once per palette)
// Projects and people are matched in the browser (quick-match.ts): projects from the app shell's readable
// projects, people from the people list this returns.
export async function GET(request: NextRequest) {
  const ctx = await routeContext();
  const { user, allowlisted } = await getViewer(ctx);
  if (!user) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  if (!allowlisted) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const headers = { "Cache-Control": "private, no-store" };
  const params = request.nextUrl.searchParams;
  if (params.get("people") === "1") return NextResponse.json({ people: await quickSearchPeople(ctx) }, { headers });
  const kind = params.get("kind");
  const tasks = await quickSearchTasks(ctx, params.get("q") ?? "", isSearchKind(kind) ? kind : null);
  return NextResponse.json({ tasks }, { headers });
}
