// AI builder round 5 (note 178): MCP personal access tokens and the short-lived user tokens the MCP endpoint
// acts with. Web Crypto only (works in Node and edge runtimes); no secret is ever logged or returned.
//
//   newAccessToken()       alhc_pat_ + 43 base64url characters (32 random bytes), shown to the person once.
//   hashAccessToken()      HMAC-SHA256(pepper, token) as hex: the only form the database keeps. The pepper is a
//                          server-side secret (ALHC_MCP_TOKEN_PEPPER) the database never sees, so a copy of the
//                          table alone can't be used to check guesses.
//   mintUserJwt()          an HS256 access token for one person (sub = their id, role authenticated, 5 minutes)
//                          signed with the project's JWT secret (SUPABASE_JWT_SECRET), so PostgREST and RLS
//                          treat the MCP call exactly as that person signed in — never the service role.
import { ACCESS_TOKEN_PATTERN } from "@alhc/core/api/mcp/model";

const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `alhc_pat_${base64url(bytes)}`;
}

export const looksLikeAccessToken = (v: unknown): v is string => typeof v === "string" && ACCESS_TOKEN_PATTERN.test(v);

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

export async function hashAccessToken(token: string, pepper: string): Promise<string> {
  if (!pepper || pepper.length < 32) throw new Error("pepper too short");
  return [...(await hmac(pepper, token))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mintUserJwt(sub: string, secret: string, opts: { ttlSeconds?: number; now?: number } = {}): Promise<string> {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(
    enc.encode(JSON.stringify({ sub, role: "authenticated", aud: "authenticated", iat: now, exp: now + (opts.ttlSeconds ?? 300), amr: [{ method: "mcp_token", timestamp: now }], app_metadata: { via: "mcp" } })),
  );
  const signature = base64url(await hmac(secret, `${header}.${payload}`));
  return `${header}.${payload}.${signature}`;
}
