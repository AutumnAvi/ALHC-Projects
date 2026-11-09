// AI builder round 5 (note 178): the person's own MCP tokens (RLS: own rows; the hash is never readable).
import type { ApiContext } from "../core/context";
import { rows } from "../core/db";
import type { AccessToken, AccessTokenScope } from "./model";

export async function listAccessTokens(ctx: ApiContext): Promise<AccessToken[]> {
  return rows(
    await ctx.db.from("personal_access_tokens").select("id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at").order("created_at", { ascending: false }).limit(50),
    "tokens",
  ).map((t) => ({
    id: t.id,
    name: t.name,
    prefix: t.token_prefix,
    scopes: t.scopes.filter((s): s is AccessTokenScope => s === "read" || s === "write"),
    createdAt: t.created_at,
    lastUsedAt: t.last_used_at,
    expiresAt: t.expires_at,
    revokedAt: t.revoked_at,
  }));
}

// The MCP route's token lookup. `ctx` must be the service role's (mcp_token_verify is service_role only):
// a keyed hash in; whether the token may be used, and whose it is — nothing else.
export type VerifiedToken =
  | { status: "ok"; tokenId: string; profileId: string; workspaceId: string; scopes: AccessTokenScope[] }
  | { status: "unknown" | "revoked" | "expired" | "not_allowed" | "rate_limited" | "error" };

export async function verifyAccessTokenHash(ctx: ApiContext, tokenHash: string): Promise<VerifiedToken> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return { status: "unknown" };
  const res = await ctx.db.rpc("mcp_token_verify", { target_hash: tokenHash });
  if (res.error) return { status: "error" };
  const d = (res.data ?? {}) as Record<string, unknown>;
  const status = typeof d.status === "string" ? d.status : "unknown";
  if (status !== "ok") return { status: (["unknown", "revoked", "expired", "not_allowed", "rate_limited"].includes(status) ? status : "unknown") as "unknown" };
  const scopes = Array.isArray(d.scopes) ? d.scopes.filter((s): s is AccessTokenScope => s === "read" || s === "write") : [];
  if (typeof d.token_id !== "string" || typeof d.profile_id !== "string" || typeof d.workspace_id !== "string") return { status: "error" };
  return { status: "ok", tokenId: d.token_id, profileId: d.profile_id.toLowerCase(), workspaceId: d.workspace_id, scopes };
}
