// A stand-in for the Supabase API in front of a local Postgres, for measuring screens (batch 22):
//   node scripts/perf/local-api.mjs keys <dir>                 ES256 key, jwks.json, anon.key in <dir>
//   node scripts/perf/local-api.mjs cookie <dir> <user id> <email>   prints a session cookie value
//   node scripts/perf/local-api.mjs serve <dir> [postgrest port]     :54321 → /rest/v1 to PostgREST,
//                                                                      /auth/v1/.well-known/jwks.json
//   REALTIME=1 … serve …   also /realtime/v1/websocket: acks channel joins and heartbeats (vsn 2.0.0) and
//                          sends nothing, so the app's live topics read as joined (batch 42's timings)
// PostgREST (v12) runs with jwt-secret = "@<dir>/jwks.json"; the app with NEXT_PUBLIC_SUPABASE_URL =
// http://127.0.0.1:54321 and the anon key, so getClaims() verifies sessions against the JWKS like on
// Supabase. Local only: never point this at the hosted project.
import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
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
  const server = http
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
  if (process.env.REALTIME === "1") server.on("upgrade", realtimeStandIn);
} else {
  console.error("usage: local-api.mjs keys|cookie|serve <dir> …");
  process.exit(1);
}

// A WebSocket that answers Phoenix joins, heartbeats, and token updates with "ok" (text frames, vsn 2.0.0
// arrays [join_ref, ref, topic, event, payload]). Local measuring only: no broadcasts, no auth.
function realtimeStandIn(req, socket) {
  if (!req.url.startsWith("/realtime/v1/websocket")) return socket.destroy();
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (text) => {
    const body = Buffer.from(text);
    const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
    socket.write(Buffer.concat([head, body]));
  };
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 15;
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const mask = buf[1] & 128 ? buf.subarray(off, off + 4) : null;
      if (mask) off += 4;
      if (buf.length < off + len) return;
      const data = Buffer.from(buf.subarray(off, off + len));
      buf = buf.subarray(off + len);
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      if (op === 8) return socket.end();
      if (op !== 1) continue;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        continue;
      }
      const [joinRef, ref, topic, event] = message;
      if (["phx_join", "heartbeat", "access_token", "phx_leave"].includes(event)) {
        send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: event === "phx_join" ? { postgres_changes: [] } : {} }]));
      }
    }
  });
  socket.on("error", () => {});
}
