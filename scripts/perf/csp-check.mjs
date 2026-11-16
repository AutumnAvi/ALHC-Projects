// Nov 16 batch 42 (item 3): loads the key pages of a local production build (`next build && next start` on
// the local stack, scripts/perf/README.md) in headless Chrome and lists every content-policy violation
// (the page's securitypolicyviolation events, console "Refused to …" lines, and POSTs to /api/csp-report),
// plus whether a form embed loads inside another site's frame and an app page doesn't. Local only.
//   COOKIE=… FORM=<live form id> PROJECT=<project id> VIEW=<its List view id> TASK=<a task id> \
//     node scripts/perf/csp-check.mjs http://localhost:3122
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { chromium } = load(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const BASE = process.argv[2] ?? "http://localhost:3122";
const cookieValue = readFileSync(process.env.COOKIE, "utf8").trim();
const { FORM, PROJECT, VIEW, TASK } = process.env;

// Another origin that frames the embed (and, as a control, the sign-in page).
const OTHER_PORT = 3999;
const outside = http
  .createServer((req, res) => {
    const src = req.url === "/login" ? `${BASE}/login` : `${BASE}/forms/${FORM}/embed`;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Outside site</title><iframe id="f" src="${src}" width="800" height="900"></iframe>`);
  })
  .listen(OTHER_PORT, "127.0.0.1");

const RECORD = () => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition, source: e.sourceFile, line: e.lineNumber }),
  );
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const results = [];
  async function visit(context, name, url, { wait = "networkidle", after } = {}) {
    const page = await context.newPage();
    await page.addInitScript(RECORD);
    const consoleLines = [];
    const reports = [];
    page.on("console", (m) => {
      const t = m.text();
      if (/Content.Security.Policy|Refused to/i.test(t)) consoleLines.push(t.slice(0, 300));
    });
    page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message.slice(0, 200)}`));
    page.on("request", (r) => {
      if (r.url().includes("/api/csp-report")) reports.push(r.postData()?.slice(0, 300));
    });
    const response = await page.goto(url, { waitUntil: wait, timeout: 120000 });
    await page.waitForTimeout(1500);
    const extra = after ? await after(page) : undefined;
    await page.waitForTimeout(500);
    const events = await page.evaluate(() => window.__csp ?? []);
    const csp = response?.headers()["content-security-policy"] ?? null;
    results.push({ name, url, status: response?.status(), enforced: Boolean(csp && /script-src/.test(csp)), reportOnly: response?.headers()["content-security-policy-report-only"] ?? null, events, console: consoleLines, reports, extra });
    await page.close();
  }

  // Signed out.
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await visit(anon, "sign-in", `${BASE}/login`);
  await visit(anon, "public form", `${BASE}/forms/${FORM}`);
  await visit(anon, "form embed", `${BASE}/forms/${FORM}/embed`);
  await visit(anon, "form embed framed by another site", `http://127.0.0.1:${OTHER_PORT}/`, {
    after: async (page) => {
      const frame = page.frames().find((f) => f.url().includes("/embed"));
      if (!frame) return { framed: false };
      await frame.waitForLoadState("networkidle").catch(() => {});
      const text = await frame.evaluate(() => document.body.innerText).catch(() => "");
      const inside = await frame.evaluate(() => window.__csp ?? []).catch(() => []);
      return { framed: true, formShown: text.includes("What do you need?"), insideEvents: inside };
    },
  });
  await visit(anon, "sign-in framed by another site (must be refused)", `http://127.0.0.1:${OTHER_PORT}/login`, {
    after: async (page) => {
      const frame = page.frames().find((f) => f.url().includes("/login"));
      const text = frame ? await frame.evaluate(() => document.body.innerText).catch(() => "") : "";
      return { loginShownInFrame: text.includes("Sign in") };
    },
  });

  // Signed in.
  const signedIn = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const url = new URL(BASE);
  await signedIn.addCookies([
    { name: "sb-127-auth-token", value: cookieValue, domain: url.hostname, path: "/" },
    { name: "tz", value: "UTC", domain: url.hostname, path: "/" },
  ]);
  await visit(signedIn, "Home", `${BASE}/`);
  await visit(signedIn, "project List", `${BASE}/projects/${PROJECT}/views/${VIEW}`);
  await visit(signedIn, "task pane", `${BASE}/projects/${PROJECT}/views/${VIEW}?task=${TASK}`);
  await visit(signedIn, "Inbox", `${BASE}/inbox`);
  await visit(signedIn, "My tasks", `${BASE}/my-tasks`);
  // pdf.js's pieces under the policy: its worker (the static file of this site; WORKER = its name in
  // apps/web/public/pdfjs) started as a module worker, a blob: worker, and WebAssembly (JPEG 2000).
  await visit(signedIn, "pdf.js worker + WebAssembly", `${BASE}/`, {
    after: (page) =>
      page.evaluate(async (worker) => {
        const out = {};
        const w = new Worker(`/pdfjs/${worker}`, { type: "module" });
        out.worker = await new Promise((resolve) => {
          w.onerror = (e) => resolve(`error ${e.message || ""}`);
          // pdf.js's worker says "ready" once it has started.
          w.onmessage = (m) => resolve(m.data && m.data.action === "ready" ? "ready" : "answered");
          setTimeout(() => resolve("no answer in 3 s"), 3000);
        });
        w.terminate();
        const bw = new Worker(URL.createObjectURL(new Blob(["postMessage('hi')"], { type: "text/javascript" })));
        out.blobWorker = await new Promise((resolve) => {
          bw.onmessage = (m) => resolve(m.data);
          bw.onerror = () => resolve("error");
          setTimeout(() => resolve("no answer in 2 s"), 2000);
        });
        bw.terminate();
        try {
          await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
          out.wasm = "compiled";
        } catch (e) {
          out.wasm = String(e);
        }
        return out;
      }, process.env.WORKER ?? ""),
  });

  console.log(JSON.stringify(results, null, 1));
  outside.close();
  await browser.close();
})().catch((e) => {
  console.error(e);
  outside.close();
  process.exit(1);
});
