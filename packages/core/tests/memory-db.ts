// A small in-memory stand-in for the Supabase client, for layer tests that write and read back (the AI
// assistant's apply and Undo). Tables are arrays of rows; select / insert / update / upsert with eq, is,
// in, lt, or (simple "col.eq.value" lists), order, limit, single, maybeSingle, count (head), and one level
// of `name:table!inner(…)` joins on <table>_id. RPCs are functions the test supplies. No RLS: tests that
// need a refusal script it (`refuse`).
import type { Db } from "@alhc/core/api/core/context";

type Row = Record<string, unknown>;
type Err = { code?: string; message: string } | null;
export type MemoryState = Record<string, Row[]>;
export type Refuse = (table: string, kind: string, row: Row) => Err;
export type Rpc = (args: Record<string, unknown>, state: MemoryState) => { data?: unknown; error?: Err };

type Filter = (row: Row) => boolean;

const value = (row: Row, col: string) => {
  const [a, b] = col.split(".");
  if (b === undefined) return row[a];
  const joined = row[a];
  return joined && typeof joined === "object" ? (joined as Row)[b] : undefined;
};

let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

export function memoryDb(
  state: MemoryState,
  opts: { rpcs?: Record<string, Rpc>; refuse?: (table: string, kind: string, row: Row) => Err; log?: string[]; defaults?: Record<string, Row> } = {},
): Db {
  const joins = (table: string, select: string | undefined, row: Row): Row => {
    if (!select) return row;
    const out = { ...row };
    for (const m of select.matchAll(/(?:(\w+):)?(\w+)!inner\(/g)) {
      const alias = m[1] ?? m[2];
      const other = m[2];
      const key = `${other.replace(/s$/, "")}_id`;
      out[alias] = (state[other] ?? []).find((r) => r.id === row[key]) ?? null;
    }
    void table;
    return out;
  };

  const builder = (table: string) => {
    let kind: "select" | "insert" | "update" | "upsert" = "select";
    let payload: Row | Row[] | null = null;
    let selectCols: string | undefined;
    let countHead = false;
    let onConflict: string[] = [];
    const filters: Filter[] = [];
    const orderBy: [string, boolean][] = [];
    let limit: number | null = null;
    let mode: "many" | "single" | "maybe" = "many";
    let returning = false;

    const run = (): { data: unknown; error: Err; count?: number } => {
      const rows = (state[table] ??= []);
      opts.log?.push(`${kind}:${table}`);
      if (kind === "insert" || kind === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload!];
        const out: Row[] = [];
        for (const r of list) {
          const err = opts.refuse?.(table, kind, r);
          if (err) return { data: null, error: err };
          const existing = kind === "upsert" && onConflict.length ? rows.find((x) => onConflict.every((k) => x[k] === r[k])) : undefined;
          if (existing) {
            Object.assign(existing, r);
            out.push(existing);
          } else {
            const row = { id: newId(), deleted_at: null, ...(opts.defaults?.[table] ?? {}), ...r };
            rows.push(row);
            out.push(row);
          }
        }
        return finish(out);
      }
      let matched = rows.map((r) => joins(table, selectCols, r)).filter((r) => filters.every((f) => f(r)));
      if (kind === "update") {
        const out: Row[] = [];
        for (const r of matched) {
          const original = r;
          const err = opts.refuse?.(table, "update", { ...original, ...(payload as Row) });
          if (err) return { data: null, error: err };
          Object.assign(original, payload);
          out.push(original);
        }
        return finish(out);
      }
      for (const [col, asc] of [...orderBy].reverse()) {
        matched = [...matched].sort((a, b) => {
          const x = value(a, col) as number | string | null;
          const y = value(b, col) as number | string | null;
          if (x === y) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      if (countHead) return { data: null, error: null, count: matched.length };
      if (limit !== null) matched = matched.slice(0, limit);
      return finish(matched);
    };
    const finish = (out: Row[]) => {
      if (kind !== "select" && !returning && mode === "many") return { data: null, error: null };
      if (mode === "single") return out[0] ? { data: out[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
      if (mode === "maybe") return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    };

    const api: Record<string, unknown> = {
      select(cols?: string, o?: { count?: string; head?: boolean }) {
        if (kind === "select") selectCols = cols;
        else returning = true;
        if (o?.head) countHead = true;
        return api;
      },
      insert(p: Row | Row[]) {
        kind = "insert";
        payload = p;
        return api;
      },
      update(p: Row) {
        kind = "update";
        payload = p;
        return api;
      },
      upsert(p: Row, o?: { onConflict?: string }) {
        kind = "upsert";
        payload = p;
        onConflict = (o?.onConflict ?? "").split(",").filter(Boolean);
        return api;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => value(r, col) === v);
        return api;
      },
      neq(col: string, v: unknown) {
        filters.push((r) => value(r, col) !== v);
        return api;
      },
      is(col: string, v: unknown) {
        filters.push((r) => (v === null ? value(r, col) == null : value(r, col) === v));
        return api;
      },
      in(col: string, list: unknown[]) {
        filters.push((r) => list.includes(value(r, col)));
        return api;
      },
      ilike(col: string, pattern: string) {
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "i");
        filters.push((r) => re.test(String(value(r, col) ?? "")));
        return api;
      },
      not(col: string, op: string, v: unknown) {
        filters.push((r) => (op === "is" && v === null ? value(r, col) != null : value(r, col) !== v));
        return api;
      },
      lt(col: string, v: number) {
        filters.push((r) => (value(r, col) as number) < v);
        return api;
      },
      or(expr: string) {
        const parts = expr.split(",").map((p) => p.split(".eq."));
        filters.push((r) => parts.some(([c, v]) => String(value(r, c)) === v));
        return api;
      },
      order(col: string, o?: { ascending?: boolean }) {
        orderBy.push([col, o?.ascending !== false]);
        return api;
      },
      limit(n: number) {
        limit = n;
        return api;
      },
      single() {
        mode = "single";
        return api;
      },
      maybeSingle() {
        mode = "maybe";
        return api;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        try {
          return Promise.resolve(run()).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    return api;
  };

  return {
    from: (table: string) => builder(table),
    rpc: (fn: string, args: Record<string, unknown> = {}) => {
      opts.log?.push(`rpc:${fn}`);
      const handler = opts.rpcs?.[fn];
      const res = handler ? handler(args, state) : { data: null, error: { code: "PGRST202", message: `no ${fn}` } };
      return Promise.resolve({ data: res.data ?? null, error: res.error ?? null });
    },
  } as unknown as Db;
}
