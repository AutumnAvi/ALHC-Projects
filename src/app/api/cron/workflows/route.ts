import { timingSafeEqual } from "node:crypto";
import { drainOutbox } from "@/lib/email";
import { removeStaleFormUploads } from "@/lib/form-uploads";
import { drainIntegrationOutbox } from "@/lib/integrations";
import { createAdminClient } from "@/lib/supabase/admin";

// Scheduler entry point (Vercel Cron, or any external scheduler sending
// `Authorization: Bearer $CRON_SECRET`). Runs due delayed rule actions and due-date rules, then
// delivers queued email, Slack messages, and outbound webhooks. pg_cron can run workflow_tick() inside
// the database on its own, but only the app makes HTTP calls (Resend, Slack, webhooks), so this route
// is what drains the outboxes when nobody is using the app. It also removes public form uploads that no
// response kept, a day after they were uploaded, and queues due Inbox digests and scheduled reports.
function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  if (!admin) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });

  const tick = await admin.rpc("workflow_tick");
  if (tick.error) return Response.json({ error: tick.error.message }, { status: 500 });
  // Due Inbox digests and scheduled reports (Real features 3). pg_cron queues them every 5 minutes on
  // the hosted database; this covers databases without pg_cron. A database without the migration
  // doesn't have the function (PGRST202 → nothing to queue).
  // A failure here never holds up delivery of what's already queued.
  const queued = await admin.rpc("alhc_queue_scheduled_emails");
  if (queued.error && queued.error.code !== "PGRST202") console.error("Queueing digests and reports failed", queued.error.code);
  const email = await drainOutbox({ max: 50 });
  const integrations = await drainIntegrationOutbox({ max: 50 });
  const formUploads = await removeStaleFormUploads(admin);
  return Response.json({ tick: tick.data, scheduled: queued.data ?? null, email, integrations, formUploads });
}
