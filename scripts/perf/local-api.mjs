// A stand-in for the Supabase API in front of a local Postgres, for measuring screens (batch 22):
//   node scripts/perf/local-api.mjs keys <dir>                 ES256 key, jwks.json, anon.key in <dir>
//   node scripts/perf/local-api.mjs cookie <dir> <user id> <email>   prints a session cookie value
//   node scripts/perf/local-api.mjs serve <dir> [postgrest port]     :54321 → /rest/v1 to PostgREST,
//                                                                      /auth/v1/.well-known/jwks.json
// PostgREST (v12) runs with jwt-secret = "@<dir>/jwks.json"; the app with NEXT_PUBLIC_SUPABASE_URL =
// http://127.0.0.1:54321 and the anon key, so getClaims() verifies sessions against the JWKS like on
// Supabase. Local only: never point this at the hosted project.
import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const [command, dir = ".", ...rest] = process.argv.slice(2);
const b64u = (b) => Buffer.from(b).toString("base64url");
const file = (name) => path.join(dir, name);

function jwkOf(privateKey) {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return { ...jwk, kid: "local-es256", alg: "ES256", use: "sig" };
}
function sign(privateKey, payload) {
  const head = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "local-es256" }));
  const body = b64u(JSON.stringify(payload));
  const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}
const now = Math.floor(Date.now() / 1000);
const exp = now + 60 * 60 * 24 * 30;

if (command === "keys") {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  writeFileSync(file("private.pem"), privateKey.export({ format: "pem", type: "pkcs8" }));
  writeFileSync(file("jwks.json"), JSON.stringify({ keys: [jwkOf(privateKey)] }));
  writeFileSync(file("anon.key"), sign(privateKey, { role: "anon", iss: "supabase", iat: now, exp }));
} else if (command === "cookie") {
  const [id, email] = rest;
  const privateKey = createPrivateKey(readFileSync(file("private.pem")));
  const access = sign(privateKey, { sub: id, email, role: "authenticated", aud: "authenticated", iat: now, exp, session_id: `s-${id}`, aal: "aal1", user_metadata: {}, app_metadata: { provider: "email" } });
  const session = {
    access_token: access, token_type: "bearer", expires_in: exp - now, expires_at: exp, refresh_token: "local",
    user: { id, aud: "authenticated", role: "authenticated", email, email_confirmed_at: new Date().toISOString(), app_metadata: { provider: "email" }, user_metadata: {}, created_at: new Date().toISOString() },
  };
  process.stdout.write(`base64-${b64u(JSON.stringify(session))}`);
} else if (command === "serve") {
  const port = Number(rest[0] ?? 3011);
  const jwks = readFileSync(file("jwks.json"));
  http
    .createServer((req, res) => {
      if (req.url.startsWith("/auth/v1/.well-known/jwks.json")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(jwks);
      }
      if (!req.url.startsWith("/rest/v1")) {
        res.writeHead(404);
        return res.end("{}");
      }
      const upstream = http.request(
        { host: "127.0.0.1", port, path: req.url.slice("/rest/v1".length) || "/", method: req.method, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        res.writeHead(502);
        res.end(String(e));
      });
      req.pipe(upstream);
    })
    .listen(54321, "127.0.0.1");
} else {
  console.error("usage: local-api.mjs keys|cookie|serve <dir> …");
  process.exit(1);
}
