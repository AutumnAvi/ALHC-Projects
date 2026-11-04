// Big move 1: the typed data-access layer's context. Every function in src/lib/api/ takes one as its first
// argument and reaches the database only through `ctx.db`. No Next.js, React, or "server-only" here: the
// same layer runs in the Next.js server today and in a desktop app (Tauri, online-only) later.
//
// The layer never makes a client. Whoever calls it (a Next.js adapter, a test, a desktop app) chooses
// one, and that choice is the caller's access: the person's own session in the app (RLS decides), a
// cookie-less anon client for public token-checked pages, or the service role for background work an
// adapter runs on purpose (outbox drains). So the layer can't widen anyone's access.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type Db = SupabaseClient<Database>;

export type ApiContext = {
  readonly db: Db;
  // Reads defined with read() share their answers within one context (a server render: the layout, the
  // page, and every read under them — what React's cache() did per read before). Null = every call reads.
  readonly memo: Memo | null;
};

// Same semantics as React's cache(): primitives compare by value, objects and arrays by identity.
type MemoNode = {
  settled: boolean;
  value: unknown;
  primitives: Map<unknown, MemoNode> | null;
  objects: WeakMap<object, MemoNode> | null;
};
export type Memo = WeakMap<object, MemoNode>;

export function createApiContext(db: Db, options: { memo?: boolean } = {}): ApiContext {
  return { db, memo: options.memo ? new WeakMap() : null };
}

function newNode(): MemoNode {
  return { settled: false, value: undefined, primitives: null, objects: null };
}

function child(node: MemoNode, arg: unknown): MemoNode {
  if ((typeof arg === "object" && arg !== null) || typeof arg === "function") {
    node.objects ??= new WeakMap();
    let next = node.objects.get(arg as object);
    if (!next) node.objects.set(arg as object, (next = newNode()));
    return next;
  }
  node.primitives ??= new Map();
  let next = node.primitives.get(arg);
  if (!next) node.primitives.set(arg, (next = newNode()));
  return next;
}

export type Read<A extends unknown[], R> = (ctx: ApiContext, ...args: A) => Promise<R>;

// A read whose answer is shared within the context (see ApiContext.memo). A rejected read stays rejected
// for that context, as with React's cache(). Writes are never defined with read(). Keeps the function's
// own type (optional parameters, defaults) like React's cache() did.
export function read<F extends (ctx: ApiContext, ...args: never[]) => Promise<unknown>>(fn: F): F {
  const call = fn as unknown as (ctx: ApiContext, ...args: unknown[]) => Promise<unknown>;
  const memoized = (ctx: ApiContext, ...args: unknown[]): Promise<unknown> => {
    if (!ctx.memo) return call(ctx, ...args);
    let node = ctx.memo.get(memoized);
    if (!node) ctx.memo.set(memoized, (node = newNode()));
    for (const arg of args) node = child(node, arg);
    if (!node.settled) {
      node.value = call(ctx, ...args);
      node.settled = true;
    }
    return node.value as Promise<unknown>;
  };
  return memoized as unknown as F;
}
