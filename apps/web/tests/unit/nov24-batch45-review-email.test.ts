// Nov 24 batch 45 (item 5): the outside review email's send path — short retries inside one budget, one
// Idempotency-Key per logical send, Resend's id back, a plain reason (no address) when it fails, every
// outcome recorded on the round, and the parallel order's review sent with the team round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  backoffMs,
  failureReason,
  isRetryable,
  parseRetryAfter,
  retryDecision,
  safeEmailError,
  sendKey,
  sendThroughResend,
  type SendFailure,
} from "@/lib/email-send";

const http = (status: number, extra: Partial<SendFailure> = {}): SendFailure => ({
  status,
  kind: "http",
  retryAfterMs: null,
  name: null,
  message: null,
  ...extra,
});
const noAnswer = (kind: "timeout" | "network"): SendFailure => ({ status: null, kind, retryAfterMs: null, name: null, message: null });

test("retryable: no answer, timeouts, 429, 5xx, and a key still in flight; never a refusal", () => {
  assert.equal(isRetryable(noAnswer("network")), true);
  assert.equal(isRetryable(noAnswer("timeout")), true);
  assert.equal(isRetryable(http(429)), true);
  assert.equal(isRetryable(http(500)), true);
  assert.equal(isRetryable(http(503)), true);
  assert.equal(isRetryable(http(409, { name: "concurrent_idempotent_requests" })), true);
  for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(isRetryable(http(status)), false, String(status));
});

test("retry decision: backoff, Retry-After (capped), the try limit, and the budget", () => {
  assert.deepEqual(retryDecision({ failure: http(500), attempt: 1, elapsedMs: 200 }), { retry: true, waitMs: backoffMs(1) });
  assert.equal(backoffMs(1), 400);
  assert.equal(backoffMs(2), 1200);
  // Retry-After wins when longer than the backoff, up to the cap.
  assert.deepEqual(retryDecision({ failure: http(429, { retryAfterMs: 1500 }), attempt: 1, elapsedMs: 100 }), { retry: true, waitMs: 1500 });
  assert.deepEqual(retryDecision({ failure: http(429, { retryAfterMs: 30_000 }), attempt: 1, elapsedMs: 100 }), { retry: false });
  assert.deepEqual(retryDecision({ failure: http(422), attempt: 1, elapsedMs: 100 }), { retry: false });
  assert.deepEqual(retryDecision({ failure: http(503), attempt: 3, elapsedMs: 100 }), { retry: false });
  // The wait plus a second for the next try must fit the budget.
  assert.deepEqual(retryDecision({ failure: noAnswer("timeout"), attempt: 1, elapsedMs: 5000, budgetMs: 6000 }), { retry: false });
  assert.deepEqual(retryDecision({ failure: noAnswer("timeout"), attempt: 1, elapsedMs: 4000, budgetMs: 6000 }), { retry: true, waitMs: 400 });
});

test("Retry-After: seconds or an HTTP date", () => {
  const now = Date.parse("2026-11-24T10:00:00Z");
  assert.equal(parseRetryAfter("2", now), 2000);
  assert.equal(parseRetryAfter("0.5", now), 500);
  assert.equal(parseRetryAfter(new Date(now + 3000).toUTCString(), now), 3000);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter("soon", now), null);
});

test("errors never carry an address", () => {
  assert.equal(safeEmailError("The to address sarah.k@glenoaks-al.com is invalid"), "The to address [address] is invalid");
  const reason = failureReason(http(422, { message: safeEmailError("Invalid `from` field: Ops <ops@example.com>") }));
  assert.match(reason, /^Resend refused the email \(422\)/);
  assert.doesNotMatch(reason, /@/);
  assert.equal(failureReason(noAnswer("timeout")), "Resend didn’t answer in time");
  assert.equal(failureReason(noAnswer("network")), "Couldn’t reach Resend");
  assert.match(failureReason(http(429)), /limiting/);
});

test("one key per link: the same on every try, new for a new link, never the token", () => {
  const a = sendKey("review", "r1", "alhc_rev_aaa");
  assert.equal(a, sendKey("review", "r1", "alhc_rev_aaa"));
  assert.notEqual(a, sendKey("review", "r1", "alhc_rev_bbb"));
  assert.ok(!a.includes("alhc_rev_aaa"));
  assert.match(a, /^review-r1-[0-9a-f]{20}$/);
});

const message = { from: "Team <no-reply@example.com>", to: "sarah@example.org", subject: "Please review", text: "t", html: "<p>t</p>" };

function fakeClock() {
  let at = 0;
  const waits: number[] = [];
  return {
    now: () => at,
    sleep: async (ms: number) => {
      waits.push(ms);
      at += ms;
    },
    advance: (ms: number) => {
      at += ms;
    },
    waits,
  };
}

function scripted(answers: Array<Response | Error>, clock?: { advance: (ms: number) => void }, costMs = 100) {
  const calls: { key: string | null; body: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ key: headers.get("Idempotency-Key"), body: String(init.body) });
    clock?.advance(costMs);
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("429 then 200: sent once, both tries with the same Idempotency-Key, Resend's id back", async () => {
  const clock = fakeClock();
  const { fetchImpl, calls } = scripted([json(429, { name: "rate_limit_exceeded" }, { "retry-after": "1" }), json(200, { id: "re_123" })], clock);
  const result = await sendThroughResend(message, { apiKey: "k", idempotencyKey: "review-r1-abc", fetchImpl, now: clock.now, sleep: clock.sleep });
  assert.deepEqual(result, { outcome: "sent", id: "re_123", attempts: 2 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.key), ["review-r1-abc", "review-r1-abc"]);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(clock.waits, [1000]);
});

test("422 is not retried, and says why without the address", async () => {
  const clock = fakeClock();
  const { fetchImpl, calls } = scripted([json(422, { name: "validation_error", message: "The sarah@example.org address is not allowed" })], clock);
  const result = await sendThroughResend(message, { apiKey: "k", idempotencyKey: "x", fetchImpl, now: clock.now, sleep: clock.sleep });
  assert.equal(calls.length, 1);
  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.equal(result.status, 422);
    assert.doesNotMatch(result.reason, /@/);
  }
});

test("a timeout is retried", async () => {
  const clock = fakeClock();
  const timeout = new DOMException("The operation timed out.", "TimeoutError");
  const { fetchImpl, calls } = scripted([timeout, json(200, { id: "re_9" })], clock);
  const result = await sendThroughResend(message, { apiKey: "k", idempotencyKey: "x", fetchImpl, now: clock.now, sleep: clock.sleep });
  assert.deepEqual(result, { outcome: "sent", id: "re_9", attempts: 2 });
  assert.equal(calls.length, 2);
});

test("the budget and the try limit are respected", async () => {
  // Every try fails slowly: the budget stops it before the third try.
  const clock = fakeClock();
  const { fetchImpl, calls } = scripted([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")], clock, 2500);
  const result = await sendThroughResend(message, { apiKey: "k", idempotencyKey: "x", fetchImpl, now: clock.now, sleep: clock.sleep, budgetMs: 7000 });
  assert.equal(result.outcome, "failed");
  assert.ok(calls.length <= 2, `tries: ${calls.length}`);
  assert.ok(clock.now() <= 7000 + 2500, `elapsed ${clock.now()}`);
  if (result.outcome === "failed") assert.equal(result.reason, "Couldn’t reach Resend");
  // Fast failures: never more than three tries.
  const fast = fakeClock();
  const many = scripted([json(503, {}), json(503, {}), json(503, {}), json(503, {})], fast, 10);
  const capped = await sendThroughResend(message, { apiKey: "k", idempotencyKey: "x", fetchImpl: many.fetchImpl, now: fast.now, sleep: fast.sleep });
  assert.equal(many.calls.length, 3);
  assert.equal(capped.attempts, 3);
});

test("every send path goes through one helper that records the outcome on the round", () => {
  const send = readFileSync("src/lib/review-send.ts", "utf8");
  assert.match(send, /recordReviewEmail/);
  for (const outcome of ['"sent"', '"failed"', '"mocked"', '"suppressed"']) assert.ok(send.includes(`emailStatus: ${outcome}`), outcome);
  assert.match(send, /sendKey\("review", review\.reviewId, review\.token\)/);
  assert.match(send, /THUMBNAIL_WAIT_MS/);
  const actions = readFileSync("src/lib/actions/reviews.ts", "utf8");
  assert.match(actions, /createAndDeliverReview/);
  assert.match(actions, /deliverReviewRound\(ctx, await reviewsApi\.rotateReviewCheck/);
  assert.match(actions, /export async function copyReviewLink/);
  assert.doesNotMatch(actions, /sendEmailNow/);
  const approvals = readFileSync("src/lib/actions/approvals.ts", "utf8");
  assert.match(approvals, /sendParallelReview\(ctx/);
  const nudges = readFileSync("src/lib/review-nudges.ts", "utf8");
  assert.match(nudges, /sendKey\("review-nudge", nudge\.review_id, nudge\.token\)/);
});
