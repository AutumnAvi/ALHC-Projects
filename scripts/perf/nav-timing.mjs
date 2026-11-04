// Click → screen timings for moving between screens (Nov 4 notes, batch 28), on the local stack with a
// production build (`next build && next start`: Next prefetches only in production). Measured in the page,
// from the click event to the first animation frame where the new screen's content is drawn (its marker
// text is there and no skeleton is). Usage:
//   COOKIE=/path/to/session-cookie node scripts/perf/nav-timing.mjs <baseUrl> <label> [rounds]
// COOKIE holds a Supabase session cookie value for perf-seed@example.com (scripts/perf/local-api.mjs cookie).
// Prints JSON: per scenario the median / p95 ms, and server renders (RSC requests that aren't
// prefetches) per click — "blocking" ones the screen waited for, and "background" ones after it was drawn.
//   revisit-my-tasks: My tasks → Home → back to My tasks (sidebar links)
//   revisit-home:     Home → My tasks → back to Home
//   revisit-project:  a project's List → My tasks → back to the project (sidebar)
//   switch-project:   from one project to another in the sidebar, the pointer resting 300 ms first
//   switch-view:      List → Board tab → List tab of a project, the pointer resting 300 ms first
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { chromium } = load(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const BASE = process.argv[2] ?? "http://localhost:3100";
const LABEL = process.argv[3] ?? "run";
const ROUNDS = Number(process.argv[4] ?? 5);
const SEED = "b1000000-0000-4000-8000-000000000001";
// The seed project's List and Board views (ids differ per database: LIST_VIEW / BOARD_VIEW).
const LIST_VIEW = process.env.LIST_VIEW ?? "";
const BOARD_VIEW = process.env.BOARD_VIEW ?? "";
const cookieValue = readFileSync(process.env.COOKIE, "utf8").trim();

const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const p95 = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : null;
};

// Waits in the page for the next click, then for the screen at `path` with `text` and no skeleton.
function probe(page, spec) {
  return page.evaluate(
    (spec) =>
      new Promise((resolve) => {
        let t0 = null;
        const started = performance.now();
        const onClick = (e) => {
          if (t0 === null) t0 = e.timeStamp;
        };
        document.addEventListener("click", onClick, true);
        const ready = () =>
          location.pathname.startsWith(spec.path) &&
          !document.querySelector(".skeleton") &&
          document.body.innerText.includes(spec.text);
        const tick = () => {
          const now = performance.now();
          if (t0 !== null && ready()) {
            document.removeEventListener("click", onClick, true);
            return resolve({ ms: Math.round(now - t0) });
          }
          if (now - started > 20000) return resolve({ timeout: true, at: location.pathname, skeleton: Boolean(document.querySelector(".skeleton")) });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    spec,
  );
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const url = new URL(BASE);
  const chunks = [];
  for (let i = 0; i < cookieValue.length; i += 3180) chunks.push(cookieValue.slice(i, i + 3180));
  await context.addCookies([
    ...(chunks.length === 1
      ? [{ name: "sb-127-auth-token", value: cookieValue }]
      : chunks.map((value, n) => ({ name: `sb-127-auth-token.${n}`, value }))
    ).map((c) => ({ ...c, domain: url.hostname, path: "/" })),
    { name: "tz", value: "UTC", domain: url.hostname, path: "/" },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  const rsc = [];
  page.on("request", (r) => {
    const h = r.headers();
    if ((h["rsc"] === "1" || r.url().includes("_rsc=")) && h["next-router-prefetch"] !== "1") rsc.push(Date.now());
  });
  const projects = await (async () => {
    await page.goto(`${BASE}/my-tasks`, { timeout: 180000 });
    await page.getByText("Everything assigned to you", { exact: false }).first().waitFor({ timeout: 180000 });
    return {
      seed: page.locator(`nav a[href="/projects/${SEED}"]`).first(),
      others: [page.getByRole("link", { name: "Second project 1" }).first(), page.getByRole("link", { name: "Second project 2" }).first()],
    };
  })();
  const sidebar = (name) => page.locator("nav").getByRole("link", { name, exact: true }).first();

  // One measured click: rests the pointer `rest` ms on the link, clicks, waits for the screen; then counts
  // server renders before it was drawn (blocking) and in the 1.5 s after (background).
  async function measure(locator, spec, rest = 60) {
    await locator.hover();
    await page.waitForTimeout(rest);
    const p = probe(page, spec);
    const clickedAt = Date.now();
    await locator.click();
    const r = await p;
    if (r.timeout) console.error("timeout", spec, r);
    const drawnAt = Date.now();
    await page.waitForTimeout(1500);
    return {
      ...r,
      blocking: rsc.filter((t) => t >= clickedAt && t <= drawnAt).length,
      background: rsc.filter((t) => t > drawnAt).length,
    };
  }
  async function go(locator, spec) {
    const p = probe(page, spec);
    await locator.click();
    const r = await p;
    if (r.timeout) console.error("timeout (setup)", spec, r);
    await page.waitForTimeout(400);
  }

  const MY = { path: "/my-tasks", text: "Everything assigned to you" };
  const HOME = { path: "/", text: "My projects" };
  const LIST = { path: `/projects/${SEED}`, text: "Task 5" };
  const results = { "revisit-my-tasks": [], "revisit-home": [], "revisit-project": [], "switch-project": [], "switch-view": [] };
  for (let round = 0; round <= ROUNDS; round += 1) {
    const keep = round > 0; // round 0 warms up
    // Revisit My tasks / Home.
    await page.goto(`${BASE}/my-tasks`);
    await page.getByText(MY.text).first().waitFor({ timeout: 120000 });
    await go(sidebar("Home"), HOME);
    const a = await measure(sidebar("My tasks"), MY);
    const b = await measure(sidebar("Home"), HOME);
    // Revisit a project.
    await go(projects.seed, LIST);
    await go(sidebar("My tasks"), MY);
    const c = await measure(projects.seed, LIST);
    // Switch to a project not opened yet in this tab (fresh page: nothing cached), resting on the link.
    await page.goto(`${BASE}/my-tasks`);
    await page.getByText(MY.text).first().waitFor({ timeout: 120000 });
    const other = projects.others[round % 2];
    const d = await measure(other, { path: "/projects/", text: `Task ${1 + (round % 2)}-5` }, 300);
    // List → Board → List.
    await go(projects.seed, LIST);
    const board = page.getByRole("link", { name: "Board", exact: true }).first();
    const e1 = await measure(board, { path: `/projects/${SEED}/views/${BOARD_VIEW}`, text: "Task 5" }, 300);
    const e2 = await measure(page.getByRole("link", { name: "List", exact: true }).first(), { path: `/projects/${SEED}/views/${LIST_VIEW}`, text: "Task 5" }, 300);
    if (!keep) continue;
    results["revisit-my-tasks"].push(a);
    results["revisit-home"].push(b);
    results["revisit-project"].push(c);
    results["switch-project"].push(d);
    results["switch-view"].push(e1, e2);
  }

  const summary = {};
  for (const [kind, list] of Object.entries(results)) {
    summary[kind] = {
      n: list.length,
      median: median(list.map((r) => r.ms)),
      p95: p95(list.map((r) => r.ms)),
      blockingRenders: median(list.map((r) => r.blocking)),
      backgroundRenders: median(list.map((r) => r.background)),
      timeouts: list.filter((r) => r.timeout).length,
    };
  }
  console.log(JSON.stringify({ label: LABEL, base: BASE, summary, results }, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
