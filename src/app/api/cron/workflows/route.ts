import { timingSafeEqual } from "node:crypto";
import { drainOutbox } from "@/lib/email";
import { drainIntegrationOutbox } from "@/lib/integrations";
import { createAdminClient } from "@/lib/supabase/admin";

// Scheduler entry point (Vercel Cron, or any external scheduler sending
// `Authorization: Bearer $CRON_SECRET`). Runs due delayed rule actions and due-date rules, then
// delivers queued email, Slack messages, and outbound webhooks. pg_cron can run workflow_tick() inside
// the database on its own, but only the app makes HTTP calls (Resend, Slack, webhooks), so this route
// is what drains the outboxes when nobody is using the app.
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
  const email = await drainOutbox({ max: 50 });
  const integrations = await drainIntegrationOutbox({ max: 50 });
  return Response.json({ tick: tick.data, email, integrations });
}
