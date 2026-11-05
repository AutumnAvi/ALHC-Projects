// Big move 1: the workload area's writes. Every function takes the caller's ApiContext first, validates its
// own input, writes only through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no
// Next.js here.
import type { ApiContext } from "@/lib/api/core/context";
import { check } from "@/lib/api/core/db";
import { invalid } from "@/lib/api/core/errors";
import { id } from "@/lib/api/core/validate";

// Weekly capacity of one person in a project's or a portfolio's workload; null clears it.
export async function setWorkloadCapacity(
  ctx: ApiContext,
  scope: { projectId: string } | { portfolioId: string },
  profileId: string,
  capacity: number | null,
): Promise<void> {
  if (capacity !== null && (!Number.isFinite(capacity) || capacity <= 0 || capacity > 100000)) {
    throw invalid("Capacity must be a number greater than 0");
  }
  const supabase = ctx.db;
  check(
    await supabase.rpc("set_workload_capacity", {
      target_project: "projectId" in scope ? id(scope.projectId, "project") : null,
      target_portfolio: "portfolioId" in scope ? id(scope.portfolioId, "portfolio") : null,
      target_profile: id(profileId, "person"),
      new_capacity: capacity,
    }),
  );
}
