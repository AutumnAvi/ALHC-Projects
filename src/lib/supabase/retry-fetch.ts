// Nov 3 notes (batch 19, 142 / 144): one more try for a database answer that failed for a passing reason,
// so a busy moment doesn't turn a page into "This page couldn't load". The video run's portfolio, search,
// and Reports errors were statements cancelled at the 8-second statement timeout while several
// row-by-row access checks ran at once (batch 18 made those reads fast; this keeps a spike from showing
// as an error).
//
// Retried once, after a short pause:
//   - any request the database refused without doing anything: a statement cancelled (57014, rolled back,
//     so nothing was written) or no connection free in PostgREST's pool (PGRST003);
//   - a read (GET / HEAD) the API gateway answered with 502 / 503 / 504, or that never got an answer.
// Never retried: anything else, and a write that may have reached the database (no answer to a POST).

const RETRY_DELAY_MS = 250;
const TRANSIENT_CODES = new Set(["57014", "PGRST003"]);
const GATEWAY_STATUSES = new Set([502, 503, 504]);

function isRead(init: RequestInit | undefined, input: RequestInfo | URL): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  return method === "GET" || method === "HEAD";
}

// The PostgREST error code of a failed answer, read from a copy (the caller still reads the original).
async function errorCode(response: Response): Promise<string | null> {
  if (response.status < 500) return null;
  try {
    const body = (await response.clone().json()) as { code?: unknown } | null;
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

export function shouldRetry(status: number, code: string | null, read: boolean): boolean {
  if (code && TRANSIENT_CODES.has(code)) return true;
  return read && GATEWAY_STATUSES.has(status);
}

function describe(input: RequestInfo | URL): string {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // The path only (an RPC name or a table), never the query string or a token.
    return url.pathname;
  } catch {
    return "request";
  }
}

export function retryingFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const read = isRead(init, input);
    // A Request body can be read once; a retry needs a fresh copy.
    const retryInput = input instanceof Request ? input.clone() : input;
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      if (!read) throw error;
      console.warn(`[supabase] ${describe(input)} failed (${error instanceof Error ? error.name : "error"}); trying once more`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return base(retryInput, init);
    }
    if (response.ok) return response;
    const code = await errorCode(response);
    if (!shouldRetry(response.status, code, read)) return response;
    console.warn(`[supabase] ${describe(input)} answered ${response.status}${code ? ` ${code}` : ""}; trying once more`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return base(retryInput, init);
  };
}
