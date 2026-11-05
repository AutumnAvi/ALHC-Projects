"use server";
// Big move 1: the workload area's Server Actions, thin wrappers around packages/core/src/api/workload/mutations.ts.
import type { ActionResult } from "@alhc/core/api/core/result";
import * as workloadApi from "@alhc/core/api/workload/mutations";
import { run } from "@/lib/server/action";

// Weekly capacity of one person in a project's or a portfolio's workload; null clears it.
export async function setWorkloadCapacity(
  scope: { projectId: string } | { portfolioId: string },
  profileId: string,
  capacity: number | null,
): Promise<ActionResult> {
  return run((ctx) => workloadApi.setWorkloadCapacity(ctx, scope, profileId, capacity));
}
