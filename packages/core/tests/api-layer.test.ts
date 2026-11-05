// Big move 1: the typed data-access layer (packages/core/src/api/ since big move 2,
// docs/design/typed-api-layer.md). Its error mapping, its per-context memo, its permission paths against a
// stand-in Supabase client, the typing of its functions, and the layer's own rules (reads never import
// writes, the caller's context first, no client picked). The wall around the whole core package is
// boundaries.test.ts; the web app's side (who may call Supabase, make clients, use the service role) is
// apps/web/tests/unit/api-layer.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createApiContext, read, type ApiContext, type Db } from "@alhc/core/api/core/context";
import {
  API_ERROR_CODES,
  ApiError,
  NOT_ALLOWED,
  codeOf,
  isApiError,
  readError,
  writeError,
  type ApiErrorCode,
} from "@alhc/core/api/core/errors";
import { check, checkUpdated, maybe, readInChunks, rows } from "@alhc/core/api/core/db";
import { actionError, attempt, type ActionResult } from "@alhc/core/api/core/result";
import { email, id, optionalIsoDate, projectRole, text } from "@alhc/core/api/core/validate";
import type { Project } from "@alhc/core/api/projects/model";
import { getProject } from "@alhc/core/api/projects/queries";
import { getViewer } from "@alhc/core/api/auth/queries";

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
  const failing = read(async (ctx: ApiContext) => {
    void ctx;
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

// ---- Typing (checked by `npm run typecheck`, which includes tests/) ---------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
export type TypeChecks = [
  // The caller's context comes first.
  Expect<Equal<Parameters<typeof getProject>[0], ApiContext>>,
  // read() keeps the function's own signature (optional parameters included).
  Expect<Equal<Parameters<typeof getProject>[1], string>>,
  Expect<Equal<Awaited<ReturnType<typeof getProject>>, Project | null>>,
  // Error codes are a closed set, and a Server Action's answer carries one.
  Expect<Equal<ApiError["code"], ApiErrorCode>>,
  Expect<Equal<ActionResult["code"], ApiErrorCode | undefined>>,
];

test("layer functions can't be called without a context (compile-time)", () => {
  // @ts-expect-error the caller's context comes first
  const call = () => getProject("00000000-0000-4000-8000-0000000000aa");
  assert.equal(typeof call, "function");
});

// ---- The layer's own rules -----------------------------------------------------------------------

const SRC = path.resolve(fileURLToPath(new URL("../src", import.meta.url)));
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.ts$/.test(e.name) ? [p] : [];
  });
}
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const LAYER = walk(path.join(SRC, "api"));

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
      let fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
      let name = "";
      if (ts.isFunctionDeclaration(st)) [fn, name] = [st, st.name?.text ?? ""];
      else if (ts.isVariableStatement(st)) {
        const d = st.declarationList.declarations[0];
        name = d.name.getText(sf);
        let init = d.initializer;
        if (init && ts.isCallExpression(init) && init.expression.getText(sf) === "read") init = init.arguments[0];
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) fn = init;
      }
      // Async functions only: the reads and writes (constants and sync helpers are left alone).
      if (!fn || !ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) continue;
      const first = fn.parameters[0];
      // A public, token-checked call may take `ApiContext | null` (null: Supabase isn't set up here).
      const ok = first && /^(ApiContext|Db)( \| null)?$/.test(first.type?.getText(sf) ?? "");
      assert.ok(ok, `${rel(file)}#${name} takes the caller's context first`);
    }
  }
});

test("the layer never picks a client: the caller's context decides who is asking", () => {
  for (const file of LAYER) {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(
      !/\b(adminContext|anonContext|createAdminClient|createAnonServerClient|createClient|createServerClient|createBrowserClient|SUPABASE_SERVICE_ROLE_KEY)\b/.test(text),
      `${rel(file)} picks a client`,
    );
  }
});
