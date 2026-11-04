// Batch 22: Supabase calls per screen. Usage: COOKIE=<file with a session cookie value> ALHC_DB_TRACE=<the
// app's trace file> node scripts/perf/screen-calls.mjs <label> [rounds] — prints, per screen, the median calls,
// sequential steps, DB wall / summed time, and response time (one warm-up round first).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const BASE = process.env.BASE ?? "http://localhost:3122";
const TRACE = process.env.ALHC_DB_TRACE ?? "/tmp/alhc-db-trace.jsonl";
const LABEL = process.argv[2] ?? "run";
const ROUNDS = Number(process.argv[3] ?? 5);
const cookieVal = readFileSync(process.env.COOKIE, "utf8").trim();
function cookieHeader() {
  const name = "sb-127-auth-token";
  if (cookieVal.length <= 3180) return `${name}=${cookieVal}; tz=UTC`;
  const parts = []; for (let i = 0, n = 0; i < cookieVal.length; i += 3180, n++) parts.push(`${name}.${n}=${cookieVal.slice(i, i + 3180)}`);
  return parts.join("; ") + "; tz=UTC";
}
const P = "b1000000-0000-4000-8000-000000000001";
const SCREENS = JSON.parse(process.env.SCREENS ?? "null") ?? [
  ["App shell (/help/roles)", "/help/roles"],
  ["Project List view", `/projects/${P}/views/7acc720e-d8c4-40f7-aa21-644d560ca1f0`],
  ["Project Board view", `/projects/${P}/views/86a72a18-869c-4a4c-a1ae-3d95268d2ca0`],
  ["Project frame (/overview)", `/projects/${P}/overview`],
  ["My tasks", "/my-tasks"],
  ["Home", "/"],
  ["Task pane (/api/task-pane)", "/api/task-pane/c1000000-0000-4000-8000-000000000002"],
];
function stats(calls) {
  calls.sort((a, b) => a.start - b.start);
  const n = calls.length;
  if (!n) return { n: 0, wall: 0, sum: 0, steps: 0 };
  const wall = Math.max(...calls.map((c) => c.end)) - calls[0].start;
  const sum = calls.reduce((s, c) => s + (c.end - c.start), 0);
  // sequential steps = longest chain of calls where each starts after the previous one ended
  const depth = calls.map(() => 1);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (calls[j].end <= calls[i].start + 0.5) depth[i] = Math.max(depth[i], depth[j] + 1);
  return { n, wall, sum, steps: Math.max(...depth) };
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const out = [];
for (const [name, path] of SCREENS) {
  const runs = [];
  let paths = null;
  for (let r = 0; r <= ROUNDS; r++) {
    writeFileSync(TRACE, "");
    const t = performance.now();
    const res = await fetch(BASE + path, { headers: { cookie: cookieHeader() }, redirect: "manual" });
    const body = await res.text();
    const total = performance.now() - t;
    await new Promise((x) => setTimeout(x, 150));
    const calls = existsSync(TRACE) ? readFileSync(TRACE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    if (r === 0) { if (res.status !== 200) console.error(name, res.status, body.slice(0, 300)); continue; }
    runs.push({ ...stats(calls), total, status: res.status });
    paths = calls.map((c) => `${c.method} ${c.path.replace("/rest/v1/", "")}`);
  }
  const row = { screen: name, status: runs[0].status, calls: median(runs.map((r) => r.n)), steps: median(runs.map((r) => r.steps)),
    dbWallMs: +median(runs.map((r) => r.wall)).toFixed(1), dbSumMs: +median(runs.map((r) => r.sum)).toFixed(1), responseMs: +median(runs.map((r) => r.total)).toFixed(0), paths };
  out.push(row);
  console.log(`${name}: ${row.calls} calls, ${row.steps} steps, db wall ${row.dbWallMs} ms, db sum ${row.dbSumMs} ms, response ${row.responseMs} ms`);
}
writeFileSync(`screen-calls-${LABEL}.json`, JSON.stringify(out, null, 2));
