// Security audit 2 (Nov 12, batch 41): what POST /api/csp-report keeps from a browser's report of the
// report-only content policy (security-headers.ts). Browsers send it with the page's own URL and the
// blocked URL in full, and either can carry a secret (a review link's token, a signed file link), so only
// this survives: the directive, the blocked origin (or a keyword such as "inline"), and the page's path with
// every id-like segment replaced. Nothing is stored; a summary line goes to the server log, at most
// REPORT_LOG_LIMIT a minute per server instance, each distinct line once a minute.

export const MAX_REPORT_BYTES = 16 * 1024;
export const REPORT_LOG_LIMIT = 30;
const WINDOW_MS = 60_000;

export type CspReportSummary = { directive: string; blocked: string; page: string };

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

// "views", "settings", "embed" stay; ids, tokens, numbers, and anything long become ":id".
export function sanitizePath(url: string): string {
  let pathname = "";
  try {
    pathname = new URL(url, "https://report.invalid").pathname;
  } catch {
    return "?";
  }
  const segments = pathname.split("/").filter(Boolean).slice(0, 8);
  const kept = segments.map((s) => (/^[a-z][a-z-]{0,23}$/.test(s) ? s : ":id"));
  return `/${kept.join("/")}`;
}

// An origin, or one of the keywords browsers use for what isn't a URL.
export function sanitizeBlocked(value: string): string {
  const keyword = value.trim().toLowerCase();
  if (["inline", "eval", "wasm-eval", "self", "data", "blob", "trusted-types-policy", "trusted-types-sink"].includes(keyword)) {
    return keyword;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") return url.origin;
    return url.protocol.replace(/:$/, "");
  } catch {
    return keyword ? "other" : "";
  }
}

function summaryOf(body: Record<string, unknown>): CspReportSummary | null {
  // report-uri: { "csp-report": { "document-uri", "effective-directive" | "violated-directive", "blocked-uri" } }
  // Reporting API: { type: "csp-violation", body: { documentURL, effectiveDirective, blockedURL } }
  const directive =
    text(body["effective-directive"], 60) || text(body.effectiveDirective, 60) || text(body["violated-directive"], 60).split(" ")[0];
  if (!/^[a-z-]{3,40}$/.test(directive)) return null;
  const blocked = sanitizeBlocked(text(body["blocked-uri"], 2000) || text(body.blockedURL, 2000));
  const page = sanitizePath(text(body["document-uri"], 2000) || text(body.documentURL, 2000));
  return { directive, blocked, page };
}

// The report(s) in a request body: null when it isn't one.
export function parseCspReports(raw: string): CspReportSummary[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed.slice(0, 20) : [parsed];
  const out: CspReportSummary[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const inner = record["csp-report"] ?? (record.type === "csp-violation" ? record.body : null);
    if (!inner || typeof inner !== "object") continue;
    const summary = summaryOf(inner as Record<string, unknown>);
    if (summary) out.push(summary);
  }
  return out;
}

// Per server instance: how many lines this minute, and which ones were already logged.
export function createReportLimiter(now: () => number = Date.now) {
  let windowStart = now();
  let count = 0;
  const seen = new Set<string>();
  return (summary: CspReportSummary): boolean => {
    const t = now();
    if (t - windowStart >= WINDOW_MS) {
      windowStart = t;
      count = 0;
      seen.clear();
    }
    const key = `${summary.directive} ${summary.blocked} ${summary.page}`;
    if (seen.has(key) || count >= REPORT_LOG_LIMIT) return false;
    seen.add(key);
    count += 1;
    return true;
  };
}
