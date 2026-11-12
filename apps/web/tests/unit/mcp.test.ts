// AI builder round 5 (note 178): the MCP endpoint's authentication. Synthetic only: the token lookup is a
// stub (no database), no network.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-key-for-tests";
const PEPPER = "p".repeat(40);
const JWT_SECRET = "jwt-secret-for-tests-only-0123456789";

const { authenticateMcp, bearerOf, mcpConfigured } = await import("@/lib/mcp/auth");
const { hashAccessToken, looksLikeAccessToken, mintUserJwt, newAccessToken } = await import("@/lib/mcp/token");

const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", rel), "utf8");
const ME = "22222222-2222-4222-8222-222222222222";
const WS = "11111111-1111-4111-8111-111111111111";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}
const CONFIGURED = { ALHC_MCP_TOKEN_PEPPER: PEPPER, SUPABASE_JWT_SECRET: JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY: "service-role-for-tests" };

test("tokens: shown once as alhc_pat_…, kept only as a peppered HMAC, never the token itself", async () => {
  const t = newAccessToken();
  assert.ok(looksLikeAccessToken(t));
  assert.notEqual(newAccessToken(), t);
  const h = await hashAccessToken(t, PEPPER);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, createHmac("sha256", PEPPER).update(t).digest("hex"));
  assert.notEqual(await hashAccessToken(t, "q".repeat(40)), h, "the pepper matters");
  assert.ok(!h.includes(t.slice(9, 20)));
  await assert.rejects(hashAccessToken(t, "short"));
});

test("the minted user token is HS256, for that person only, role authenticated, five minutes", async () => {
  const jwt = await mintUserJwt(ME, JWT_SECRET, { now: 1_800_000_000_000 });
  const [h, p, s] = jwt.split(".");
  assert.equal(createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url"), s);
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(payload.sub, ME);
  assert.equal(payload.role, "authenticated");
  assert.equal(payload.exp - payload.iat, 300);
  assert.ok(!("service_role" in payload) && payload.role !== "service_role");
});

test("no token, a malformed one, unknown, revoked, expired, a removed owner → 401; too many calls → 429", async () => {
  await withEnv(CONFIGURED, async () => {
    const never = async () => {
      throw new Error("the lookup must not run");
    };
    assert.equal((await authenticateMcp(null, never)).ok, false);
    assert.equal(((await authenticateMcp(null, never)) as { status: number }).status, 401);
    assert.equal(((await authenticateMcp("Bearer not-a-token", never)) as { status: number }).status, 401);
    assert.equal(((await authenticateMcp(`Basic ${newAccessToken()}`, never)) as { status: number }).status, 401);
    for (const status of ["unknown", "revoked", "expired", "not_allowed"] as const) {
      const r = await authenticateMcp(`Bearer ${newAccessToken()}`, async () => ({ status }));
      assert.equal(r.ok, false);
      assert.equal((r as { status: number }).status, 401, status);
    }
    assert.equal(((await authenticateMcp(`Bearer ${newAccessToken()}`, async () => ({ status: "rate_limited" }))) as { status: number }).status, 429);
  });
});

test("unknown, revoked, expired, not-allowed, and malformed tokens get one identical answer; the reason is logged only", async () => {
  await withEnv(CONFIGURED, async () => {
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (line: string) => lines.push(line);
    const answers: unknown[] = [];
    const tokens: string[] = [];
    try {
      for (const status of ["unknown", "revoked", "expired", "not_allowed"] as const) {
        const token = newAccessToken();
        tokens.push(token);
        answers.push(await authenticateMcp(`Bearer ${token}`, async () => ({ status })));
      }
      answers.push(await authenticateMcp("Bearer not-a-token", async () => ({ status: "unknown" })));
    } finally {
      console.warn = warn;
    }
    for (const a of answers) assert.deepEqual(a, { ok: false, status: 401, error: "Token not accepted" });
    assert.deepEqual(lines, ["unknown", "revoked", "expired", "not_allowed"].map((r) => `[mcp] token refused reason=${r}`));
    for (const t of tokens) assert.ok(!lines.join("\n").includes(t.slice(9)), "never the token");
  });
  // The route answers from status + message alone, so its HTTP responses are identical too.
  const route = read("src/app/api/mcp/route.ts");
  assert.ok(route.includes("if (!auth.ok) return denied(auth.status, auth.error);"));
});

test("a good token acts as its owner (the lookup only ever sees the hash), with the token's scopes", async () => {
  await withEnv(CONFIGURED, async () => {
    const token = newAccessToken();
    const seen: string[] = [];
    const r = await authenticateMcp(`Bearer ${token}`, async (hash) => {
      seen.push(hash);
      return { status: "ok", profileId: ME, workspaceId: WS, scopes: ["read"], tokenId: "t1" };
    });
    assert.equal(r.ok, true);
    assert.deepEqual(seen, [await hashAccessToken(token, PEPPER)]);
    assert.ok(!seen.includes(token));
    if (r.ok) {
      assert.deepEqual(r.identity, { profileId: ME, workspaceId: WS, scopes: ["read"], tokenId: "t1" });
      assert.ok(r.ctx.db, "a context of its own");
    }
  });
});

test("fails closed: without the pepper, the JWT secret, or a long pepper, every call is 503 and nothing is read", async () => {
  for (const env of [
    { ...CONFIGURED, ALHC_MCP_TOKEN_PEPPER: undefined },
    { ...CONFIGURED, ALHC_MCP_TOKEN_PEPPER: "short" },
    { ...CONFIGURED, SUPABASE_JWT_SECRET: undefined },
  ]) {
    await withEnv(env, async () => {
      assert.equal(mcpConfigured(), false);
      const r = await authenticateMcp(`Bearer ${newAccessToken()}`, async () => {
        throw new Error("must not run");
      });
      assert.equal((r as { status: number }).status, 503);
    });
  }
});

test("only the Authorization header counts: the route never reads cookies, so a browser session can't use it", () => {
  assert.equal(bearerOf("Bearer x"), null);
  const route = read("src/app/api/mcp/route.ts");
  const auth = read("src/lib/mcp/auth.ts");
  for (const src of [route, auth]) {
    assert.ok(!/cookies\(|\.cookies\b|renderContext|actionContext|routeContext/.test(src), "no cookie session");
  }
  // Nothing is logged but a refused token's reason (never the token, a prompt, or a tool result).
  assert.ok(!/console\.(log|info|warn|error)/.test(route), "the route logs nothing");
  assert.deepEqual(auth.match(/console\.\w+\([^\n]*/g), ["console.warn(`[mcp] token refused reason=${result.status}`);"]);
  assert.ok(route.includes('request.headers.get("authorization")'));
  // Security audit 2 (Nov 12, batch 41): no preview auto-login at all (previews sign in like production).
  const proxy = read("src/lib/supabase/proxy.ts");
  assert.ok(!/ALHC_PREVIEW_AUTOLOGIN|previewAutoLogin|signInWithPassword/.test(proxy));
});

test("tokens are never stored or shown after creation: the database keeps a hash and a prefix only", () => {
  const sql = read("../../supabase/migrations/20261109120000_ai_assistant_round5_a.sql");
  const table = /create table[^;]*personal_access_tokens[\s\S]*?\);/i.exec(sql)?.[0] ?? "";
  assert.ok(table.includes("token_hash"));
  assert.ok(!/\btoken\s+text\b/i.test(table), "no plaintext token column");
  const action = read("src/lib/actions/mcp-tokens.ts");
  assert.ok(!/console\./.test(action));
});
