import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { quickSearch } from "@/lib/shell-actions";

const MAX_TASKS = 6;
const MAX_PROJECTS = 4;

// Nov 3 notes (batch 18, 133): the "#" link picker in comments and descriptions. A GET route rather
// than a Server Action (actions run one at a time per tab, so each keystroke's search queued behind the
// last one). Tasks by name, notes, or number (search_tasks) and projects by name, read with the person's
// own client — the search palette's own search, so RLS decides and nothing they can't open comes back.
//   GET /api/link-search?q=<text>   { tasks: QuickTask[], projects: QuickProject[] }
export async function GET(request: NextRequest) {
  const { user, allowlisted } = await getViewer();
  if (!user) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  if (!allowlisted) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 200);
  const headers = { "Cache-Control": "private, no-store" };
  if (!q) return NextResponse.json({ tasks: [], projects: [] }, { headers });
  const [tasks, projects] = await Promise.all([quickSearch(q, "tasks"), quickSearch(q, "projects")]);
  return NextResponse.json(
    { tasks: tasks.tasks.slice(0, MAX_TASKS), projects: projects.projects.slice(0, MAX_PROJECTS) },
    { headers },
  );
}
