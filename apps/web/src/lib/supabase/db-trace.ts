// Nov 4 notes (batch 22): an opt-in trace of every Supabase request the server makes, for measuring how
// many calls a screen needs and how long they take (docs/PERF-AUDIT.md, "Screen loaders"). Off unless
// ALHC_DB_TRACE names a file, and never in production; one JSON line per request: start and end in
// milliseconds (performance.now(), so lines from one process compare), the method, and the path — an
// RPC name or a table, never the query string, a header, or a token.
import { appendFileSync } from "node:fs";

const TRACE_FILE = process.env.NODE_ENV === "production" ? undefined : process.env.ALHC_DB_TRACE;

export function tracedFetch(base: typeof fetch): typeof fetch {
  if (!TRACE_FILE) return base;
  const file = TRACE_FILE;
  return async (input, init) => {
    const start = performance.now();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let path = "request";
    try {
      path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    } catch {
      // keep "request"
    }
    try {
      return await base(input, init);
    } finally {
      const end = performance.now();
      try {
        appendFileSync(file, `${JSON.stringify({ start, end, method, path })}\n`);
      } catch {
        // Tracing never breaks a request.
      }
    }
  };
}
