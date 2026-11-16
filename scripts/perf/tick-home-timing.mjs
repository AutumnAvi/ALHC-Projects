// Nov 16 batch 42 (item 1): "tick a task, then go back to Home", on the local stack with a production build
// (scripts/perf/README.md). For each round: open Home, go to a project's List (or My tasks) from the sidebar,
// stay `STAY_MS`, tick the first open task, wait for the save, click Home in the sidebar. Measured in the
// page from the click to the first animation frame where Home is drawn with no skeleton, plus whether a
// skeleton was ever drawn, the server renders it waited for, and whether the ticked task still shows as
// open on Home (it must not). Usage:
//   COOKIE=/path/to/session-cookie node scripts/perf/tick-home-timing.mjs <baseUrl> <label> [rounds]
// Env: FROM=project|my-tasks (default project), PROJECT="Second project 1", STAY_MS (default 40000),
// CLICK_AFTER_MS: click Home this long after the tick instead of after its save settles (a quick click);
// NO_TICK=1: the same moves without the tick (what the router keeps by itself).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { chromium } = load(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const BASE = process.argv[2] ?? "http://localhost:3122";
const LABEL = process.argv[3] ?? "run";
const ROUNDS = Number(process.argv[4] ?? 3);
const FROM = process.env.FROM ?? "project";
const PROJECT = process.env.PROJECT ?? "Second project 1";
const STAY_MS = Number(process.env.STAY_MS ?? 40000);
const cookieValue = readFileSync(process.env.COOKIE, "utf8").trim();

const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function probeHome(page, title) {
  return page.evaluate(
    (title) =>
      new Promise((resolve) => {
        let t0 = null;
        let sawSkeleton = false;
        const started = performance.now();
        const onClick = (e) => {
          if (t0 === null) t0 = e.timeStamp;
        };
        document.addEventListener("click", onClick, true);
        const ready = () => location.pathname === "/" && !document.querySelector(".skeleton") && document.body.innerText.includes("My projects");
        const tick = () => {
          const now = performance.now();
          if (t0 !== null && location.pathname === "/" && document.querySelector(".skeleton")) sawSkeleton = true;
          if (t0 !== null && ready()) {
            document.removeEventListener("click", onClick, true);
            // The ticked task must not be offered as open on Home.
            const open = [...document.querySelectorAll('[role="checkbox"][aria-checked="false"]')].some((el) =>
              (el.getAttribute("aria-label") ?? "").includes(`“${title}”`),
            );
            return resolve({ ms: Math.round(now - t0), skeleton: sawSkeleton, stillOpen: open });
          }
          if (now - started > 30000) return resolve({ timeout: true });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    title,
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
    if (h["rsc"] === "1" || r.url().includes("_rsc=")) rsc.push({ at: Date.now(), prefetch: h["next-router-prefetch"] === "1", url: r.url() });
  });
  const sidebar = (name) => page.locator("nav").getByRole("link", { name, exact: true }).first();
  const results = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    await page.goto(`${BASE}/`, { timeout: 180000 });
    await page.getByText("My projects").first().waitFor({ timeout: 180000 });
    await page.waitForTimeout(500);
    if (FROM === "my-tasks") {
      await sidebar("My tasks").click();
      await page.getByText("Everything assigned to you").first().waitFor({ timeout: 60000 });
    } else {
      await page.getByRole("link", { name: PROJECT }).first().click();
      await page.getByRole("checkbox", { name: /^Mark “.*” complete$/ }).first().waitFor({ timeout: 60000 });
    }
    await page.waitForTimeout(STAY_MS);
    const box = page.getByRole("checkbox", { name: /^Mark “.*” complete$/ }).first();
    const name = (await box.getAttribute("aria-label")) ?? "";
    const title = name.replace(/^Mark “/, "").replace(/” complete$/, "");
    const tickAt = Date.now();
    if (!process.env.NO_TICK) await box.click();
    if (process.env.CLICK_AFTER_MS) await page.waitForTimeout(Number(process.env.CLICK_AFTER_MS));
    else {
      // The save (a server action POST) and anything it sets off.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(800);
    }
    const afterTick = rsc.filter((r) => r.at >= tickAt);
    const home = sidebar("Home");
    await home.hover();
    await page.waitForTimeout(60);
    const p = probeHome(page, title);
    const clickedAt = Date.now();
    await home.click();
    const r = await p;
    const drawnAt = Date.now();
    await page.waitForTimeout(1500);
    results.push({
      ...r,
      title,
      renderAfterTick: afterTick.filter((x) => !x.prefetch).length,
      prefetchAfterTick: afterTick.filter((x) => x.prefetch).length,
      blocking: rsc.filter((x) => !x.prefetch && x.at >= clickedAt && x.at <= drawnAt).length,
      background: rsc.filter((x) => !x.prefetch && x.at > drawnAt).length,
    });
  }
  console.log(
    JSON.stringify(
      { label: LABEL, from: FROM, stayMs: STAY_MS, median: median(results.map((r) => r.ms)), skeletons: results.filter((r) => r.skeleton).length, stillOpen: results.filter((r) => r.stillOpen).length, results },
      null,
      1,
    ),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
