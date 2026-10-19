// Click → task pane timings on the local stack, measured in the page (event timestamp → the first
// animation frame where the condition holds). Usage: node scripts/perf/pane-timing.mjs <baseUrl> <label> [rounds]
// (signed in as perf-seed@example.com / local-password on scripts/perf/seed.sql + seed-pane.sql; prints JSON)
//   open:   frame = [data-task-pane] attached; named = the pane shows the task's name; ready = the full
//           detail (the editable #task-title) is mounted
//   close:  the pane's close button → no [data-task-pane]
//   switch: with a pane open, click another row's open link → title / ready of the new task
//   subtask: in the pane of Task N, click "Open subtask …" → title / ready of the subtask
// Also counts RSC requests (server renders of the page) per action.
import { createRequire } from "node:module";

// PLAYWRIGHT_CORE = a path to playwright-core when it isn't installed here (it isn't a dependency).
const load = createRequire(import.meta.url);
const { chromium } = load(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const BASE = process.argv[2] ?? "http://localhost:3100";
const LABEL = process.argv[3] ?? "run";
const ROUNDS = Number(process.argv[4] ?? 1);
const PROJECT = "b1000000-0000-4000-8000-000000000001";

function median(xs) {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function p95(xs) {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

// In the page: wait for the trigger event (click / Escape keydown, capture phase), then poll every
// animation frame for each named condition; resolve with ms from the event for each.
function probe(page, spec) {
  return page.evaluate(
    (spec) =>
      new Promise((resolve) => {
        const out = {};
        let t0 = null;
        const started = performance.now();
        const onEvent = (e) => {
          if (t0 !== null) return;
          if (spec.trigger === "escape" && !(e.type === "keydown" && e.key === "Escape")) return;
          if (spec.trigger === "click" && e.type !== "click") return;
          t0 = e.timeStamp;
        };
        document.addEventListener("click", onEvent, true);
        document.addEventListener("keydown", onEvent, true);
        const pane = () => document.querySelector("[data-task-pane]");
        const checks = {
          frame: () => Boolean(pane()),
          named: () => {
            const p = pane();
            if (!p) return false;
            const ta = p.querySelector("#task-title");
            return (
              (ta && ta.value === spec.title) ||
              (p.getAttribute("aria-label") ?? "").includes(spec.title) ||
              [...p.querySelectorAll("h1,h2,p,span,div")].some((el) => el.childElementCount === 0 && el.textContent.trim() === spec.title)
            );
          },
          ready: () => {
            const ta = pane()?.querySelector("#task-title");
            return Boolean(ta && ta.value === spec.title);
          },
          closed: () => !pane(),
        };
        const tick = () => {
          const now = performance.now();
          if (t0 !== null) {
            for (const name of spec.wait) {
              if (out[name] === undefined && checks[name]()) out[name] = Math.round(now - t0);
            }
            if (spec.wait.every((n) => out[n] !== undefined)) {
              document.removeEventListener("click", onEvent, true);
              document.removeEventListener("keydown", onEvent, true);
              return resolve(out);
            }
          }
          if (now - started > 60000) return resolve({ ...out, timeout: true });
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
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  let rsc = 0;
  page.on("request", (r) => {
    const h = r.headers();
    if (h["rsc"] === "1" || r.url().includes("_rsc=")) {
      if (h["next-router-prefetch"] !== "1") rsc += 1;
    }
  });

  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', "perf-seed@example.com");
  await page.fill('input[name="password"]', "local-password");
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120000 }), page.click('button[type="submit"]')]);
  await page.goto(`${BASE}/projects/${PROJECT}`, { timeout: 180000 });
  await page.getByText("Task 5", { exact: true }).first().waitFor({ timeout: 180000 });
  await page.waitForTimeout(1500);

  const openLink = (title) => page.getByRole("link", { name: `Open “${title}”` }).first();
  async function hoverThenClick(locator) {
    // A person moves the pointer onto the row before clicking (prefetch on hover gets that time).
    await locator.hover({ force: true });
    await page.waitForTimeout(150);
    await locator.click({ force: true });
  }
  async function closePane() {
    if (!(await page.locator("[data-task-pane]").count())) return null;
    const before = rsc;
    const p = probe(page, { trigger: "click", wait: ["closed"] });
    await page.locator('[data-task-pane] [aria-label="Close task details"]').first().click({ force: true });
    const r = await p;
    await page.waitForTimeout(400);
    return { ...r, rsc: rsc - before };
  }

  // Warm-up (first open compiles nothing in `next start`, but warms caches).
  {
    const p = probe(page, { trigger: "click", title: "Task 3", wait: ["ready"] });
    await hoverThenClick(openLink("Task 3"));
    await p;
    await closePane();
  }

  const results = { open: [], close: [], switch: [], subtask: [] };
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const n of [5, 6, 7, 8, 9, 10, 11, 12]) {
      const title = `Task ${n + round * 40}`;
      const before = rsc;
      const p = probe(page, { trigger: "click", title, wait: ["frame", "named", "ready"] });
      await hoverThenClick(openLink(title));
      const r = await p;
      await page.waitForTimeout(300);
      results.open.push({ title, ...r, rsc: rsc - before });
      const c = await closePane();
      results.close.push({ title, ...c });
    }
    // Switch between tasks with the pane open.
    {
      const first = `Task ${22 + round * 40}`;
      const p0 = probe(page, { trigger: "click", title: first, wait: ["ready"] });
      await hoverThenClick(openLink(first));
      await p0;
      await page.waitForTimeout(300);
      for (const n of [23, 24, 25, 26, 27]) {
        const title = `Task ${n + round * 40}`;
        const before = rsc;
        const p = probe(page, { trigger: "click", title, wait: ["named", "ready"] });
        await hoverThenClick(openLink(title));
        const r = await p;
        await page.waitForTimeout(300);
        results.switch.push({ title, ...r, rsc: rsc - before });
      }
      await closePane();
    }
    // Open a subtask from the pane.
    for (const n of [2, 3, 4, 5, 6]) {
      const parent = `Task ${n}`;
      const p0 = probe(page, { trigger: "click", title: parent, wait: ["ready"] });
      await hoverThenClick(openLink(parent));
      await p0;
      await page.waitForTimeout(300);
      const title = `Task ${n} step ${1 + round}`;
      const before = rsc;
      const p = probe(page, { trigger: "click", title, wait: ["named", "ready"] });
      await hoverThenClick(page.getByRole("link", { name: `Open subtask ${title}` }).first());
      const r = await p;
      await page.waitForTimeout(300);
      results.subtask.push({ title, ...r, rsc: rsc - before });
      await closePane();
    }
  }

  const summary = {};
  for (const [kind, list] of Object.entries(results)) {
    const keys = [...new Set(list.flatMap((r) => Object.keys(r)).filter((k) => !["title", "timeout"].includes(k)))];
    summary[kind] = Object.fromEntries(keys.map((k) => [k, { median: median(list.map((r) => r[k])), p95: p95(list.map((r) => r[k])) }]));
    summary[kind].n = list.length;
    summary[kind].timeouts = list.filter((r) => r.timeout).length;
  }
  console.log(JSON.stringify({ label: LABEL, base: BASE, summary, results }, null, 1));
  await page.screenshot({ path: `/tmp/oct19/stack/run/pane-${LABEL}.png` });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
