// Big move 1: the views area's writes (saved views, the person's List settings, a project's tab settings,
// dashboard widgets). Every function takes the caller's ApiContext first, validates its own input, writes
// only through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no Next.js here.
import { getSignedInUser } from "@/lib/api/auth/queries";
import { ORDER_STEP } from "@/lib/api/core/constants";
import type { ApiContext } from "@/lib/api/core/context";
import { check, checkUpdated, nowIso } from "@/lib/api/core/db";
import { NOT_ALLOWED, invalid } from "@/lib/api/core/errors";
import { id, text } from "@/lib/api/core/validate";
import { getProjectRole } from "@/lib/api/projects/queries";
import { parseColumnWidths, type ColumnWidths } from "@/lib/column-widths";
import type { Json } from "@/lib/supabase/database.types";
import {
  VIEW_LAYOUTS,
  isFixedTab,
  isViewLayout,
  isWidgetKind,
  parseFilters,
  parseViewConfig,
  personalCopyName,
  toJson,
  type ViewConfig,
  type ViewFilters,
  type WidgetKind,
} from "@/lib/views";

// ---------------------------------------------------------------------------------------------
// The person's List settings
// ---------------------------------------------------------------------------------------------

// List column widths for the signed-in person in one project (set_list_column_widths, own row, Viewer+).
// No refresh: the List already shows the widths it sent.
export async function saveListColumnWidths(ctx: ApiContext, projectId: string, widths: ColumnWidths): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("set_list_column_widths", {
      target_project: id(projectId),
      new_widths: parseColumnWidths(widths) as Json,
    }),
  );
}

// Oct 26 notes (batch 4): the List groups the person collapsed in a project, saved quietly (no refresh) so
// they stay collapsed across visits and reloads.
export async function saveListCollapsedGroups(ctx: ApiContext, projectId: string, keys: string[]): Promise<void> {
  const cleaned = [...new Set(keys.filter((k) => typeof k === "string" && k.length > 0 && k.length <= 120))].slice(0, 500);
  const supabase = ctx.db;
  const result = await supabase.rpc("set_list_collapsed_groups", { target_project: id(projectId), keys: cleaned });
  // A database without this release: collapsing still works for the visit.
  if (result.error?.code === "PGRST202") return;
  check(result);
}

// Oct 27 notes (batch 5): the viewer's Show / Hide completed for a project's List and Board, remembered per
// person per project (set_project_show_completed, invoker, own row). The page refreshes with it applied.
// Answers whether it was remembered.
export async function setProjectShowCompleted(
  ctx: ApiContext,
  projectId: string,
  show: boolean,
): Promise<{ remembered: boolean }> {
  const supabase = ctx.db;
  const saved = await supabase.rpc("set_project_show_completed", { target_project: id(projectId), show: Boolean(show) });
  // A database without this release: the toolbar applies it to this visit only.
  if (saved.error?.code === "PGRST202") return { remembered: false };
  check(saved);
  return { remembered: true };
}

// ---------------------------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------------------------

async function nextOrder(ctx: ApiContext, table: "project_views" | "dashboard_widgets", projectId: string) {
  const supabase = ctx.db;
  const { data } = await supabase
    .from(table)
    .select("sort_order")
    .eq("project_id", id(projectId))
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.sort_order ?? 0) + ORDER_STEP;
}

// A new view tab (shared, or the person's own). Answers the new view's id.
export async function createView(
  ctx: ApiContext,
  projectId: string,
  input: { name?: string; layout: string; config?: ViewConfig; personal?: boolean },
): Promise<string> {
  if (!isViewLayout(input.layout)) throw invalid("Unknown view layout");
  const fallback = VIEW_LAYOUTS.find((l) => l.value === input.layout)!.label;
  const supabase = ctx.db;
  // Oct 26 notes (batch 4): a personal view is only the creator's (RLS: Viewer+ of the project).
  const ownerId = input.personal ? ((await getSignedInUser(ctx))?.id ?? null) : null;
  if (input.personal && !ownerId) throw invalid("Sign in to save a view");
  const inserted = await supabase
    .from("project_views")
    .insert({
      project_id: id(projectId),
      name: text(input.name || fallback, "View name", { max: 100 }),
      layout: input.layout,
      config: toJson(parseViewConfig(input.config ?? {})),
      sort_order: await nextOrder(ctx, "project_views", projectId),
      ...(ownerId ? { owner_id: ownerId } : {}),
    })
    .select("id")
    .single();
  if (input.personal && inserted.error?.code === "PGRST204") {
    throw invalid("Saving your own views needs this release’s database update");
  }
  check(inserted, input.personal ? NOT_ALLOWED : "Only Editors and up add tabs to a project. Save it as your own view instead.");
  return inserted.data!.id;
}

const SHARED_VIEW_OWNERS_ONLY = "Only the project’s owners can change a shared view. Save it as your own view instead.";

export async function updateView(
  ctx: ApiContext,
  viewId: string,
  patch: { name?: string; config?: ViewConfig },
): Promise<void> {
  const update: { name?: string; config?: Json } = {};
  if (patch.name !== undefined) update.name = text(patch.name, "View name", { max: 100 });
  if (patch.config !== undefined) update.config = toJson(parseViewConfig(patch.config));
  const supabase = ctx.db;
  // Since Oct 26 notes (batch 4) only Owners change what a shared view shows (the database says so).
  checkUpdated(
    await supabase.from("project_views").update(update).eq("id", id(viewId)).select("id"),
    patch.config !== undefined ? SHARED_VIEW_OWNERS_ONLY : NOT_ALLOWED,
  );
}

// Saves a view's unsaved changes: into the view itself when it's yours or you own the project, else as
// your own copy of it (the shared view stays as everyone sees it), which then opens. (Kept for older
// callers; since Nov 2 notes, batch 14 the toolbar offers "Save for me" / "Save as default for everyone".)
// Answers { copied: true, viewId } when it made the copy.
export async function saveViewChanges(
  ctx: ApiContext,
  viewId: string,
  config: ViewConfig,
): Promise<{ copied?: boolean; viewId?: string }> {
  const supabase = ctx.db;
  const { data: view } = await supabase
    .from("project_views")
    .select("*")
    .eq("id", id(viewId))
    .is("deleted_at", null)
    .maybeSingle();
  if (!view) throw invalid("This view no longer exists");
  const role = await getProjectRole(ctx, view.project_id);
  if (view.owner_id || role === "owner") {
    await updateView(ctx, viewId, { config });
    return {};
  }
  const copyId = await createView(ctx, view.project_id, {
    name: personalCopyName(view.name),
    layout: view.layout,
    config,
    personal: true,
  });
  return { viewId: copyId, copied: true };
}

const PERSONAL_VIEW_MISSING = "Saving a view for yourself needs this release’s database update";

// Nov 2 notes (batch 14, 94): "Save for me" — the viewer's own version of a shared view (sort, filters,
// grouping, columns, section order): only they see it, and the view stays as everyone else sees it. Null
// clears it ("Reset to default"). A database without this release falls back to a personal copy.
export async function saveViewForMe(
  ctx: ApiContext,
  viewId: string,
  config: ViewConfig | null,
): Promise<{ copied?: boolean; viewId?: string }> {
  const supabase = ctx.db;
  const saved = await supabase.rpc("set_view_personal_config", {
    target_view: id(viewId),
    new_config: config === null ? null : toJson(parseViewConfig(config)),
  });
  if (saved.error?.code === "PGRST202") {
    if (config !== null) return saveViewChanges(ctx, viewId, config);
    throw invalid(PERSONAL_VIEW_MISSING);
  }
  check(saved);
  return {};
}

// "Save as default for everyone": the shared view itself (Owners only — the database says so) — and the
// Owner's own version is cleared so they see what everyone sees.
export async function saveViewForEveryone(ctx: ApiContext, viewId: string, config: ViewConfig): Promise<void> {
  await updateView(ctx, viewId, { config });
  const supabase = ctx.db;
  await supabase.rpc("set_view_personal_config", { target_view: id(viewId), new_config: null });
}

// A copy of a view next to it (yours when the view is yours). Answers where it is.
export async function duplicateView(ctx: ApiContext, viewId: string): Promise<{ projectId: string; viewId: string }> {
  const supabase = ctx.db;
  const { data: view } = await supabase
    .from("project_views")
    .select("*")
    .eq("id", id(viewId))
    .is("deleted_at", null)
    .maybeSingle();
  if (!view) throw invalid("This view no longer exists");
  const copyId = await createView(ctx, view.project_id, {
    name: `${view.name} copy`.slice(0, 100),
    layout: view.layout,
    config: parseViewConfig(view.config),
    personal: Boolean(view.owner_id),
  });
  return { projectId: view.project_id, viewId: copyId };
}

// Removes a view (soft delete). Answers the view's project.
export async function deleteView(ctx: ApiContext, viewId: string): Promise<string> {
  const supabase = ctx.db;
  const { data: view } = await supabase
    .from("project_views")
    .select("*")
    .eq("id", id(viewId))
    .is("deleted_at", null)
    .maybeSingle();
  if (!view) throw invalid("This view no longer exists");
  // A project always keeps one shared tab; your own views come and go freely. (A database without
  // personal views has no owner_id: every view there is shared.)
  if (!view.owner_id) {
    const personal = "owner_id" in view;
    const query = supabase
      .from("project_views")
      .select("id", { count: "exact", head: true })
      .eq("project_id", view.project_id)
      .is("deleted_at", null);
    const { count } = await (personal ? query.is("owner_id", null) : query);
    if ((count ?? 0) <= 1) throw invalid("A project needs at least one view");
  }
  checkUpdated(await supabase.from("project_views").update({ deleted_at: nowIso() }).eq("id", viewId).select("id"));
  return view.project_id;
}

// Swaps a view or widget with its neighbour (direction -1 = earlier, 1 = later). Views move among their
// own kind: shared tabs among shared tabs, your own views among yours.
async function moveRow(ctx: ApiContext, table: "project_views" | "dashboard_widgets", rowId: string, direction: number) {
  const supabase = ctx.db;
  let siblings: { id: string; sort_order: number }[];
  if (table === "project_views") {
    const { data: row } = await supabase
      .from("project_views")
      .select("*")
      .eq("id", id(rowId))
      .is("deleted_at", null)
      .maybeSingle();
    if (!row) throw invalid("This item no longer exists");
    const query = supabase
      .from("project_views")
      .select("id, sort_order")
      .eq("project_id", row.project_id)
      .is("deleted_at", null);
    const kind = !("owner_id" in row) ? query : row.owner_id ? query.eq("owner_id", row.owner_id) : query.is("owner_id", null);
    const { data } = await kind.order("sort_order").order("created_at");
    siblings = data ?? [];
  } else {
    const { data: row } = await supabase
      .from(table)
      .select("project_id")
      .eq("id", id(rowId))
      .is("deleted_at", null)
      .maybeSingle();
    if (!row) throw invalid("This item no longer exists");
    const { data } = await supabase
      .from(table)
      .select("id, sort_order")
      .eq("project_id", row.project_id)
      .is("deleted_at", null)
      .order("sort_order")
      .order("created_at");
    siblings = data ?? [];
  }
  const list = siblings;
  const index = list.findIndex((s) => s.id === rowId);
  const target = index + (direction < 0 ? -1 : 1);
  if (index === -1 || target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  for (const [i, item] of list.entries()) {
    const order = (i + 1) * ORDER_STEP;
    if (item.sort_order !== order) {
      check(await supabase.from(table).update({ sort_order: order }).eq("id", item.id));
    }
  }
}

export async function moveView(ctx: ApiContext, viewId: string, direction: -1 | 1): Promise<void> {
  await moveRow(ctx, "project_views", viewId, direction);
}

// ---------------------------------------------------------------------------------------------
// A project's tabs
// ---------------------------------------------------------------------------------------------

// Oct 26 notes (batch 4): hide one of the project's fixed tabs (Overview, Dashboard, Messages, Workload,
// Files) or add it back. Editors+ (RLS); the tab's page itself stays reachable by its link.
export async function setProjectTabHidden(ctx: ApiContext, projectId: string, tab: string, hidden: boolean): Promise<void> {
  if (!isFixedTab(tab)) throw invalid("Unknown tab");
  const project = id(projectId);
  const supabase = ctx.db;
  const current = await supabase
    .from("project_view_settings")
    .select("hidden_tabs")
    .eq("project_id", project)
    .maybeSingle();
  if (current.error?.code === "PGRST205" || current.error?.code === "42P01") {
    throw invalid("Hiding tabs needs this release’s database update");
  }
  check(current);
  const set = new Set(current.data?.hidden_tabs ?? []);
  if (hidden) set.add(tab);
  else set.delete(tab);
  const hiddenTabs = [...set].filter(isFixedTab);
  if (current.data) {
    checkUpdated(
      await supabase.from("project_view_settings").update({ hidden_tabs: hiddenTabs }).eq("project_id", project).select("project_id"),
      "Only Editors and up change a project’s tabs",
    );
  } else {
    const inserted = await supabase.from("project_view_settings").insert({ project_id: project, hidden_tabs: hiddenTabs });
    // Someone else made the row a moment ago: change theirs instead.
    if (inserted.error?.code === "23505") {
      checkUpdated(
        await supabase.from("project_view_settings").update({ hidden_tabs: hiddenTabs }).eq("project_id", project).select("project_id"),
        "Only Editors and up change a project’s tabs",
      );
    } else {
      check(inserted, "Only Editors and up change a project’s tabs");
    }
  }
}

// Nov 2 notes (batch 15, 117): hide one of the project's shared view tabs (List, Board, Calendar,
// Timeline, …) for everyone, or show it again. Editors+ (RLS); the view and its page stay. The last shown
// view can't be hidden (the project's link has to open something).
export async function setProjectViewHidden(ctx: ApiContext, projectId: string, viewId: string, hidden: boolean): Promise<void> {
  const project = id(projectId);
  const view = id(viewId, "view");
  const supabase = ctx.db;
  const current = await supabase
    .from("project_view_settings")
    .select("hidden_view_ids")
    .eq("project_id", project)
    .maybeSingle();
  if (current.error?.code === "PGRST205" || current.error?.code === "42P01" || current.error?.code === "42703") {
    throw invalid("Hiding view tabs needs this release’s database update");
  }
  check(current);
  const set = new Set(current.data?.hidden_view_ids ?? []);
  if (hidden) {
    const shared = await supabase
      .from("project_views")
      .select("id")
      .eq("project_id", project)
      .is("owner_id", null)
      .is("deleted_at", null);
    check(shared);
    const shown = (shared.data ?? []).filter((v) => v.id !== view && !set.has(v.id));
    if (shown.length === 0) throw invalid("Keep at least one view tab shown");
    set.add(view);
  } else {
    set.delete(view);
  }
  const hiddenViewIds = [...set];
  if (current.data) {
    checkUpdated(
      await supabase.from("project_view_settings").update({ hidden_view_ids: hiddenViewIds }).eq("project_id", project).select("project_id"),
      "Only Editors and up change a project’s tabs",
    );
  } else {
    const inserted = await supabase.from("project_view_settings").insert({ project_id: project, hidden_view_ids: hiddenViewIds });
    if (inserted.error?.code === "23505") {
      checkUpdated(
        await supabase.from("project_view_settings").update({ hidden_view_ids: hiddenViewIds }).eq("project_id", project).select("project_id"),
        "Only Editors and up change a project’s tabs",
      );
    } else {
      check(inserted, "Only Editors and up change a project’s tabs");
    }
  }
}

// The view /projects/<id> opens for everyone (Owners only; null = the first tab).
export async function setDefaultView(ctx: ApiContext, projectId: string, viewId: string | null): Promise<void> {
  const project = id(projectId);
  const view = viewId === null ? null : id(viewId, "view");
  const supabase = ctx.db;
  const current = await supabase.from("project_view_settings").select("project_id").eq("project_id", project).maybeSingle();
  if (current.error?.code === "PGRST205" || current.error?.code === "42P01") {
    throw invalid("A default view needs this release’s database update");
  }
  check(current);
  const notAllowed = "Only the project’s owners choose its default view";
  if (current.data) {
    checkUpdated(
      await supabase.from("project_view_settings").update({ default_view_id: view }).eq("project_id", project).select("project_id"),
      notAllowed,
    );
  } else {
    const inserted = await supabase.from("project_view_settings").insert({ project_id: project, default_view_id: view });
    if (inserted.error?.code === "23505") {
      checkUpdated(
        await supabase.from("project_view_settings").update({ default_view_id: view }).eq("project_id", project).select("project_id"),
        notAllowed,
      );
    } else {
      check(inserted, notAllowed);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Dashboard widgets
// ---------------------------------------------------------------------------------------------

const STARTER_WIDGETS: { kind: WidgetKind; title: string; filters: ViewFilters }[] = [
  { kind: "count", title: "Incomplete tasks", filters: {} },
  { kind: "count", title: "Overdue", filters: { due: { kind: "overdue" } } },
  { kind: "count", title: "Completed in the last 7 days", filters: { completion: "completed", completed_within_days: 7 } },
  { kind: "by_section", title: "Incomplete by section", filters: {} },
  { kind: "by_assignee", title: "Incomplete by assignee", filters: {} },
];

export async function installStarterWidgets(ctx: ApiContext, projectId: string): Promise<void> {
  const start = await nextOrder(ctx, "dashboard_widgets", projectId);
  const supabase = ctx.db;
  check(
    await supabase.from("dashboard_widgets").insert(
      STARTER_WIDGETS.map((w, i) => ({
        project_id: projectId,
        kind: w.kind,
        title: w.title,
        filters: toJson(w.filters),
        sort_order: start + i * ORDER_STEP,
      })),
    ),
  );
}

export async function createWidget(
  ctx: ApiContext,
  projectId: string,
  input: { kind: string; title: string; filters?: ViewFilters },
): Promise<void> {
  if (!isWidgetKind(input.kind)) throw invalid("Unknown widget type");
  const supabase = ctx.db;
  check(
    await supabase.from("dashboard_widgets").insert({
      project_id: id(projectId),
      kind: input.kind,
      title: text(input.title, "Widget title", { max: 100 }),
      filters: toJson(parseFilters(input.filters ?? {})),
      sort_order: await nextOrder(ctx, "dashboard_widgets", projectId),
    }),
  );
}

export async function updateWidget(
  ctx: ApiContext,
  widgetId: string,
  patch: { kind?: string; title?: string; filters?: ViewFilters },
): Promise<void> {
  const update: { kind?: string; title?: string; filters?: Json } = {};
  if (patch.kind !== undefined) {
    if (!isWidgetKind(patch.kind)) throw invalid("Unknown widget type");
    update.kind = patch.kind;
  }
  if (patch.title !== undefined) update.title = text(patch.title, "Widget title", { max: 100 });
  if (patch.filters !== undefined) update.filters = toJson(parseFilters(patch.filters));
  const supabase = ctx.db;
  checkUpdated(await supabase.from("dashboard_widgets").update(update).eq("id", id(widgetId)).select("id"));
}

export async function deleteWidget(ctx: ApiContext, widgetId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("dashboard_widgets").update({ deleted_at: nowIso() }).eq("id", id(widgetId)).select("id"),
  );
}

export async function moveWidget(ctx: ApiContext, widgetId: string, direction: -1 | 1): Promise<void> {
  await moveRow(ctx, "dashboard_widgets", widgetId, direction);
}
