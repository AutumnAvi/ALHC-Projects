// Nov 12 notes, batch 40 (item 7): the smaller speed cleanups. Same pages, less on the first download.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pdfWorkerUrl } from "@/components/review/review-viewer";

const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

test("the browser's Supabase client loads after the first paint (live updates, the unread badge)", () => {
  for (const file of ["lib/live.ts", "components/shell/unread-count.tsx"]) {
    const source = src(file);
    assert.doesNotMatch(source, /from "@\/lib\/supabase\/client"/, file);
    assert.match(source, /loadBrowserClient\(\)/, file);
  }
  const lazy = src("lib/supabase/lazy-client.ts");
  assert.match(lazy, /import\("\.\/client"\)/);
  assert.match(lazy, /^import type \{ createClient \} from "\.\/client";$/m);
});

test("the review viewer's PDF worker is the static copy, named by pdf.js's version, that resolves to a file", () => {
  const require = createRequire(import.meta.url);
  const { version } = require("pdfjs-dist/package.json") as { version: string };
  const url = pdfWorkerUrl(version);
  assert.equal(url, `/pdfjs/pdf.worker.${version}.min.mjs`);
  // What the prebuild step copies is pdf.js's own worker (the file the URL points at once copied).
  const script = readFileSync(new URL("../../scripts/copy-pdf-worker.mjs", import.meta.url), "utf8");
  assert.match(script, /build", "pdf\.worker\.min\.mjs"/);
  assert.ok(existsSync(require.resolve("pdfjs-dist/build/pdf.worker.min.mjs")));
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.prebuild, "node scripts/copy-pdf-worker.mjs");
  assert.equal(pkg.scripts.predev, "node scripts/copy-pdf-worker.mjs");
  // The public review page (no sign-in) reaches it: the proxy skips /pdfjs/ like _next/static.
  assert.match(src("proxy.ts"), /\(\?!_next\/static\|_next\/image\|pdfjs\//);
  // The thumbnail route keeps the server-only legacy build.
  assert.match(src("lib/review-thumbnails.ts"), /pdfjs-dist\/legacy\/build\/pdf\.mjs/);
  assert.doesNotMatch(src("components/review/review-viewer.tsx"), /import\.meta\.url/);
});

test("the move-dependents dialog is its own chunk, fetched when a date change starts", () => {
  const shift = src("components/task/dependency-shift.tsx");
  assert.match(shift, /lazy\(\(\) => loadShiftDialog\(\)/);
  assert.equal((shift.match(/preloadShiftDialog\(\);/g) ?? []).length, 3);
  assert.doesNotMatch(shift, /from "@\/components\/dialog"/);
  assert.match(src("components/task/shift-dialog.tsx"), /export function ShiftDialog/);
});

test("Inbox and Reports take people from the app shell", () => {
  assert.doesNotMatch(src("app/(app)/inbox/page.tsx"), /listProfiles/);
  assert.match(src("app/(app)/inbox/page.tsx"), /loadAppShell\(\)/);
  assert.doesNotMatch(src("components/reports/load-report.ts"), /listProfiles|listVisibleTags/);
  assert.doesNotMatch(src("app/(app)/reports/page.tsx"), /listActivePeople\(\)/);
});
