import "server-only";
// AI builder round 5 (note 178): who an MCP request is. Only an `Authorization: Bearer alhc_pat_…` header
// counts — never cookies (so a browser session can't reach the endpoint). The token's keyed
// hash goes to the database's one lookup (mcp_token_verify, service role only: it answers the owner's id,
// workspace, and scopes, enforces revocation, expiry, the pilot, and 120 calls a minute, and nothing else);
// then the request acts as that person through a 5-minute token minted for them (RLS as them). Fails closed:
// without the pepper or the JWT secret the endpoint answers 503 and reads nothing.
import { verifyAccessTokenHash, type VerifiedToken } from "@alhc/core/api/mcp/queries";
import type { ApiContext } from "@alhc/core/api/core/context";
import type { McpIdentity } from "@alhc/core/api/mcp/tools";
import { adminContext, bearerContext } from "@/lib/server/context";
import { hashAccessToken, looksLikeAccessToken, mintUserJwt } from "./token";

export type McpAuth =
  | { ok: true; ctx: ApiContext; identity: McpIdentity }
  | { ok: false; status: 401 | 429 | 503; error: string };

export function mcpConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.ALHC_MCP_TOKEN_PEPPER && env.ALHC_MCP_TOKEN_PEPPER.length >= 32 && env.SUPABASE_JWT_SECRET && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function bearerOf(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m && looksLikeAccessToken(m[1]) ? m[1] : null;
}

const DENIED: Record<Exclude<VerifiedToken["status"], "ok">, McpAuth> = {
  unknown: { ok: false, status: 401, error: "Invalid token" },
  revoked: { ok: false, status: 401, error: "This token was revoked" },
  expired: { ok: false, status: 401, error: "This token expired" },
  not_allowed: { ok: false, status: 401, error: "This token’s owner can’t use the AI tools any more" },
  rate_limited: { ok: false, status: 429, error: "Too many calls with this token; wait a minute" },
  error: { ok: false, status: 503, error: "Couldn’t check the token" },
};

export async function authenticateMcp(authorization: string | null, verify: (hash: string) => Promise<VerifiedToken> = defaultVerify): Promise<McpAuth> {
  if (!mcpConfigured()) return { ok: false, status: 503, error: "The MCP endpoint isn’t set up on this deployment" };
  const token = bearerOf(authorization);
  if (!token) return { ok: false, status: 401, error: "Send Authorization: Bearer <your personal access token>" };
  const result = await verify(await hashAccessToken(token, process.env.ALHC_MCP_TOKEN_PEPPER!));
  if (result.status !== "ok") return DENIED[result.status];
  const ctx = bearerContext(await mintUserJwt(result.profileId, process.env.SUPABASE_JWT_SECRET!));
  if (!ctx) return { ok: false, status: 503, error: "The MCP endpoint isn’t set up on this deployment" };
  return { ok: true, ctx, identity: { profileId: result.profileId, workspaceId: result.workspaceId, scopes: result.scopes, tokenId: result.tokenId } };
}

async function defaultVerify(hash: string): Promise<VerifiedToken> {
  const admin = adminContext();
  if (!admin) return { status: "error" };
  return verifyAccessTokenHash(admin, hash);
}
