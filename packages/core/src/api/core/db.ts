// Big move 1: the small helpers every layer function uses to read a Supabase answer. They turn the
// { data, error } shape into a value or an ApiError (errors.ts), so callers never see PostgREST shapes.
import { ApiError, NOT_ALLOWED, readError, writeError, type DbErrorDetail } from "./errors";

export type QueryResult<T> = { data: T; error: DbErrorDetail | null };

// A read's value; a database error throws ("Failed to load <what>: …").
export function maybe<T>(result: QueryResult<T>, what: string): T {
  if (result.error) throw readError(result.error, what);
  return result.data;
}

// A read's rows (null = none).
export function rows<T>(result: QueryResult<T[] | null>, what: string): T[] {
  return maybe(result, what) ?? [];
}

// A write's answer: a database error throws with the message people read (RLS refusals → `notAllowed`).
export function check(result: { error: DbErrorDetail | null }, notAllowed = NOT_ALLOWED): void {
  if (result.error) throw writeError(result.error, notAllowed);
}

// RLS turns a forbidden UPDATE into "0 rows" rather than an error; use with .select("id").
export function checkUpdated(result: { error: DbErrorDetail | null; data: unknown[] | null }, notAllowed = NOT_ALLOWED): void {
  check(result, notAllowed);
  if (!result.data?.length) throw new ApiError("forbidden", notAllowed);
}

// A database function this release calls isn't there (yet).
export function rpcMissing(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

// Postgres "undefined column": a column this release reads hasn't been migrated yet.
export function isMissingColumn(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42703";
}

// Nov 3 notes (batch 18, 135): reads of "these ids" in chunks (PostgREST puts .in() lists in the URL, so a
// chunk stays a few hundred ids), all chunks at once (at most READ_CONCURRENCY in flight) instead of one
// after another.
export const READ_CONCURRENCY = 6;

export async function readInChunks<T>(ids: readonly string[], size: number, read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  const results: T[][] = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const index = next++;
      results[index] = await read(chunks[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, chunks.length) }, worker));
  return results.flat();
}

export const nowIso = () => new Date().toISOString();
