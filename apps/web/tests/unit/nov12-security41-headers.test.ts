// Security audit 2 (Nov 12, batch 41): the security headers (security-headers.ts, next.config.ts). Matched
// with Next.js's own route compiler (the one that writes the routes manifest Vercel serves from), so these
// are the headers each path really gets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  CSP_REPORT_PATH,
  enforcedPolicy,
  reportOnlyPolicy,
  securityHeaderRules,
  type HeaderRule,
} from "../../security-headers";
import { createReportLimiter, parseCspReports, sanitizeBlocked, sanitizePath } from "@/lib/csp-report";
import { POST as cspReport } from "@/app/api/csp-report/route";

const require = createRequire(import.meta.url);
const { buildCustomRoute } = require("next/dist/lib/build-custom-route.js") as {
  buildCustomRoute: (type: "header", route: HeaderRule) => { regex: string };
};

const SUPABASE = "https://abcdefghijklmnop.supabase.co";

function headersFor(pathname: string, rules: HeaderRule[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rules) {
    const { regex } = buildCustomRoute("header", rule);
    // Later rules win for the same header (Next.js's documented order).
    if (new RegExp(regex, "i").test(pathname)) for (const h of rule.headers) out.set(h.key.toLowerCase(), h.value);
  }
  return out;
}

const PROD = securityHeaderRules({ supabaseUrl: SUPABASE, dev: false });
const DEV = securityHeaderRules({ supabaseUrl: SUPABASE, dev: true });

const NOT_FRAMEABLE = [
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/my-tasks",
  "/inbox",
  "/projects/0b8c6a4e-1111-4f00-8000-000000000001/views/0b8c6a4e-1111-4f00-8000-000000000002",
  "/admin/users",
  "/review/alhc_rev_0123456789abcdef",
  "/review/alhc_rev_0123456789abcdef/file/0b8c6a4e-1111-4f00-8000-000000000003",
  "/review-files/0b8c6a4e-1111-4f00-8000-000000000003",
  "/email/off",
  "/api/task-pane/0b8c6a4e-1111-4f00-8000-000000000003",
  "/api/inbound/alhc_in_abc",
  "/api/calendar/alhc_cal_abc.ics",
  "/api/csp-report",
  // The AI pilot's pages and APIs (this branch): the MCP endpoint, the assistant, the builder.
  "/api/mcp",
  "/api/ai-assistant/propose",
  "/api/ai-builder/generate",
  "/ai-builder",
  "/settings/mcp",
  "/export/list",
  "/_next/static/chunks/app.js",
  // Close to the frameable paths, but not them.
  "/forms",
  "/forms/abc/embed/more",
  "/forms/abc/other",
  "/attachmentsx",
  "/projects/abc/forms/def",
];

test("every page and API route refuses to be framed, by any site", () => {
  for (const path of NOT_FRAMEABLE) {
    const h = headersFor(path, PROD);
    assert.equal(h.get("x-frame-options"), "DENY", path);
    assert.match(h.get("content-security-policy") ?? "", /(^|; )frame-ancestors 'none'(;|$)/, path);
  }
});

test("the public form pages and the form embed can be framed by any site (no X-Frame-Options)", () => {
  for (const path of ["/forms/0b8c6a4e-1111-4f00-8000-000000000004", "/forms/0b8c6a4e-1111-4f00-8000-000000000004/embed"]) {
    const h = headersFor(path, PROD);
    assert.equal(h.has("x-frame-options"), false, path);
    const csp = h.get("content-security-policy") ?? "";
    assert.match(csp, /(^|; )frame-ancestors \*(;|$)/, path);
    // So marketing-request-forms.vercel.app (and any request hub) can embed it.
    assert.doesNotMatch(csp, /frame-ancestors '(none|self)'/, path);
  }
});

test("attachment previews can be framed by this app only (the approver's review)", () => {
  for (const path of ["/attachments/0b8c6a4e-1111-4f00-8000-000000000005", "/attachments/x"]) {
    const h = headersFor(path, PROD);
    assert.equal(h.get("x-frame-options"), "SAMEORIGIN", path);
    assert.match(h.get("content-security-policy") ?? "", /frame-ancestors 'self'/, path);
  }
  assert.match(
    readFileSync(new URL("../../src/components/task/approver-review.tsx", import.meta.url), "utf8"),
    /<iframe[^>]*src=\{`\/attachments\//,
    "the one iframe the app draws points at /attachments",
  );
});

test("every path: nosniff, the referrer policy, two-year https, the report-only content policy", () => {
  for (const path of [...NOT_FRAMEABLE, "/forms/x", "/forms/x/embed", "/attachments/x"]) {
    const h = headersFor(path, PROD);
    assert.equal(h.get("x-content-type-options"), "nosniff", path);
    assert.equal(h.get("strict-transport-security"), "max-age=63072000; includeSubDomains", path);
    assert.ok(h.get("content-security-policy-report-only"), path);
    assert.ok(h.get("referrer-policy"), path);
    // The enforced policy never restricts how a page loads.
    assert.doesNotMatch(h.get("content-security-policy") ?? "", /script-src|style-src|connect-src|default-src/, path);
  }
  // No preload: that is a one-way commitment for the domain.
  assert.doesNotMatch(JSON.stringify(PROD), /preload/);
});

test("secret links never send a referrer; everything else sends other sites the origin only", () => {
  for (const path of ["/review/alhc_rev_abc", "/review/alhc_rev_abc/file/x", "/email/off", "/api/calendar/alhc_cal_abc.ics"]) {
    assert.equal(headersFor(path, PROD).get("referrer-policy"), "no-referrer", path);
  }
  for (const path of ["/login", "/forms/x/embed", "/my-tasks", "/review-files/x"]) {
    assert.equal(headersFor(path, PROD).get("referrer-policy"), "strict-origin-when-cross-origin", path);
  }
});

test("the report-only policy allows what the app loads today", () => {
  const csp = reportOnlyPolicy({ supabaseUrl: SUPABASE, dev: false });
  const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
  assert.match(directive("connect-src"), new RegExp(`'self' ${SUPABASE} wss://abcdefghijklmnop\\.supabase\\.co`));
  assert.match(directive("script-src"), /'self' 'unsafe-inline' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(directive("script-src"), /'unsafe-eval'/, "no eval in production");
  assert.match(directive("worker-src"), /'self'/);
  assert.match(directive("frame-src"), new RegExp(`'self' ${SUPABASE}`));
  assert.match(directive("media-src"), new RegExp(SUPABASE));
  assert.match(directive("img-src"), /'self' data: blob: https:/);
  assert.equal(directive("object-src"), "object-src 'none'");
  assert.equal(directive("report-uri"), `report-uri ${CSP_REPORT_PATH}`);
  // Dev only: React's eval-based stacks and Speed Insights' debug script; no HSTS from `next dev`.
  assert.match(reportOnlyPolicy({ supabaseUrl: SUPABASE, dev: true }), /'unsafe-eval' https:\/\/va\.vercel-scripts\.com/);
  assert.equal(headersFor("/login", DEV).has("strict-transport-security"), false);
  // Without the address at build time: any Supabase project, never nothing.
  assert.match(reportOnlyPolicy({ supabaseUrl: undefined, dev: false }), /connect-src 'self' https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co/);
  assert.match(reportOnlyPolicy({ supabaseUrl: "not a url", dev: false }), /https:\/\/\*\.supabase\.co/);
});

test("the enforced policy is framing, plugins, and <base> only", () => {
  assert.equal(enforcedPolicy("'none'"), "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  assert.equal(enforcedPolicy("*"), "frame-ancestors *; object-src 'none'; base-uri 'self'");
});

test("next.config.ts turns off X-Powered-By and serves these rules", () => {
  const config = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /poweredByHeader: false/);
  assert.match(config, /securityHeaderRules\(\{\s*supabaseUrl: process\.env\.NEXT_PUBLIC_SUPABASE_URL,/);
});

// The report endpoint (src/app/api/csp-report/route.ts, src/lib/csp-report.ts): small bodies, nothing
// secret kept, rate-limited.

test("a report keeps the directive, the blocked origin, and the page path without ids or tokens", () => {
  const legacy = JSON.stringify({
    "csp-report": {
      "document-uri": "https://alhc-projects.vercel.app/review/alhc_rev_0123456789abcdef0123456789abcdef?file=abc",
      "effective-directive": "img-src",
      "blocked-uri": "https://cdn.example.com/a.png?sig=SECRET",
      "original-policy": "default-src 'self'",
    },
  });
  assert.deepEqual(parseCspReports(legacy), [{ directive: "img-src", blocked: "https://cdn.example.com", page: "/review/:id" }]);
  const reportingApi = JSON.stringify([
    {
      type: "csp-violation",
      body: { documentURL: "https://x.test/projects/0b8c6a4e-1111-4f00-8000-000000000001/views/2", effectiveDirective: "script-src-elem", blockedURL: "inline" },
    },
    { type: "deprecation", body: {} },
  ]);
  assert.deepEqual(parseCspReports(reportingApi), [{ directive: "script-src-elem", blocked: "inline", page: "/projects/:id/views/:id" }]);
  assert.equal(parseCspReports("not json"), null);
  assert.deepEqual(parseCspReports(JSON.stringify({ "csp-report": { "effective-directive": "bad directive; x" } })), []);
  assert.equal(sanitizePath("/email/off?t=0123456789abcdef"), "/email/off");
  assert.equal(sanitizePath("/api/calendar/alhc_cal_abc.ics"), "/api/calendar/:id");
  assert.equal(sanitizeBlocked("data:image/png;base64,AAAA"), "data");
  assert.equal(sanitizeBlocked("wss://abc.supabase.co/realtime/v1/websocket?apikey=KEY"), "wss://abc.supabase.co");
});

test("the endpoint logs each distinct report once a minute, at most 30 lines, and always answers 204", async () => {
  let t = 0;
  const limiter = createReportLimiter(() => t);
  const report = { directive: "img-src", blocked: "https://a.test", page: "/login" };
  assert.equal(limiter(report), true);
  assert.equal(limiter(report), false, "the same line once a minute");
  for (let i = 0; i < 40; i++) limiter({ ...report, page: `/p${i}` });
  assert.equal(limiter({ ...report, page: "/late" }), false, "30 lines a minute at most");
  t = 61_000;
  assert.equal(limiter(report), true, "a new minute");

  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (line: string) => lines.push(line);
  try {
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://x.test/review/alhc_rev_SECRET", "effective-directive": "connect-src", "blocked-uri": "https://evil.test/x?token=SECRET" } });
    const ok = await cspReport(new Request("https://x.test/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report" }, body }));
    assert.equal(ok.status, 204);
    const tooBig = await cspReport(new Request("https://x.test/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report" }, body: "x".repeat(17 * 1024) }));
    assert.equal(tooBig.status, 204);
    const wrongType = await cspReport(new Request("https://x.test/api/csp-report", { method: "POST", headers: { "content-type": "text/plain" }, body }));
    assert.equal(wrongType.status, 204);
  } finally {
    console.warn = warn;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /directive=connect-src blocked=https:\/\/evil\.test page=\/review\/:id$/);
  assert.doesNotMatch(lines.join("\n"), /SECRET/);
  assert.match(readFileSync(new URL("../../src/lib/supabase/proxy.ts", import.meta.url), "utf8"), /"\/api\/csp-report",/);
});
