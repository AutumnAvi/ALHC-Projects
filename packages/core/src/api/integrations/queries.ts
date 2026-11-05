// Big move 1: the integrations area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "../core/context";
import { maybe, rows } from "../core/db";
import { getProjectRole } from "../projects/queries";
import { deliveryStatuses } from "../task-pane/queries";
import { type InboundCall, type InboundEndpoint, isInboundCallStatus } from "../../inbound-shared";
import {
  type EmailDelivery,
  type IntegrationDelivery,
  isDeliveryStatus,
  type ProjectIntegrations,
  toProjectIntegrations,
} from "../../integrations-shared";
import { hasRole } from "../../roles";

// Redacted Slack / webhook defaults (hosts + last 4 characters, never the URL or secret). Admin+ only:
// below Admin the RPC refuses, so this returns null without asking.
export const getProjectIntegrations = read(async (ctx: ApiContext, projectId: string): Promise<ProjectIntegrations | null> => {
  if (!hasRole(await getProjectRole(ctx, projectId), "admin")) return null;
  const supabase = ctx.db;
  const result = await supabase.rpc("get_project_integrations", { target_project: projectId });
  return toProjectIntegrations(maybe(result, "integration settings"));
});

// Delivery log for Settings → Deliveries (Admin+; the RPC refuses anyone else, so this returns null
// without asking). Hints, statuses, and times only — never a URL, secret, or signature.
export const listIntegrationDeliveries = read(async (ctx: ApiContext, projectId: string): Promise<IntegrationDelivery[] | null> => {
  if (!hasRole(await getProjectRole(ctx, projectId), "admin")) return null;
  const supabase = ctx.db;
  const result = await supabase.rpc("list_integration_deliveries", { target_project: projectId, max_results: 200 });
  return rows(result, "delivery log").map((row) => ({
    id: row.id,
    channel: row.channel === "slack" ? "slack" : "webhook",
    taskId: row.task_id,
    taskTitle: row.task_title,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    targetHint: row.target_hint,
    status: isDeliveryStatus(row.status) ? row.status : "pending",
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    responseStatus: row.response_status,
    lastError: row.last_error,
    signed: row.signed,
    nextAttemptAt: row.next_attempt_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
});

// Emails about the project's tasks for Settings → Deliveries (Admin+; null below Admin). Never a body.
export const listEmailDeliveries = read(async (ctx: ApiContext, projectId: string): Promise<EmailDelivery[] | null> => {
  if (!hasRole(await getProjectRole(ctx, projectId), "admin")) return null;
  const supabase = ctx.db;
  const result = await supabase.rpc("list_email_deliveries", { target_project: projectId, max_results: 200 });
  const emails = rows(result, "email log");
  const delivery = await deliveryStatuses(ctx, emails.map((row) => row.id));
  return emails.map((row) => ({
    id: row.id,
    kind: row.kind,
    recipient: row.recipient,
    taskId: row.task_id,
    taskTitle: row.task_title,
    ruleName: row.rule_name,
    status: isDeliveryStatus(row.status) && row.status !== "cancelled" ? row.status : "pending",
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveryStatus: delivery.get(row.id) ?? null,
  }));
});

// Inbound webhook endpoints of a project (Admin+; RLS returns nothing to anyone else). The token hash
// and signing secret columns aren't readable by clients at all — only the hint and whether one is set.
export const listInboundEndpoints = read(async (ctx: ApiContext, projectId: string): Promise<InboundEndpoint[] | null> => {
  if (!hasRole(await getProjectRole(ctx, projectId), "admin")) return null;
  const supabase = ctx.db;
  const [endpoints, calls] = await Promise.all([
    supabase
      .from("inbound_endpoints")
      .select(
        "id, project_id, name, section_id, assignee_id, tag_ids, enabled, token_hint, token_rotated_at, signing_secret_set_at, created_by, created_at",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("created_at"),
    supabase
      .from("inbound_calls")
      .select("endpoint_id, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);
  const lastCall = new Map<string, string>();
  for (const call of rows(calls, "inbound calls")) {
    if (!lastCall.has(call.endpoint_id)) lastCall.set(call.endpoint_id, call.created_at);
  }
  return rows(endpoints, "inbound endpoints").map((row) => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    sectionId: row.section_id,
    assigneeId: row.assignee_id,
    tagIds: row.tag_ids ?? [],
    enabled: row.enabled,
    tokenHint: row.token_hint,
    tokenRotatedAt: row.token_rotated_at,
    signed: row.signing_secret_set_at !== null,
    signingSecretSetAt: row.signing_secret_set_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastCallAt: lastCall.get(row.id) ?? null,
  }));
});

// The latest calls to the project's inbound endpoints (Admin+): status, HTTP status, the created task
// (its title only when the viewer can read it), error, and warnings — never a body, token, or signature.
export const listInboundCalls = read(async (ctx: ApiContext, projectId: string): Promise<InboundCall[] | null> => {
  if (!hasRole(await getProjectRole(ctx, projectId), "admin")) return null;
  const supabase = ctx.db;
  const calls = rows(
    await supabase
      .from("inbound_calls")
      .select("id, endpoint_id, status, http_status, task_id, error, warnings, idempotency_key, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(100),
    "inbound calls",
  );
  const taskIds = [...new Set(calls.flatMap((c) => (c.task_id ? [c.task_id] : [])))];
  const titles = new Map<string, string>();
  if (taskIds.length) {
    const tasks = rows(
      await supabase.from("tasks").select("id, title").in("id", taskIds).is("deleted_at", null),
      "inbound tasks",
    );
    for (const t of tasks) titles.set(t.id, t.title);
  }
  return calls.map((row) => ({
    id: row.id,
    endpointId: row.endpoint_id,
    status: isInboundCallStatus(row.status) ? row.status : "failed",
    httpStatus: row.http_status,
    taskId: row.task_id,
    taskTitle: row.task_id ? (titles.get(row.task_id) ?? null) : null,
    error: row.error,
    warnings: Array.isArray(row.warnings) ? row.warnings.filter((w): w is string => typeof w === "string") : [],
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  }));
});
