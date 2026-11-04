// Nov 4 notes, batch 21 (efficiency quick wins QW1–QW5 and note 153).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MentionTextarea } from "@/components/task/mention-textarea";
import {
  CHIP_CLOSE,
  CHIP_OPEN,
  NO_CHIP_LINKS,
  addChipLink,
  bodyToDisplay,
  caretAfterTidy,
  chipRanges,
  chipText,
  displayPieces,
  displayToBody,
  removeChipAt,
  seedChipLinks,
  snapCaret,
} from "@/lib/link-chips";
import { thumbnailRouteOrigin } from "@/lib/review-thumbnail-request";
import { parseThumbnailResponse } from "@/lib/review-thumbnail-shared";

const TASK = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const TASK_URL = `https://alhc.example/projects/${PROJECT}?task=${TASK}`;
const PROJECT_URL = `https://alhc.example/projects/${PROJECT}`;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

// ---- 153 ----------------------------------------------------------------------------------------

test("153: a picked link is its name in the box and its link in the body", () => {
  const { links, label } = addChipLink(NO_CHIP_LINKS, TASK_URL, "Facility Launch Party");
  assert.equal(label, "Facility Launch Party");
  const display = `See ${chipText(label)} today`;
  const body = displayToBody(display, links);
  assert.equal(body, `See ${TASK_URL} today`, "what's saved keeps the link");
  assert.equal(bodyToDisplay(body, links), display, "and the box shows the name again");
  assert.ok(!display.includes("https://"), "never the raw link in the box");
  assert.deepEqual(chipRanges(display), [{ start: 4, end: 4 + label.length + 2, label }]);
});

test("153: two links with the same name stay apart; a known link keeps its name", () => {
  const first = addChipLink(NO_CHIP_LINKS, TASK_URL, "Flyer");
  const second = addChipLink(first.links, PROJECT_URL, "Flyer");
  assert.equal(second.label, "Flyer (2)");
  assert.equal(addChipLink(second.links, TASK_URL, "Other").label, "Flyer");
  const display = `${chipText("Flyer")} and ${chipText("Flyer (2)")}`;
  assert.equal(displayToBody(display, second.links), `${TASK_URL} and ${PROJECT_URL}`);
});

test("153: a cut chip becomes plain text; stray marks never reach the body", () => {
  const { links } = addChipLink(NO_CHIP_LINKS, TASK_URL, "Flyer");
  assert.equal(displayToBody(`${CHIP_OPEN}Fly`, links), "Fly");
  assert.equal(displayToBody(`${CHIP_OPEN}Flier${CHIP_CLOSE}`, links), "Flier", "a renamed chip isn't the link");
  const raw = `a ${CHIP_OPEN}Fly x`;
  const tidied = bodyToDisplay(displayToBody(raw, links), links);
  assert.equal(tidied, "a Fly x");
  assert.equal(caretAfterTidy(raw, tidied, raw.length), tidied.length);
  assert.equal(caretAfterTidy(raw, tidied, 3), 2, "the removed mark before the caret");
});

test("153: the caret skips a chip, and Backspace / Delete remove it whole", () => {
  const display = `x ${chipText("Flyer")} y`;
  const [chip] = chipRanges(display);
  assert.equal(snapCaret(display, chip.start + 2, chip.start), chip.end, "moving right: to its end");
  assert.equal(snapCaret(display, chip.start + 2, chip.end), chip.start, "moving left: to its start");
  assert.equal(snapCaret(display, 0, null), 0);
  assert.deepEqual(removeChipAt(display, chip.end, "Backspace"), { display: "x  y", caret: 2 });
  assert.deepEqual(removeChipAt(display, chip.start, "Delete"), { display: "x  y", caret: 2 });
  assert.equal(removeChipAt(display, 1, "Backspace"), null);
  assert.deepEqual(
    displayPieces(display).map((p) => p.type),
    ["text", "chip", "text"],
  );
});

test("153: editing text that already links opens with chips for the names the reader knows", () => {
  const links = seedChipLinks(`see ${TASK_URL} and ${PROJECT_URL}`, (link) => (link.kind === "task" ? "Flyer" : null));
  assert.equal(bodyToDisplay(`see ${TASK_URL} and ${PROJECT_URL}`, links), `see ${chipText("Flyer")} and ${PROJECT_URL}`);
});

test("153: the comment box draws the chip, never the raw link", () => {
  const html = renderToStaticMarkup(
    <MentionTextarea
      value={`Look at ${TASK_URL} `}
      onValueChange={() => {}}
      candidates={[]}
      links
      linkRefs={{ tasks: { [TASK]: { title: "Facility Launch Party" } }, projects: {} } as never}
    />,
  );
  assert.ok(!html.includes("https://"), "no link text anywhere in the box");
  assert.match(html, /data-link-chip=""[^>]*>[^<]*Facility Launch Party/);
  assert.match(html, /-webkit-text-fill-color:transparent/, "the layer draws the text");
  const plain = renderToStaticMarkup(<MentionTextarea value="Hello" onValueChange={() => {}} candidates={[]} links />);
  assert.ok(!plain.includes("data-link-chip-layer"), "no layer without a chip");
});

// ---- QW1 ----------------------------------------------------------------------------------------

test("QW1: no 'is the migration applied' probes run on page loads", () => {
  const probes = /has(Batch4|Batch5|Real[1-4]|AutomationsV[23]|Oct25|Oct26Batch4)Schema/;
  for (const file of walk("src")) assert.doesNotMatch(fs.readFileSync(file, "utf8"), probes, file);
});

// ---- QW2 ----------------------------------------------------------------------------------------

test("QW2: the viewer comes from the locally verified token; getUser() only where a fresh check matters", () => {
  // Big move 1: who the caller is lives in the data-access layer (src/lib/auth.ts binds it).
  const auth = fs.readFileSync("src/lib/api/auth/queries.ts", "utf8");
  assert.match(auth, /auth\.getClaims\(\)/);
  assert.match(auth, /rpc\("is_allowlisted"\)/, "the allowlist is still asked on every request");
  const callers = walk("src").filter((f) => /auth\.getUser\(/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(callers.map((f) => f.split(path.sep).join("/")), ["src/app/reset-password/actions.ts"]);
});

// ---- QW3 ----------------------------------------------------------------------------------------

test("QW3: only the thumbnail route loads pdf.js and Skia", () => {
  const importers = walk("src").filter((f) => /from "@\/lib\/review-thumbnails"/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(importers.map((f) => f.split(path.sep).join("/")), ["src/app/api/review-thumbnails/route.ts"]);
  const config = fs.readFileSync("next.config.ts", "utf8");
  assert.doesNotMatch(config, /"\/\*": \["node_modules\/pdfjs-dist\/standard_fonts/, "fonts no longer ship with every route");
  assert.match(config, /"\/api\/review-thumbnails": \["node_modules\/pdfjs-dist\/standard_fonts/);
});

test("QW3: the hop stays on this app's own hosts", () => {
  const env = { VERCEL: "1", VERCEL_URL: "alhc-git-x.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "alhc-projects.vercel.app" };
  assert.equal(thumbnailRouteOrigin("alhc-projects.vercel.app", "https", env), "https://alhc-projects.vercel.app");
  assert.equal(thumbnailRouteOrigin("evil.example", "https", env), "https://alhc-git-x.vercel.app", "never a forged host");
  assert.equal(thumbnailRouteOrigin("localhost:3000", "http", env), "https://alhc-git-x.vercel.app", "no localhost on Vercel");
  assert.equal(thumbnailRouteOrigin("localhost:3000", null, {}), "http://localhost:3000");
  assert.equal(thumbnailRouteOrigin("evil.example", "https", {}), null);
});

test("QW3: thumbnail answers are read defensively", () => {
  const map = parseThumbnailResponse({
    thumbnails: { a: { url: "https://x.supabase.co/s", width: 1200, height: 900 }, b: { url: "javascript:x" }, c: null },
  });
  assert.deepEqual([...map.keys()], ["a"]);
  assert.deepEqual(map.get("a"), { url: "https://x.supabase.co/s", width: 1200, height: 900 });
  assert.equal(parseThumbnailResponse(null).size, 0);
});

// ---- QW4 ----------------------------------------------------------------------------------------

test("QW4: channels join with the session token; the badge polls only while Realtime isn't live", () => {
  // Since Nov 4 notes (batch 26) the channels live in src/lib/live.ts (Broadcast); the join rule stays.
  const realtime = fs.readFileSync("src/lib/live.ts", "utf8");
  assert.match(realtime, /auth\.getSession\(\)/);
  assert.match(realtime, /realtime\.setAuth\(\)/);
  const unread = fs.readFileSync("src/components/shell/unread-count.tsx", "utf8");
  assert.match(unread, /status === "live"[\s\S]*stopPolling\(\)/);
});

// ---- QW5 ----------------------------------------------------------------------------------------

test("QW5: the migration adds covering indexes by the advisor's rule, additive only", () => {
  const sql = fs.readFileSync("supabase/migrations/20261104020000_nov4_batch21_a.sql", "utf8");
  assert.doesNotMatch(sql, /\b(drop|delete)\b/i);
  assert.match(sql, /create index if not exists/);
  assert.match(sql, /indisvalid/);
});

// ---- Bonus --------------------------------------------------------------------------------------

test("Bonus: Speed Insights in the root layout", () => {
  const layout = fs.readFileSync("src/app/layout.tsx", "utf8");
  assert.match(layout, /from "@vercel\/speed-insights\/next"/);
  assert.match(layout, /<SpeedInsights \/>/);
});
