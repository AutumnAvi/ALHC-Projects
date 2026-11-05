"use server";
// Big move 1: what the project page loads on demand (Asana parity, batch 2: the Share dialog; batch 4:
// Customize → Emails and Apps), thin wrappers around src/lib/api/project-page/queries.ts, read with the
// signed-in person's own context (RLS decides; never the service role).
import * as projectPageApi from "@/lib/api/project-page/queries";
import { isEmailConfigured } from "@/lib/email";
import type { CustomizeDetails, ShareData } from "@/lib/project-page";
import { actionContext } from "@/lib/server/context";

export async function loadProjectShare(projectId: string): Promise<ShareData | null> {
  return projectPageApi.loadProjectShare(await actionContext(), projectId, isEmailConfigured());
}

export async function loadCustomizeDetails(projectId: string): Promise<CustomizeDetails | null> {
  return projectPageApi.loadCustomizeDetails(await actionContext(), projectId);
}
