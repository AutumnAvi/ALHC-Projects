"use server";
// Big move 1: what the project page loads on demand (Asana parity, batch 2: the Share dialog; batch 4:
// Customize → Emails and Apps), thin wrappers around packages/core/src/api/project-page/queries.ts, read with the
// signed-in person's own context (RLS decides; never the service role).
import * as projectPageApi from "@alhc/core/api/project-page/queries";
import { isEmailConfigured } from "@/lib/email";
import type { CustomizeDetails, ShareData } from "@alhc/core/project-page";
import type { NumberingCounts } from "@alhc/core/customize";
import * as numbersApi from "@alhc/core/api/numbers/queries";
import type { RuleRun } from "@alhc/core/rules";
import { actionContext } from "@/lib/server/context";

export async function loadProjectShare(projectId: string): Promise<ShareData | null> {
  return projectPageApi.loadProjectShare(await actionContext(), projectId, isEmailConfigured());
}

export async function loadCustomizeDetails(projectId: string): Promise<CustomizeDetails | null> {
  return projectPageApi.loadCustomizeDetails(await actionContext(), projectId);
}

// Nov 8 notes (batch 30): Customize's numbering counts and its Automations → History tab.
export async function loadNumberingCounts(projectId: string): Promise<NumberingCounts> {
  return numbersApi.numberingCounts(await actionContext(), projectId);
}

export async function loadCustomizeRuns(projectId: string): Promise<RuleRun[]> {
  return projectPageApi.loadCustomizeRuns(await actionContext(), projectId);
}
