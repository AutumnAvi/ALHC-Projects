import "server-only";
import { createHash } from "node:crypto";

// Nov 24 batch 45 (item 5): the one way an email that can't wait in the outbox (a review check's link, its
// reminder) goes to Resend. It was a single try with a 15-second timeout and no idempotency key, so a rate
// limit (429), a Resend hiccup (5xx), or a slow network lost the email — and a slow answer could outlast the
// Server Action that sent it. Now: a few short tries inside one time budget, the same Idempotency-Key on
// every try of one logical send (so a retry never sends twice; a new link is a new key), Resend's id
// returned for delivery tracking, and a plain reason (never an address or a body) when it doesn't go out.

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

// One interactive send (a Server Action is waiting): every try together stays inside this.
export const SEND_BUDGET_MS = 7000;
export const ATTEMPT_TIMEOUT_MS = 5000;
export const MAX_ATTEMPTS = 3;
// The longest we wait on a 429's Retry-After before trying again (longer = give up and say why).
export const RETRY_AFTER_CAP_MS = 2000;

export type SendFailure = {
  // The HTTP status, or null when there was no answer (network error, timeout).
  status: number | null;
  kind: "http" | "timeout" | "network";
  retryAfterMs: number | null;
  // Resend's error name ("rate_limit_exceeded", "concurrent_idempotent_requests", "validation_error", …).
  name: string | null;
  message: string | null;
};

// Transient: no answer, a timeout, a rate limit, Resend's own trouble, or the same key still in flight.
export function isRetryable(failure: SendFailure): boolean {
  if (failure.kind !== "http") return true;
  const status = failure.status ?? 0;
  if (status === 429 || status >= 500) return true;
  return status === 409 && failure.name === "concurrent_idempotent_requests";
}

// Retry-After: seconds, or an HTTP date. Null when absent or unreadable.
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

// 400 ms, then 1.2 s (attempt = the try that just failed, from 1).
export function backoffMs(attempt: number): number {
  return 400 * 3 ** Math.max(0, attempt - 1);
}

// Try again? And after how long. Never past the budget (the wait plus a useful try must fit), never past
// the try limit, never for a refusal that won't change (422 validation, 401 key, 403, 400…).
export function retryDecision(input: {
  failure: SendFailure;
  attempt: number;
  elapsedMs: number;
  budgetMs?: number;
  maxAttempts?: number;
}): { retry: false } | { retry: true; waitMs: number } {
  const budget = input.budgetMs ?? SEND_BUDGET_MS;
  const max = input.maxAttempts ?? MAX_ATTEMPTS;
  if (!isRetryable(input.failure) || input.attempt >= max) return { retry: false };
  const after = input.failure.retryAfterMs;
  if (after !== null && after > RETRY_AFTER_CAP_MS) return { retry: false };
  const waitMs = Math.max(backoffMs(input.attempt), after ?? 0);
  // Leave at least a second for the next try itself.
  if (input.elapsedMs + waitMs + 1000 > budget) return { retry: false };
  return { retry: true, waitMs };
}

// An error text safe to store and show: no email addresses, one line, short.
export function safeEmailError(text: string): string {
  return text
    .replace(/[^\s@<>"',;]+@[^\s@<>"',;]+/g, "[address]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// The reason people read when it didn't go out.
export function failureReason(failure: SendFailure): string {
  if (failure.kind === "timeout") return "Resend didn’t answer in time";
  if (failure.kind === "network") return "Couldn’t reach Resend";
  const status = failure.status ?? 0;
  if (status === 429) return "Resend is limiting how fast emails go out right now";
  if (status === 401 || status === 403) return `Resend refused the API key (${status})`;
  if (status >= 500) return `Resend had a problem (${status})`;
  const detail = failure.message ? `: ${failure.message}` : "";
  return safeEmailError(`Resend refused the email (${status})${detail}`);
}

// The key of one logical send: the same on every try of it, different for a new link (a new token), so
// Resend drops a duplicate try but a new "Send again" always goes out. Never the token itself.
export function sendKey(prefix: string, id: string, token: string): string {
  return `${prefix}-${id}-${createHash("sha256").update(token).digest("hex").slice(0, 20)}`;
}

export type ResendMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type SendResult =
  | { outcome: "sent"; id: string | null; attempts: number }
  | { outcome: "failed"; reason: string; status: number | null; attempts: number };

type SendOptions = {
  apiKey: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
  budgetMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function attempt(message: ResendMessage, options: SendOptions, timeoutMs: number): Promise<{ ok: true; id: string | null } | { ok: false; failure: SendFailure }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  try {
    const response = await fetchImpl(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey,
      },
      body: JSON.stringify({ from: message.from, to: [message.to], subject: message.subject.slice(0, 300), text: message.text, html: message.html }),
      signal: AbortSignal.timeout(Math.max(250, timeoutMs)),
      cache: "no-store",
    });
    const body = (await response.json().catch(() => ({}))) as { id?: unknown; name?: unknown; message?: unknown };
    if (response.ok) return { ok: true, id: typeof body.id === "string" && /^[\w-]{1,100}$/.test(body.id) ? body.id : null };
    return {
      ok: false,
      failure: {
        status: response.status,
        kind: "http",
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()),
        name: typeof body.name === "string" ? body.name : null,
        message: typeof body.message === "string" ? safeEmailError(body.message) : null,
      },
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      ok: false,
      failure: { status: null, kind: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", retryAfterMs: null, name: null, message: null },
    };
  }
}

// Send one email through Resend: up to MAX_ATTEMPTS short tries inside the budget.
export async function sendThroughResend(message: ResendMessage, options: SendOptions): Promise<SendResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const budget = options.budgetMs ?? SEND_BUDGET_MS;
  const started = now();
  for (let n = 1; ; n += 1) {
    const remaining = budget - (now() - started);
    const result = await attempt(message, options, Math.min(options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS, remaining));
    if (result.ok) return { outcome: "sent", id: result.id, attempts: n };
    const decision = retryDecision({ failure: result.failure, attempt: n, elapsedMs: now() - started, budgetMs: budget, maxAttempts: options.maxAttempts });
    if (!decision.retry) {
      return { outcome: "failed", reason: failureReason(result.failure), status: result.failure.status, attempts: n };
    }
    await sleep(decision.waitMs);
  }
}
