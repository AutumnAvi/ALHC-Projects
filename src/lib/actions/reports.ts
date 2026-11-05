"use server";
// Big move 1: the reports area's Server Actions (personal dashboards), thin wrappers around
// src/lib/api/reports/mutations.ts. Only what Next.js does (redirects, the request's context) stays here.
import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/api/core/result";
import type { PersonalWidgetInput } from "@/lib/api/reports/model";
import * as reportsApi from "@/lib/api/reports/mutations";
import { run } from "@/lib/server/action";

// ---------------------------------------------------------------------------------------------
// Personal dashboards
// ---------------------------------------------------------------------------------------------

export async function createPersonalDashboard(formData: FormData): Promise<ActionResult> {
  let dashboardId: string | null = null;
  const result = await run(async (ctx) => {
    dashboardId = await reportsApi.createPersonalDashboard(ctx, { name: formData.get("name") });
  });
  if (dashboardId && !result.error) redirect(`/reports/dashboards/${dashboardId}`);
  return result;
}

export async function renamePersonalDashboard(dashboardId: string, name: string): Promise<ActionResult> {
  return run((ctx) => reportsApi.renamePersonalDashboard(ctx, dashboardId, name));
}

export async function deletePersonalDashboard(dashboardId: string): Promise<ActionResult> {
  const result = await run((ctx) => reportsApi.deletePersonalDashboard(ctx, dashboardId));
  if (!result.error) redirect("/reports/dashboards");
  return result;
}

export async function createPersonalWidget(dashboardId: string, input: PersonalWidgetInput): Promise<ActionResult> {
  return run((ctx) => reportsApi.createPersonalWidget(ctx, dashboardId, input));
}

export async function updatePersonalWidget(widgetId: string, patch: Partial<PersonalWidgetInput>): Promise<ActionResult> {
  return run((ctx) => reportsApi.updatePersonalWidget(ctx, widgetId, patch));
}

export async function deletePersonalWidget(widgetId: string): Promise<ActionResult> {
  return run((ctx) => reportsApi.deletePersonalWidget(ctx, widgetId));
}

export async function movePersonalWidget(widgetId: string, direction: -1 | 1): Promise<ActionResult> {
  return run((ctx) => reportsApi.movePersonalWidget(ctx, widgetId, direction));
}
