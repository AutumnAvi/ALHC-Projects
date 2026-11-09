// Big move 1 / big move 2: every Supabase call lives in the typed layer, which is the core package's
// src/api/ (@alhc/core/api/…; its own rules and the wall around the package are tested in
// packages/core/tests). This is the web app's side: nothing here calls Supabase but the layer, only the
// Next.js adapters make clients, client components take only the browser-safe parts of the layer, and the
// service role and the anon key stay where they always were.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const SRC = walk(path.join(ROOT, "src"));

function importsOf(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const st of sf.statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

test("the layer lives in the core package, not in the web app", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "src/lib/api")), "apps/web/src/lib/api: the layer is @alhc/core/api/…");
  for (const file of SRC) {
    for (const spec of importsOf(file)) assert.ok(!/^@\/lib\/api(\/|$)/.test(spec), `${rel(file)} imports ${spec}`);
  }
});

test("client components import only browser-safe parts of the layer", () => {
  for (const file of SRC) {
    const text = fs.readFileSync(file, "utf8");
    if (!/^["']use client["']/.test(text)) continue;
    for (const spec of importsOf(file)) {
      if (!spec.startsWith("@alhc/core/api/")) continue;
      const ok =
        /\/model$/.test(spec) ||
        /^@alhc\/core\/api\/client\//.test(spec) ||
        /^@alhc\/core\/api\/core\/(errors|result|context)$/.test(spec);
      assert.ok(ok, `${rel(file)} (a client component) imports ${spec}`);
    }
  }
});

test("every database, storage, and auth call goes through the layer", () => {
  // Two transports aren't data access and stay outside it: the session refresh before every request (the
  // proxy) and the session token Realtime joins with (live.ts, M3).
  const allowed = new Set(["src/lib/supabase/proxy.ts", "src/lib/live.ts"]);
  const call = /\.rpc\(|\.from\(\s*"[a-z_]+"\s*\)|\.storage\b|\bauth\.(get|sign|exchange|update|reset|set|admin|verify|refresh)/;
  for (const file of SRC) {
    const name = rel(file);
    if (allowed.has(name)) continue;
    const text = fs.readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => assert.ok(!call.test(line), `${name}:${i + 1} calls Supabase directly: ${line.trim()}`));
  }
});

test("only the Next.js adapters make server clients; browser clients only in the browser", () => {
  for (const file of SRC) {
    const name = rel(file);
    const text = fs.readFileSync(file, "utf8");
    for (const spec of importsOf(file)) {
      if (/^@\/lib\/supabase\/(server|admin|anon-server)$/.test(spec)) {
        assert.equal(name, "src/lib/server/context.ts", `${name} imports ${spec}: make a context in src/lib/server/context.ts instead`);
      }
      if (/^@\/lib\/supabase\/(client|anon-browser)$/.test(spec)) {
        assert.ok(/^["']use client["']/.test(text) || name === "src/lib/live.ts", `${name} imports ${spec} outside the browser`);
      }
    }
  }
});

// Like suite 60's list of SECURITY DEFINER functions: the places that use the service role or the anon
// key are pinned, so a new one is added here on purpose. The layer never picks a client itself.
test("the service role and the anon key are used only where they always were", () => {
  const users = (fn: string) =>
    SRC.filter((f) => new RegExp(`\\b${fn}\\(`).test(fs.readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => f !== "src/lib/server/context.ts")
      .sort();
  assert.deepEqual(users("adminContext"), [
    "src/app/api/cron/workflows/route.ts", // the scheduler: outbox drains, trash and form-upload cleanup
    "src/app/api/inbound/email/route.ts", // the verified Resend webhook
    "src/app/review/[token]/file/[fileId]/route.ts", // signs a link to the one path the database returned for a token
    "src/lib/actions/review-public.ts", // removes a refused review upload
    "src/lib/actions/slack.ts", // the bot token, after the database confirmed a workspace admin
    "src/lib/email.ts", // the email outbox drain
    "src/lib/integrations.ts", // the Slack / webhook outbox drain
    "src/lib/mcp/auth.ts", // the MCP endpoint's token lookup (mcp_token_verify answers only the owner's id); the call itself runs as that person
  ]);
  assert.deepEqual(users("anonContext"), [
    "src/app/api/calendar/[token]/route.ts",
    "src/app/api/email/unsubscribe/route.ts",
    "src/app/api/inbound/[token]/route.ts",
    "src/app/review/[token]/file/[fileId]/route.ts",
    "src/app/review/[token]/page.tsx",
    "src/lib/actions/review-public.ts",
  ]);
});
