import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { csvStreamResponse } from "@/lib/csv";
import {
  exportList,
  exportPortfolioReport,
  exportProjectDashboard,
  exportSearch,
  exportWorkspaceReport,
  type ExportResult,
} from "@/lib/exports";
import { isUuid } from "@/lib/ids";
import { filtersFromParams, withoutReportTags } from "@/lib/reports";
import { tagsEnabled } from "@/lib/data";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@/lib/workload";

// CSV export. Every kind reads with the signed-in user's Supabase client (cookies), never the service
// role, so only rows RLS lets them read are exported. No row cap since Real features 4: the file streams
// a page at a time (src/lib/exports.ts); UTF-8 with a BOM; cells that look like formulas are prefixed
// with an apostrophe (src/lib/csv.ts).
//   /export/list?project=<id>&view=<id>&f=<draft>     List: current filters, order, and columns
//   /export/search?q=<query>                          search results
//   /export/dashboard?project=<id>                    project dashboard widgets
//   /export/report?table=breakdown|series|overdue|projects&<report filters>&int=day|week
//   /export/portfolio?portfolio=<id>                  portfolio report
// A big List export reads and writes for a while; the stream keeps the download going meanwhile.
export const maxDuration = 300;

export async function GET(request: NextRequest, ctx: RouteContext<"/export/[kind]">) {
  const { kind } = await ctx.params;
  const { user, allowlisted } = await getViewer();
  if (!user) return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  if (!allowlisted) return new NextResponse("Forbidden", { status: 403 });

  const params = request.nextUrl.searchParams;
  const timeZone = await getViewerTimeZone();
  const projectId = params.get("project");
  let result: ExportResult = null;

  switch (kind) {
    case "list": {
      const viewId = params.get("view");
      if (!isUuid(projectId) || (viewId !== null && !isUuid(viewId))) break;
      result = await exportList(projectId, viewId, params.get("f"), timeZone);
      break;
    }
    case "search":
      result = await exportSearch(params.get("q") ?? "");
      break;
    case "dashboard":
      if (isUuid(projectId)) result = await exportProjectDashboard(projectId, timeZone);
      break;
    case "report":
      result = await exportWorkspaceReport(params.get("table") ?? "breakdown", withoutReportTags(filtersFromParams(params), await tagsEnabled()), params.get("int") ?? "week", timeZone);
      break;
    case "portfolio": {
      const portfolioId = params.get("portfolio");
      if (isUuid(portfolioId)) result = await exportPortfolioReport(portfolioId, timeZone);
      break;
    }
  }

  if (!result) return new NextResponse("Not found", { status: 404 });
  return csvStreamResponse(result, todayIn(timeZone));
}
