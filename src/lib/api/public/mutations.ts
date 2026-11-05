// Big move 1: the public, token-checked calls — no sign-in, the token in the link or URL is the whole
// credential. Each is one SECURITY DEFINER function anon may execute, which checks the token's hash and
// does exactly one thing. The caller hands in a cookie-less anon context (never the service role, never a
// visitor's session); the routes log only an error's code (error.detail?.code), never the token.
import type { ApiContext } from "@/lib/api/core/context";
import { check } from "@/lib/api/core/db";
import type { CalendarFeedResult, InboundWebhookAnswer, InboundWebhookRequest } from "@/lib/api/public/model";
import type { UnsubscribeWhat } from "@/lib/email-schedules";

// A calendar subscribe link's events (Real features 4): calendar_feed() looks up the token's hash, counts
// the fetch (60 an hour), and builds the events with the link owner's own access at this very fetch.
export async function calendarFeed(ctx: ApiContext, token: string): Promise<CalendarFeedResult> {
  const result = await ctx.db.rpc("calendar_feed", { feed_token: token });
  check(result);
  return (result.data ?? {}) as CalendarFeedResult;
}

// A one-click "Turn off" link (Real features 3): email_unsubscribe() turns off that one switch (the
// digest, or report emails) and says nothing about whose token it is. Answers off | already_off | unknown.
export async function emailUnsubscribe(ctx: ApiContext, token: string, what: UnsubscribeWhat): Promise<string> {
  const result = await ctx.db.rpc("email_unsubscribe", { unsubscribe_token: token, what });
  check(result);
  return (result.data as { status?: string } | null)?.status ?? "unknown";
}

// An inbound webhook call (Inbound integrations): receive_inbound_webhook() checks the hashed token, the
// optional signature, size, rate limit, and Idempotency-Key, then writes the task as the endpoint's creator.
export async function receiveInboundWebhook(ctx: ApiContext, request: InboundWebhookRequest): Promise<InboundWebhookAnswer> {
  const result = await ctx.db.rpc("receive_inbound_webhook", {
    endpoint_token: request.token,
    raw_body: request.body,
    request_timestamp: request.timestamp,
    request_signature: request.signature,
    idempotency_key: request.idempotencyKey,
  });
  check(result);
  return (result.data ?? {}) as InboundWebhookAnswer;
}
