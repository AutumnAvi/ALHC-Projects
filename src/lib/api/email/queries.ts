// Big move 1: the email area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "@/lib/api/core/context";
import type { EmailSuppression, WorkspaceEmailDelivery, WorkspaceEmailSummary } from "@/lib/api/email/model";
import { isDeliveryEvent } from "@/lib/email-schedules";

// Admin console → Email: the latest emails of every kind (workspace admins; null for anyone else or on a
// database without the migration).
export const listWorkspaceEmailDeliveries = read(async (ctx: ApiContext, limit = 100): Promise<WorkspaceEmailDelivery[] | null> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("list_workspace_email_deliveries", { max_results: limit });
  if (result.error) return null;
  return (result.data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    recipient: r.recipient,
    inWorkspace: r.in_workspace,
    status: r.status,
    deliveryStatus: isDeliveryEvent(r.delivery_status) ? r.delivery_status : null,
    deliveryDetail: r.delivery_detail,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    deliveryEventAt: r.delivery_event_at,
    suppressed: r.suppressed,
  }));
});

export const workspaceEmailSummary = read(async (ctx: ApiContext, days = 30): Promise<WorkspaceEmailSummary | null> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("workspace_email_summary", { window_days: days });
  const r = result.error ? null : result.data?.[0];
  if (!r) return null;
  return {
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    delayed: Number(r.delayed),
    bounced: Number(r.bounced),
    complained: Number(r.complained),
    failed: Number(r.failed),
    waiting: Number(r.waiting),
    suppressedAddresses: Number(r.suppressed_addresses),
  };
});

// The active suppression list (workspace admins only, through list_email_suppressions: addresses outside
// the workspace masked). Null for anyone else or on a database without the migration.
export const listEmailSuppressions = read(async (ctx: ApiContext): Promise<EmailSuppression[] | null> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("list_email_suppressions");
  if (result.error) return null;
  return (result.data ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    inWorkspace: r.in_workspace,
    reason: r.reason,
    detail: r.detail,
    emailKind: r.email_kind,
    createdAt: r.created_at,
  }));
});
