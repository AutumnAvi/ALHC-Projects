// Inbound webhooks (see the inbound integrations migration): shared between the route handler, Server
// Actions, and the settings UI. The database (receive_inbound_webhook) is the trust boundary; these
// constants only mirror it.

export const INBOUND_TOKEN_PATTERN = /^alhc_in_[0-9a-f]{64}$/;
export const INBOUND_MAX_BODY_BYTES = 65536;
export const INBOUND_RATE_PER_MINUTE = 60;
export const INBOUND_TIMESTAMP_TOLERANCE_SECONDS = 300;
export const INBOUND_PAYLOAD_KEYS = ["title", "notes", "due_on", "assignee_email", "tags", "fields"] as const;

export const INBOUND_CALL_STATUSES = ["created", "duplicate", "rejected", "invalid", "rate_limited", "failed"] as const;
export type InboundCallStatus = (typeof INBOUND_CALL_STATUSES)[number];

export const INBOUND_CALL_STATUS_LABELS: Record<InboundCallStatus, string> = {
  created: "Created",
  duplicate: "Duplicate",
  rejected: "Rejected",
  invalid: "Invalid",
  rate_limited: "Rate limited",
  failed: "Failed",
};

export function isInboundCallStatus(value: unknown): value is InboundCallStatus {
  return INBOUND_CALL_STATUSES.includes(value as InboundCallStatus);
}

export type InboundEndpoint = {
  id: string;
  projectId: string;
  name: string;
  sectionId: string | null;
  assigneeId: string | null;
  tagIds: string[];
  enabled: boolean;
  tokenHint: string;
  tokenRotatedAt: string;
  signed: boolean;
  signingSecretSetAt: string | null;
  createdBy: string;
  createdAt: string;
  lastCallAt: string | null;
};

export type InboundCall = {
  id: string;
  endpointId: string;
  status: InboundCallStatus;
  httpStatus: number;
  taskId: string | null;
  taskTitle: string | null;
  error: string | null;
  warnings: string[];
  idempotencyKey: string | null;
  createdAt: string;
};

// What a create / rotate returns once. Nothing can show these again.
export type RevealedInboundCredentials = {
  endpointId: string;
  token?: string;
  signingSecret?: string;
};

export function inboundUrl(origin: string | null, token: string) {
  return `${origin ?? ""}/api/inbound/${token}`;
}

// The example the settings page shows (curl with an unsigned request).
export function inboundCurlExample(url: string) {
  return [
    `curl -X POST '${url}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Idempotency-Key: order-1042' \\`,
    `  -d '{"title": "New flyer request", "notes": "From the website", "due_on": "2026-11-02",`,
    `       "assignee_email": "someone@example.com", "tags": ["Web"], "fields": {"Priority": "High"}}'`,
  ].join("\n");
}
