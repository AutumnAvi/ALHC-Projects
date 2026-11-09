"use server";
// AI builder round 5 (experimental, note 178): Settings → AI & MCP. Thin wrappers around
// packages/core/src/api/mcp/mutations.ts, as the signed-in person (RLS: own rows; only workspace admins of
// the Testing data pilot). The token is made here, hashed with the server-side pepper, and answered ONCE;
// only the hash and a short prefix are stored. Nothing here logs a token.
import { createAccessToken, revokeAccessToken } from "@alhc/core/api/mcp/mutations";
import { ApiError } from "@alhc/core/api/core/errors";
import { hashAccessToken, newAccessToken } from "@/lib/mcp/token";
import { mcpConfigured } from "@/lib/mcp/auth";
import { run, runWith } from "@/lib/server/action";

export async function createMcpToken(input: { name: string; scopes: string[]; days: number }) {
  return runWith<{ token: string }>(
    async (ctx) => {
      if (!mcpConfigured()) throw new ApiError("unavailable", "The MCP endpoint isn’t set up on this deployment (ALHC_MCP_TOKEN_PEPPER, SUPABASE_JWT_SECRET)");
      const token = newAccessToken();
      await createAccessToken(ctx, { name: input.name, scopes: input.scopes, days: input.days, token, tokenHash: await hashAccessToken(token, process.env.ALHC_MCP_TOKEN_PEPPER!) });
      return { token };
    },
    { deliver: false, revalidate: [["/settings/mcp", "page"]] },
  );
}

export async function revokeMcpToken(tokenId: string) {
  return run((ctx) => revokeAccessToken(ctx, tokenId), { deliver: false, revalidate: [["/settings/mcp", "page"]] });
}
