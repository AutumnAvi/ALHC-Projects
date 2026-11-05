// Big move 1: what the public, token-checked calls answer (src/lib/api/public/mutations.ts): calendar
// subscribe links, one-click "Turn off" links, inbound webhooks. Types only; safe anywhere.
import type { FeedEvent } from "@/lib/ical";

// calendar_feed(): unknown (malformed, never made, or replaced) | off (turned off, or the owner left the
// workspace) | rate_limited (more than 60 fetches in an hour) | ok, with the events read as the owner.
export type CalendarFeedResult = {
  ok?: boolean;
  status?: string;
  name?: string;
  events?: FeedEvent[];
};

// What an inbound webhook call sends receive_inbound_webhook(): the raw body exactly as it was signed,
// and the X-ALHC-Timestamp / X-ALHC-Signature / Idempotency-Key headers.
export type InboundWebhookRequest = {
  token: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  idempotencyKey: string | null;
};

// receive_inbound_webhook()'s answer: the HTTP status to send and, when a task was made (or already had
// been, for that Idempotency-Key), its id, number, and warnings about references that didn't match.
export type InboundWebhookAnswer = {
  ok?: boolean;
  status?: number;
  error?: string;
  task_id?: string;
  duplicate?: boolean;
  request_label?: string | null;
  warnings?: string[];
};
