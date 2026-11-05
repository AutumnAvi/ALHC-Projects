"use server";
// Big move 1: the workload area's Server Actions, thin wrappers around src/lib/api/workload/mutations.ts.
import type { ActionResult } from "@/lib/api/core/result";
import * as workloadApi from "@/lib/api/workload/mutations";
import { run } from "@/lib/server/action";

// Weekly capacity of one person in a project's or a portfolio's workload; null clears it.
export async function setWorkloadCapacity(
  scope: { projectId: string } | { portfolioId: string },
  profileId: string,
  capacity: number | null,
): Promise<ActionResult> {
  return run((ctx) => workloadApi.setWorkloadCapacity(ctx, scope, profileId, capacity));
}
