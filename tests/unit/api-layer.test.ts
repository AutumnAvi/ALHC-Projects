// Big move 1: the typed data-access layer (src/lib/api/, docs/design/typed-api-layer.md). Its error
// mapping, its per-context memo, its permission paths against a stand-in Supabase client, the typing of
// its functions, and the boundaries every other file must respect.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createApiContext, read, type ApiContext, type Db } from "@/lib/api/core/context";
import {
  API_ERROR_CODES,
  ApiError,
  NOT_ALLOWED,
  codeOf,
  isApiError,
  readError,
  writeError,
  type ApiErrorCode,
} from "@/lib/api/core/errors";
import { check, checkUpdated, maybe, readInChunks, rows } from "@/lib/api/core/db";
import { actionError, attempt, type ActionResult } from "@/lib/api/core/result";
import { email, id, optionalIsoDate, projectRole, text } from "@/lib/api/core/validate";
import { getProject } from "@/lib/api/projects/queries";
import { getViewer } from "@/lib/api/auth/queries";

// ---- A stand-in Supabase client -----------------------------------------------------------------
// Every builder method chains; awaiting the chain answers with what `answer` returns for the recorded
// call (table or function, then each method with its arguments).

type Call = { target: string; steps: Array<[string, unknown[]]> };
type Answer = { data: unknown; error: { code?: string; message: string; hint?: string | null } | null; count?: number };

function fakeDb(answer: (call: Call) => Answer): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const chain = (call: Call): unknown =>
    new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") {
            const result = answer(call);
            return (resolve: (value: Answer) => unknown) => resolve(result);
          }
          return (...args: unknown[]) => {
            call.steps.push([String(prop), args]);
            return chain(call);
          };
        },
      },
    );
  const start = (target: string) => {
    const call: Call = { target, steps: [] };
    calls.push(call);
    return call;
  };
  const db = {
    from: (table: string) => chain(start(`table:${table}`)),
    rpc: (fn: string, args?: unknown) => {
      const call = start(`rpc:${fn}`);
      call.steps.push(["args", [args]]);
      return chain(call);
    },
    auth: {
      getClaims: async () => ({ data: { claims: { sub: "u1", role: "authenticated", email: "a@example.com" } }, error: null }),
    },
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${p}` } }) }) },
  };
  return { db: db as unknown as Db, calls };
}

const RLS = { code: "42501", message: 'new row violates row-level security policy for table "projects"' };

// ---- Error mapping ------------------------------------------------------------------------------

test("database codes map to the layer's error codes", () => {
  const cases: Array<[string, ApiErrorCode]> = [
    ["42501", "forbidden"],
    ["P0002", "not_found"],
    ["PGRST116", "not_found"],
    ["23514", "invalid"],
    ["22P02", "invalid"],
    ["P0001", "invalid"],
    ["23505", "conflict"],
    ["40001", "conflict"],
    ["57014", "unavailable"],
    ["PGRST003", "unavailable"],
    ["08006", "unavailable"],
    ["PGRST202", "not_deployed"],
    ["42703", "not_deployed"],
    ["PGRST205", "not_deployed"],
    ["PGRST301", "unauthenticated"],
    ["XX000", "failed"],
    ["", "failed"],
  ];
  for (const [code, expected] of cases) assert.equal(codeOf({ code }), expected, code);
  for (const code of cases.map(([, c]) => c)) assert.ok(API_ERROR_CODES.includes(code));
});

test("a write's error reads as before: RLS refusals become the role message, others keep their hint", () => {
  const rls = writeError(RLS);
  assert.ok(isApiError(rls));
  assert.equal(rls.code, "forbidden");
  assert.equal(rls.message, NOT_ALLOWED);
  assert.equal(rls.detail?.code, "42501", "the database's detail stays for logs");
  assert.equal(writeError(RLS, "Only project admins can do that").message, "Only project admins can do that");
  // insufficient_privilege from an RPC's own check keeps its words.
  const rpc = writeError({ code: "42501", message: "Only Editors and above can delete tasks" });
  assert.equal(rpc.code, "forbidden");
  assert.equal(rpc.message, "Only Editors and above can delete tasks");
  const hinted = writeError({ code: "23514", message: "The start date must be on or before the due date", hint: "Pick an earlier start" });
  assert.equal(hinted.code, "invalid");
  assert.equal(hinted.message, "The start date must be on or before the due date. Pick an earlier start");
  assert.equal(readError({ code: "57014", message: "canceling statement due to statement timeout" }, "projects").message,
    "Failed to load projects: canceling statement due to statement timeout");
});

test("check / checkUpdated: an RLS-filtered update (zero rows) is a refusal, never a silent success", () => {
  assert.doesNotThrow(() => check({ error: null }));
  assert.throws(() => check({ error: RLS }), (e: unknown) => isApiError(e) && e.code === "forbidden" && e.message === NOT_ALLOWED);
  assert.doesNotThrow(() => checkUpdated({ error: null, data: [{ id: "p1" }] }));
  assert.throws(
    () => checkUpdated({ error: null, data: [] }, "Only the project’s Owners can delete it"),
    (e: unknown) => isApiError(e) && e.code === "forbidden" && e.message === "Only the project’s Owners can delete it",
  );
  assert.throws(() => checkUpdated({ error: null, data: null }), (e: unknown) => isApiError(e) && e.code === "forbidden");
});

test("maybe / rows: values through, database errors as ApiError", () => {
  assert.deepEqual(rows({ data: null, error: null }, "x"), []);
  assert.equal(maybe({ data: 3, error: null }, "x"), 3);
  assert.throws(() => maybe({ data: null, error: { code: "57014", message: "timeout" } }, "x"), (e: unknown) => isApiError(e) && e.code === "unavailable");
});

test("validators refuse with ApiError('invalid') and the messages people read", () => {
  assert.throws(() => id("nope", "task"), (e: unknown) => isApiError(e) && e.code === "invalid" && e.message === "Invalid task");
  assert.equal(id("00000000-0000-4000-8000-000000000001"), "00000000-0000-4000-8000-000000000001");
  assert.throws(() => text("  ", "Project name"), { message: "Project name can’t be empty" });
  assert.throws(() => text("x".repeat(201), "Project name", { max: 200 }), { message: "Project name is too long" });
  assert.equal(email(" Avi@Example.com "), "avi@example.com");
  assert.throws(() => email("not-an-address"), { message: "Enter a valid email address" });
  assert.equal(optionalIsoDate("", "start date"), null);
  assert.throws(() => optionalIsoDate("2026-13-40", "start date"), { message: "Choose a valid start date" });
  assert.throws(() => projectRole("guest"), { message: "Choose a role" });
});

test("attempt() turns an ApiError into a result and lets a bug through; actionError() is the action's wire shape", async () => {
  const failed = await attempt(async () => {
    throw new ApiError("not_found", "Task not found");
  });
  assert.equal(failed.ok, false);
  const ok = await attempt(async () => 7);
  assert.deepEqual(ok, { ok: true, data: 7 });
  await assert.rejects(attempt(async () => {
    throw new TypeError("a bug");
  }), TypeError);
  const wire: ActionResult = actionError(new ApiError("forbidden", NOT_ALLOWED));
  assert.deepEqual(wire, { error: NOT_ALLOWED, code: "forbidden" });
});

// ---- read(): one answer per context -------------------------------------------------------------

test("read() shares answers within a context like React's cache(), and never across contexts", async () => {
  let loads = 0;
  const load = read(async (_ctx: ApiContext, key: string, list?: string[]) => {
    loads++;
    return `${key}:${list?.length ?? 0}`;
  });
  const { db } = fakeDb(() => ({ data: null, error: null }));
  const render = createApiContext(db, { memo: true });
  const list = ["a", "b"];
  assert.equal(await load(render, "x"), "x:0");
  await load(render, "x");
  await load(render, "x", list);
  await load(render, "x", list);
  assert.equal(loads, 2, "same primitives, same object → one load each");
  await load(render, "x", ["a", "b"]);
  assert.equal(loads, 3, "objects compare by identity");
  await load(createApiContext(db, { memo: true }), "x");
  assert.equal(loads, 4, "another render reads again");
  const action = createApiContext(db);
  await load(action, "x");
  await load(action, "x");
  assert.equal(loads, 6, "a Server Action's context has no memo: a read after a write sees the write");
});

test("read() keeps a rejection for its context (as cache() did)", async () => {
  let loads = 0;
  const failing = read(async () => {
    loads++;
    throw new ApiError("unavailable", "Failed to load x: timeout");
  });
  const ctx = createApiContext(fakeDb(() => ({ data: null, error: null })).db, { memo: true });
  await assert.rejects(failing(ctx));
  await assert.rejects(failing(ctx));
  assert.equal(loads, 1);
});

test("readInChunks reads every chunk, keeps order, and caps what's in flight", async () => {
  const ids = Array.from({ length: 23 }, (_, i) => `t${i}`);
  let inFlight = 0;
  let peak = 0;
  const out = await readInChunks(ids, 2, async (chunk) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return chunk;
  });
  assert.deepEqual(out, ids);
  assert.ok(peak <= 6);
});

// ---- Permission paths through real layer reads -------------------------------------------------

test("a layer read only ever uses the caller's client: no row RLS hides comes back, and nothing else is asked", async () => {
  // RLS hid the project: PostgREST answers no row.
  const hidden = fakeDb(() => ({ data: null, error: null }));
  assert.equal(await getProject(createApiContext(hidden.db), "00000000-0000-4000-8000-0000000000aa"), null);
  assert.ok(hidden.calls.every((c) => c.target === "table:projects"), "only the project read, as the caller");
  // A database error is an ApiError, not a PostgREST shape.
  const broken = fakeDb(() => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }));
  await assert.rejects(getProject(createApiContext(broken.db), "00000000-0000-4000-8000-0000000000aa"), (e: unknown) => isApiError(e) && e.code === "unavailable");
});

test("the viewer comes from the caller's own session and the allowlist check, once per render", async () => {
  const { db, calls } = fakeDb((call) =>
    call.target === "rpc:viewer_member"
      ? { data: { allowlisted: true, profile: { full_name: "Avi", avatar_url: null } }, error: null }
      : { data: null, error: null },
  );
  const ctx = createApiContext(db, { memo: true });
  const [a, b] = await Promise.all([getViewer(ctx), getViewer(ctx)]);
  assert.equal(a, b);
  assert.equal(a.user?.id, "u1");
  assert.equal(a.allowlisted, true);
  assert.equal(calls.filter((c) => c.target === "rpc:viewer_member").length, 1);
});

// ---- Typing (checked by `npm run typecheck`, which includes tests/) --------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type _ContextFirst = Expect<Equal<Parameters<typeof getProject>[0], ApiContext>>;
type _ReadKeepsItsType = Expect<Equal<ReturnType<typeof getProject>, ReturnType<typeof getProject>>>;
type _CodesAreClosed = Expect<Equal<ApiError["code"], ApiErrorCode>>;
type _ActionResultCarriesCode = Expect<Equal<ActionResult["code"], ApiErrorCode | undefined>>;

test("layer functions can't be called without a context (compile-time)", () => {
  // @ts-expect-error the caller's context comes first
  const call = () => getProject("00000000-0000-4000-8000-0000000000aa");
  assert.equal(typeof call, "function");
});

// ---- Boundaries --------------------------------------------------------------------------------

const ROOT = process.cwd();
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const SRC = walk(path.join(ROOT, "src")).filter((f) => !f.endsWith("database.types.ts"));
const LAYER = SRC.filter((f) => rel(f).startsWith("src/lib/api/"));

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

test("the layer is framework-free: no Next.js, React, server-only, client factories, or adapters", () => {
  const banned = [
    /^next(\/|$)/,
    /^react(\/|$)/,
    /^server-only$/,
    /^@\/lib\/supabase\/(server|client|admin|anon-server|anon-browser|proxy)$/,
    /^@\/lib\/server\//,
    /^@\/lib\/(data|auth|screen-loaders|actions)(\/|$)/,
    /^@\/lib\/[a-z-]+-actions$/,
    /^@\/components\//,
    /^@\/app\//,
  ];
  for (const file of LAYER) {
    for (const spec of importsOf(file)) assert.ok(!banned.some((b) => b.test(spec)), `${rel(file)} imports ${spec}`);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!/process\.env/.test(text), `${rel(file)} reads process.env`);
  }
  // …and everything it imports from the rest of src/lib is framework-free too.
  const seen = new Set<string>();
  const visit = (spec: string) => {
    if (!spec.startsWith("@/lib/") || spec.startsWith("@/lib/api/") || seen.has(spec)) return;
    seen.add(spec);
    const file = [".ts", ".tsx"].map((x) => path.join(ROOT, "src", spec.slice(2) + x)).find((f) => fs.existsSync(f));
    assert.ok(file, `${spec} resolves`);
    const text = fs.readFileSync(file!, "utf8");
    assert.ok(!/^import "server-only"|from "next\/|from "react"/m.test(text), `${spec} (imported by the layer) is tied to Next.js`);
    importsOf(file!).forEach(visit);
  };
  for (const file of LAYER) importsOf(file).forEach(visit);
});

test("reads never import writes", () => {
  for (const file of LAYER.filter((f) => f.endsWith("/queries.ts"))) {
    for (const spec of importsOf(file)) assert.ok(!/mutations$/.test(spec), `${rel(file)} imports ${spec}`);
  }
});

test("every exported layer read and write takes the caller's ApiContext first", () => {
  for (const file of LAYER.filter((f) => /\/(queries|mutations)\.ts$/.test(f))) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      let fn: ts.SignatureDeclaration | undefined;
      let name = "";
      if (ts.isFunctionDeclaration(st)) [fn, name] = [st, st.name?.text ?? ""];
      else if (ts.isVariableStatement(st)) {
        const d = st.declarationList.declarations[0];
        name = d.name.getText(sf);
        let init = d.initializer;
        if (init && ts.isCallExpression(init) && init.expression.getText(sf) === "read") init = init.arguments[0];
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) fn = init;
      }
      if (!fn || !/^(async )?/.test(fn.getText(sf))) continue;
      if (!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) continue;
      const first = fn.parameters[0];
      const ok = first && (first.type?.getText(sf) === "ApiContext" || first.type?.getText(sf) === "Db");
      assert.ok(ok, `${rel(file)}#${name} takes the caller's context first`);
    }
  }
});

test("client components import only browser-safe parts of the layer", () => {
  for (const file of SRC) {
    const text = fs.readFileSync(file, "utf8");
    if (!/^["']use client["']/.test(text)) continue;
    for (const spec of importsOf(file)) {
      if (!spec.startsWith("@/lib/api/")) continue;
      const ok =
        /\/model$/.test(spec) ||
        /^@\/lib\/api\/client\//.test(spec) ||
        /^@\/lib\/api\/core\/(errors|result|context)$/.test(spec);
      assert.ok(ok, `${rel(file)} (a client component) imports ${spec}`);
    }
  }
});
