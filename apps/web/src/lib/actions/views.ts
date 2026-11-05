"use server";
// Big move 1: the views area's Server Actions, thin wrappers around packages/core/src/api/views/mutations.ts. Only
// what Next.js does (redirects, refreshing the page or not) stays here.
import { redirect } from "next/navigation";
import type { ActionResult } from "@alhc/core/api/core/result";
import * as viewsApi from "@alhc/core/api/views/mutations";
import type { ColumnWidths } from "@alhc/core/column-widths";
import { run, runWith } from "@/lib/server/action";
import type { ViewConfig, ViewFilters } from "@alhc/core/views";

// ---------------------------------------------------------------------------------------------
// The person's List settings
// ---------------------------------------------------------------------------------------------

// No refresh: the List already shows the widths it sent.
export async function saveListColumnWidths(projectId: string, widths: ColumnWidths): Promise<ActionResult> {
  return run((ctx) => viewsApi.saveListColumnWidths(ctx, projectId, widths), { refresh: false, deliver: false });
}

// Saved quietly (no refresh).
export async function saveListCollapsedGroups(projectId: string, keys: string[]): Promise<ActionResult> {
  return run((ctx) => viewsApi.saveListCollapsedGroups(ctx, projectId, keys), { refresh: false, deliver: false });
}

// The page refreshes with it applied.
export async function setProjectShowCompleted(
  projectId: string,
  show: boolean,
): Promise<ActionResult & { remembered?: boolean }> {
  return runWith((ctx) => viewsApi.setProjectShowCompleted(ctx, projectId, show));
}

// ---------------------------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------------------------

export async function createView(
  projectId: string,
  input: { name?: string; layout: string; config?: ViewConfig; personal?: boolean },
  // false = return the new view's id instead of opening it (the caller navigates, e.g. after a toast).
  open = true,
): Promise<ActionResult & { viewId?: string }> {
  const result = await runWith(async (ctx) => ({ viewId: await viewsApi.createView(ctx, projectId, input) }));
  if (result.viewId && !result.error && open) redirect(`/projects/${projectId}/views/${result.viewId}`);
  return { ...result, viewId: result.viewId };
}

export async function updateView(
  viewId: string,
  patch: { name?: string; config?: ViewConfig },
): Promise<ActionResult> {
  return run((ctx) => viewsApi.updateView(ctx, viewId, patch));
}

export async function saveViewChanges(
  viewId: string,
  config: ViewConfig,
): Promise<ActionResult & { copied?: boolean; viewId?: string }> {
  return runWith((ctx) => viewsApi.saveViewChanges(ctx, viewId, config));
}

export async function saveViewForMe(
  viewId: string,
  config: ViewConfig | null,
): Promise<ActionResult & { copied?: boolean; viewId?: string }> {
  return runWith((ctx) => viewsApi.saveViewForMe(ctx, viewId, config));
}

export async function saveViewForEveryone(viewId: string, config: ViewConfig): Promise<ActionResult> {
  return run((ctx) => viewsApi.saveViewForEveryone(ctx, viewId, config));
}

// The copy opens.
export async function duplicateView(viewId: string): Promise<ActionResult> {
  const result = await runWith(async (ctx) => ({ copy: await viewsApi.duplicateView(ctx, viewId) }));
  if (result.copy && !result.error) redirect(`/projects/${result.copy.projectId}/views/${result.copy.viewId}`);
  return result.error ? { error: result.error, code: result.code } : {};
}

export async function deleteView(viewId: string): Promise<ActionResult> {
  const result = await runWith(async (ctx) => ({ projectId: await viewsApi.deleteView(ctx, viewId) }));
  if (result.projectId && !result.error) redirect(`/projects/${result.projectId}`);
  return result.error ? { error: result.error, code: result.code } : {};
}

export async function moveView(viewId: string, direction: -1 | 1): Promise<ActionResult> {
  return run((ctx) => viewsApi.moveView(ctx, viewId, direction));
}

// ---------------------------------------------------------------------------------------------
// A project's tabs
// ---------------------------------------------------------------------------------------------

export async function setProjectTabHidden(projectId: string, tab: string, hidden: boolean): Promise<ActionResult> {
  return run((ctx) => viewsApi.setProjectTabHidden(ctx, projectId, tab, hidden));
}

export async function setProjectViewHidden(projectId: string, viewId: string, hidden: boolean): Promise<ActionResult> {
  return run((ctx) => viewsApi.setProjectViewHidden(ctx, projectId, viewId, hidden));
}

export async function setDefaultView(projectId: string, viewId: string | null): Promise<ActionResult> {
  return run((ctx) => viewsApi.setDefaultView(ctx, projectId, viewId));
}

// ---------------------------------------------------------------------------------------------
// Dashboard widgets
// ---------------------------------------------------------------------------------------------

export async function installStarterWidgets(projectId: string): Promise<ActionResult> {
  return run((ctx) => viewsApi.installStarterWidgets(ctx, projectId));
}

export async function createWidget(
  projectId: string,
  input: { kind: string; title: string; filters?: ViewFilters },
): Promise<ActionResult> {
  return run((ctx) => viewsApi.createWidget(ctx, projectId, input));
}

export async function updateWidget(
  widgetId: string,
  patch: { kind?: string; title?: string; filters?: ViewFilters },
): Promise<ActionResult> {
  return run((ctx) => viewsApi.updateWidget(ctx, widgetId, patch));
}

export async function deleteWidget(widgetId: string): Promise<ActionResult> {
  return run((ctx) => viewsApi.deleteWidget(ctx, widgetId));
}

export async function moveWidget(widgetId: string, direction: -1 | 1): Promise<ActionResult> {
  return run((ctx) => viewsApi.moveWidget(ctx, widgetId, direction));
}
