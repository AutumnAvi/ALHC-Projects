// AI builder round 5 (note 178): making and revoking MCP personal access tokens, as the signed-in person
// (RLS: own rows; only workspace admins of the live pilot may make one; guard_personal_access_token keeps a
// token to 90 days, 10 live, and revocation final). The app makes the token and its keyed hash (with a
// server-side pepper this layer never sees); only the hash and a short prefix are stored.
import type { ApiContext } from "../core/context";
import { check, checkUpdated } from "../core/db";
import { ApiError, invalid } from "../core/errors";
import { id, text } from "../core/validate";
import { requirePilot } from "../ai-builder/mutations";
import { ACCESS_TOKEN_LIMITS, ACCESS_TOKEN_PREFIX_LENGTH, type AccessTokenScope } from "./model";

export async function createAccessToken(
  ctx: ApiContext,
  input: { name: unknown; scopes: unknown; days: unknown; token: string; tokenHash: string },
): Promise<{ id: string }> {
  const access = await requirePilot(ctx);
  const name = text(input.name, "Token name", { max: ACCESS_TOKEN_LIMITS.nameMax });
  const scopes = Array.isArray(input.scopes) ? [...new Set(input.scopes.filter((s): s is AccessTokenScope => s === "read" || s === "write"))] : [];
  if (!scopes.includes("read")) scopes.unshift("read");
  const days = typeof input.days === "number" && Number.isInteger(input.days) && input.days >= 1 && input.days <= ACCESS_TOKEN_LIMITS.maxDays ? input.days : ACCESS_TOKEN_LIMITS.defaultDays;
  if (!/^[0-9a-f]{64}$/.test(input.tokenHash)) throw invalid("Invalid token");
  const inserted = await ctx.db
    .from("personal_access_tokens")
    .insert({
      workspace_id: access.workspaceId,
      name,
      token_prefix: input.token.slice(0, ACCESS_TOKEN_PREFIX_LENGTH),
      token_hash: input.tokenHash,
      scopes,
      expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    })
    .select("id")
    .single();
  if (inserted.error?.code === "42P01" || inserted.error?.code === "PGRST205") throw new ApiError("not_deployed", "MCP tokens need this release’s database update");
  check(inserted);
  return { id: inserted.data!.id };
}

export async function revokeAccessToken(ctx: ApiContext, tokenId: string): Promise<void> {
  checkUpdated(await ctx.db.from("personal_access_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", id(tokenId, "token")).is("revoked_at", null).select("id"), "That token isn’t yours or is already revoked");
}
