// Big move 1: the reports area's writes (personal dashboards and their widgets). Every function takes the
// caller's ApiContext first, validates its own input, writes only through ctx.db (RLS keeps dashboards to
// their owner), and throws ApiError on any refusal; no Next.js here.
import { ORDER_STEP } from "../core/constants";
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { invalid } from "../core/errors";
import { id, text } from "../core/validate";
import type { PersonalWidgetInput } from "./model";
import { starterDashboardWidgets } from "../../personal-dashboards";
import { DEFAULT_WIDGET_TITLES, isPersonalWidgetKind, isSeriesInterval, reportFiltersJson } from "../../reports";
import type { Json } from "../../supabase/database.types";

// ---------------------------------------------------------------------------------------------
// Personal dashboards
// ---------------------------------------------------------------------------------------------

// A new dashboard with the starter widgets. Answers the new dashboard's id.
export async function createPersonalDashboard(ctx: ApiContext, input: { name: unknown }): Promise<string> {
  const name = text(input.name, "Dashboard name", { max: 100 });
  const supabase = ctx.db;
  const { data: last } = await supabase
    .from("personal_dashboards")
    .select("sort_order")
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const inserted = await supabase
    .from("personal_dashboards")
    .insert({ name, sort_order: (last?.sort_order ?? 0) + ORDER_STEP })
    .select("id")
    .single();
  check(inserted);
  const dashboardId = inserted.data!.id;
  check(
    await supabase.from("personal_dashboard_widgets").insert(starterDashboardWidgets(dashboardId)),
  );
  return dashboardId;
}

export async function renamePersonalDashboard(ctx: ApiContext, dashboardId: string, name: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("personal_dashboards")
      .update({ name: text(name, "Dashboard name", { max: 100 }) })
      .eq("id", id(dashboardId))
      .select("id"),
    "This dashboard no longer exists",
  );
}

export async function deletePersonalDashboard(ctx: ApiContext, dashboardId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("personal_dashboards").update({ deleted_at: nowIso() }).eq("id", id(dashboardId)).select("id"),
    "This dashboard no longer exists",
  );
}

function personalWidgetFields(input: Partial<PersonalWidgetInput>) {
  const fields: { kind?: string; title?: string; filters?: Json; series_interval?: string } = {};
  if (input.kind !== undefined) {
    if (!isPersonalWidgetKind(input.kind)) throw invalid("Unknown widget type");
    fields.kind = input.kind;
  }
  if (input.title !== undefined) fields.title = text(input.title, "Widget title", { max: 100 });
  if (input.filters !== undefined) fields.filters = reportFiltersJson(input.filters);
  if (input.interval !== undefined) {
    if (!isSeriesInterval(input.interval)) throw invalid("Choose days or weeks");
    fields.series_interval = input.interval;
  }
  return fields;
}

export async function createPersonalWidget(ctx: ApiContext, dashboardId: string, input: PersonalWidgetInput): Promise<void> {
  if (!isPersonalWidgetKind(input.kind)) throw invalid("Unknown widget type");
  const fields = personalWidgetFields({ title: DEFAULT_WIDGET_TITLES[input.kind], ...input });
  const supabase = ctx.db;
  const { data: last } = await supabase
    .from("personal_dashboard_widgets")
    .select("sort_order")
    .eq("dashboard_id", id(dashboardId))
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  check(
    await supabase.from("personal_dashboard_widgets").insert({
      dashboard_id: dashboardId,
      kind: input.kind,
      title: fields.title!,
      filters: fields.filters ?? {},
      series_interval: fields.series_interval ?? "week",
      sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
    }),
    "This dashboard no longer exists",
  );
}

export async function updatePersonalWidget(
  ctx: ApiContext,
  widgetId: string,
  patch: Partial<PersonalWidgetInput>,
): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("personal_dashboard_widgets")
      .update(personalWidgetFields(patch))
      .eq("id", id(widgetId))
      .select("id"),
    "This widget no longer exists",
  );
}

export async function deletePersonalWidget(ctx: ApiContext, widgetId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("personal_dashboard_widgets").update({ deleted_at: nowIso() }).eq("id", id(widgetId)).select("id"),
    "This widget no longer exists",
  );
}

export async function movePersonalWidget(ctx: ApiContext, widgetId: string, direction: -1 | 1): Promise<void> {
  const supabase = ctx.db;
  const { data: row } = await supabase
    .from("personal_dashboard_widgets")
    .select("dashboard_id")
    .eq("id", id(widgetId))
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) throw invalid("This widget no longer exists");
  const { data: siblings } = await supabase
    .from("personal_dashboard_widgets")
    .select("id, sort_order")
    .eq("dashboard_id", row.dashboard_id)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  const list = siblings ?? [];
  const index = list.findIndex((w) => w.id === widgetId);
  const target = index + (direction < 0 ? -1 : 1);
  if (index === -1 || target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  for (const [i, item] of list.entries()) {
    const order = (i + 1) * ORDER_STEP;
    if (item.sort_order !== order) {
      check(await supabase.from("personal_dashboard_widgets").update({ sort_order: order }).eq("id", item.id));
    }
  }
}
