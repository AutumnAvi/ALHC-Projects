import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/api/auth/queries";
import { LINK_SEARCH_MAX_PROJECTS, LINK_SEARCH_MAX_TASKS } from "@/lib/api/shell/model";
import { linkSuggestions, quickSearch } from "@/lib/api/shell/queries";
import { routeContext } from "@/lib/server/context";
import { parseRecentRefs } from "@/lib/shell";

// Nov 3 notes (batch 18, 133): the "#" link picker in comments and descriptions. A GET route rather
// than a Server Action (actions run one at a time per tab, so each keystroke's search queued behind the
// last one). Tasks by name, notes, or number (search_tasks) and projects by name, read with the person's
// own client — the search palette's own search, so RLS decides and nothing they can't open comes back.
//   GET /api/link-search?q=<text>   { tasks: QuickTask[], projects: QuickProject[] }
// Nov 4 notes (batch 25, 158): "#" alone (no q) suggests before anything is typed, like "@" does for
// people: the tasks and projects this browser opened recently (`recent=task:<id>,project:<id>`, ids only,
// resolved through RLS like the palette's recents), then the person's open tasks they were assigned most
// recently and their starred, then other active, projects (linkSuggestions in src/lib/api/shell/queries.ts).
export async function GET(request: NextRequest) {
  const ctx = await routeContext();
  const { user, allowlisted } = await getViewer(ctx);
  if (!user) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  if (!allowlisted) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 200);
  const headers = { "Cache-Control": "private, no-store" };
  if (!q) {
    const recent = parseRecentRefs(request.nextUrl.searchParams.get("recent"));
    return NextResponse.json(await linkSuggestions(ctx, user.id, recent), { headers });
  }
  const [tasks, projects] = await Promise.all([quickSearch(ctx, q, "tasks"), quickSearch(ctx, q, "projects")]);
  return NextResponse.json(
    { tasks: tasks.tasks.slice(0, LINK_SEARCH_MAX_TASKS), projects: projects.projects.slice(0, LINK_SEARCH_MAX_PROJECTS) },
    { headers },
  );
}
