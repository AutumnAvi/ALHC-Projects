// Nov 4 notes, batch 28 (M4): how the client data cache reaches the app's JSON routes. In the browser it is
// same-origin with the person's session cookie (the routes read with their own client; RLS decides). A
// desktop app (Tauri, online-only) configures a base URL and its own auth headers once and reuses every
// fetcher in src/lib/query/.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// The session is gone (the proxy sent the request to the sign-in page).
export class SignedOutError extends Error {
  constructor(readonly location: string) {
    super("Signed out");
    this.name = "SignedOutError";
  }
}

export type Transport = {
  // "" = same origin (the browser).
  baseUrl: string;
  credentials: RequestCredentials;
  headers: () => Record<string, string> | Promise<Record<string, string>>;
  fetch: typeof fetch;
};

let transport: Transport = {
  baseUrl: "",
  credentials: "same-origin",
  headers: () => ({}),
  fetch: (...args) => globalThis.fetch(...args),
};

export function configureTransport(next: Partial<Transport>) {
  transport = { ...transport, ...next };
}

// GET a JSON route. 404 → null when `notFoundAsNull` (a task the person can't open); other non-2xx → HttpError.
export async function getJson<T>(
  path: string,
  { signal, notFoundAsNull = false }: { signal?: AbortSignal; notFoundAsNull?: boolean } = {},
): Promise<T | null> {
  const response = await transport.fetch(`${transport.baseUrl}${path}`, {
    cache: "no-store",
    credentials: transport.credentials,
    headers: { Accept: "application/json", ...(await transport.headers()) },
    signal,
  });
  // Signed out: the proxy redirects page-like requests to the sign-in page.
  if (response.redirected) {
    const at = new URL(response.url, "http://x");
    const asked = new URL(`${transport.baseUrl}${path}`, "http://x");
    if (at.pathname !== asked.pathname) throw new SignedOutError(response.url);
  }
  if (response.status === 404 && notFoundAsNull) return null;
  if (!response.ok) throw new HttpError(response.status, `${path} responded ${response.status}`);
  return (await response.json()) as T;
}
